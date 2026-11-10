import { normaliseModelKey, resolveLimit } from '../../limits';
import type { Group, Snapshot } from '../../model';
import { detectCompaction } from '../compaction';
import { buildBreakdownGroups, type BreakdownGroup } from '../breakdown';
import type { CompactStep } from '../items';
import { RpcError } from './client';

/** Facts extracted from a GetCascadeTrajectoryGeneratorMetadata reply (spec 4.1). */
export interface RpcMeta {
  input: number;
  cacheRead: number;
  output: number;
  /** input + cacheRead of the last call that has usage. */
  used: number;
  modelDisplay: string | null;
  maxContextTokens: number | null;
  estimate: number | null;
  breakdown: BreakdownGroup[];
  startStepIndex: number | null;
  checkpointIndex: number | null;
  truncationReason: string | null;
  totals: { input: number; cacheRead: number; output: number; calls: number };
  modelChanges: { step: number; from: string; to: string }[];
  /** Highest step index any call produced (stale-server guard). null when none reported. */
  lastStepIndex: number | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (msg: string): never => { throw new RpcError('shape', `unexpected reply shape: ${msg}`); };

/** int64 arrives as a decimal string (or a number). Absent => fallback; garbage => shape error. */
function int(v: unknown, what: string, fallback: number | null): number | null {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  return bad(what);
}

function parseBreakdown(tb: unknown): BreakdownGroup[] | null {
  if (!isObj(tb) || !Array.isArray(tb.groups)) return null;
  const out: BreakdownGroup[] = [];
  for (const g of tb.groups) {
    if (!isObj(g) || typeof g.name !== 'string') return bad('breakdown group');
    const children: BreakdownGroup['children'] = [];
    if (g.children !== undefined) {
      if (!Array.isArray(g.children)) return bad('breakdown children');
      for (const c of g.children) {
        if (!isObj(c) || typeof c.name !== 'string') return bad('breakdown child');
        children.push({ name: c.name, tokens: int(c.numTokens, 'child numTokens', 0)! });
      }
    }
    out.push({ name: g.name, tokens: int(g.numTokens, 'group numTokens', 0)!, children });
  }
  return out;
}

/**
 * Gate on shape and reduce the reply to the latest facts + running totals (the rest is discarded).
 * Returns null when the server has no usable call for this Conversation (empty / in-flight only);
 * throws RpcError('shape') on an unexpected structure.
 */
export function parseGeneratorMetadata(reply: unknown): RpcMeta | null {
  if (!isObj(reply)) return bad('not an object');
  const entries = reply.generatorMetadata ?? [];
  if (!Array.isArray(entries)) return bad('generatorMetadata not an array');

  const totals = { input: 0, cacheRead: 0, output: 0, calls: 0 };
  const modelChanges: RpcMeta['modelChanges'] = [];
  let lastStepIndex: number | null = null;
  let prevModel: string | null = null;
  let last: { cm: Obj; usage: Obj; breakdown: BreakdownGroup[] } | null = null;

  for (const e of entries) {
    if (!isObj(e)) return bad('entry');
    if (Array.isArray(e.stepIndices)) {
      for (const s of e.stepIndices) {
        const n = int(s, 'stepIndices', null);
        if (n !== null && (lastStepIndex === null || n > lastStepIndex)) lastStepIndex = n;
      }
    }
    const cm = e.chatModel;
    if (cm === undefined) continue; // not an LLM call
    if (!isObj(cm)) return bad('chatModel');
    const usage = cm.usage;
    if (usage === undefined) continue; // call still in flight
    if (!isObj(usage)) return bad('usage');
    const input = int(usage.inputTokens, 'inputTokens', 0)!;
    const cacheRead = int(usage.cacheReadTokens, 'cacheReadTokens', 0)!;
    const output = int(usage.outputTokens, 'outputTokens', 0)!;
    totals.input += input;
    totals.cacheRead += cacheRead;
    totals.output += output;
    totals.calls += 1;

    const display = typeof cm.modelDisplayName === 'string' ? cm.modelDisplayName
      : typeof cm.responseModel === 'string' ? cm.responseModel : null;
    if (display !== null) {
      if (prevModel !== null && prevModel !== display) {
        const first = Array.isArray(e.stepIndices) ? int(e.stepIndices[0], 'stepIndices', null) : null;
        modelChanges.push({ step: first ?? 0, from: prevModel, to: display });
      }
      prevModel = display;
    }

    const cw = isObj(cm.chatStartMetadata) && isObj(cm.chatStartMetadata.contextWindowMetadata)
      ? cm.chatStartMetadata.contextWindowMetadata : undefined;
    const breakdown = parseBreakdown(cw?.tokenBreakdown);
    if (breakdown) last = { cm, usage, breakdown };
  }

  if (!last) return null;
  const { cm, usage, breakdown } = last;
  const csm = cm.chatStartMetadata as Obj;
  const cw = csm.contextWindowMetadata as Obj;
  const input = int(usage.inputTokens, 'inputTokens', 0)!;
  const cacheRead = int(usage.cacheReadTokens, 'cacheReadTokens', 0)!;
  const display = typeof cm.modelDisplayName === 'string' ? cm.modelDisplayName
    : typeof cm.responseModel === 'string' ? cm.responseModel : null;
  const max = int(cw.maxContextTokens, 'maxContextTokens', null);
  return {
    input,
    cacheRead,
    output: int(usage.outputTokens, 'outputTokens', 0)!,
    used: input + cacheRead,
    modelDisplay: display,
    maxContextTokens: max !== null && max > 0 ? max : null,
    estimate: int(cw.estimatedTokensUsed, 'estimatedTokensUsed', null),
    breakdown,
    startStepIndex: int(csm.startStepIndex, 'startStepIndex', null),
    checkpointIndex: int(csm.checkpointIndex, 'checkpointIndex', null),
    truncationReason: typeof cw.truncationReason === 'string' ? cw.truncationReason : null,
    totals,
    modelChanges,
    lastStepIndex,
  };
}

export interface SnapshotContext {
  conversationId: string;
  title: string;
  /** Transcript steps (labels for Chat Messages, joined by step index). */
  steps: CompactStep[];
  limitOverrides: Record<string, number>;
  limitDefault: number | null;
  /** Remembered limits per model key (spec 5, step 4). */
  remembered?: Record<string, number>;
  heavyPercent: number;
  notSelected: boolean;
  role: Snapshot['role'];
}

/** Reply facts + transcript labels -> Snapshot (source 'rpc'). Groups are Antigravity's own counts. */
export function buildRpcSnapshot(meta: RpcMeta, ctx: SnapshotContext): Snapshot {
  const modelKey = normaliseModelKey(meta.modelDisplay);
  const r = resolveLimit({
    modelKey,
    override: ctx.limitOverrides,
    server: meta.maxContextTokens,
    database: null,
    remembered: ctx.remembered,
    defaultLimit: ctx.limitDefault,
  });
  const limitSource = r.limitSource;
  const groups: Group[] = buildBreakdownGroups(meta.breakdown, ctx.steps, r.limit, ctx.heavyPercent, meta.startStepIndex);
  return {
    conversationId: ctx.conversationId,
    title: ctx.title,
    source: 'rpc',
    used: meta.used,
    limit: r.limit,
    limitSource,
    modelKey,
    modelDisplay: meta.modelDisplay,
    estimate: meta.estimate,
    groups,
    totals: meta.totals,
    compaction: detectCompaction(ctx.steps),
    modelChanges: meta.modelChanges,
    startStepIndex: meta.startStepIndex,
    truncationReason: meta.truncationReason,
    notSelected: ctx.notSelected,
    role: ctx.role,
  };
}

/** Index of the transcript's last planner step (a step carrying token usage). */
export function lastPlannerStep(steps: CompactStep[]): number | null {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i]!.tokens) return steps[i]!.index;
  return null;
}

/**
 * GetTokenBase per-rule/per-skill children, shown under `user_rules`/`skills` ONLY when they sum
 * to the section total (spec 4.1). Live check 2026-11-09: they do not (rules 1560 vs 1861, skills
 * 1470 vs 3072), so the controller does not call GetTokenBase; this guard documents the rule.
 */
export function tokenBaseChildren(
  sectionTokens: number,
  children: { name: string; tokens: number }[],
): { name: string; tokens: number }[] | null {
  const sum = children.reduce((a, c) => a + c.tokens, 0);
  return children.length > 0 && sum === sectionTokens ? children : null;
}
