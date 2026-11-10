/** Incremental parser for transcript_full.jsonl (pure; no fs). */

import type { Snapshot } from '../model';
import { extractTarget, type CompactStep } from './items';
import { detectCompaction, detectModelChanges, lastCheckpointStep } from './compaction';

export interface KeptStep extends CompactStep {
  /** First ~200 chars of a user request (for title fallback). */
  prompt?: string;
}

export interface TranscriptSummary {
  used: number | null;
  totals: { input: number; cacheRead: number; output: number; calls: number };
  lastStepIndex: number | null;
  firstPrompt: string | null;
  lastActivity: string | null;
  compaction: Snapshot['compaction'];
  modelChanges: Snapshot['modelChanges'];
  /** Step index of the last Compaction CHECKPOINT, else null. */
  lastCheckpoint: number | null;
}

const CHECKPOINT_PREFIX = '# Resuming from a compaction';
const MODEL_CHANGE = /changed setting Model Selection from ([^\n<]+?) to ([^\n<]+)/;
const USER_REQUEST = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/;

export function extractUserRequest(content: string): string {
  const m = USER_REQUEST.exec(content);
  return (m ? m[1]! : content).trim();
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function parseLine(line: string): KeptStep | null {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const index = num(r.step_index);
  if (index === null) return null;
  const source = typeof r.source === 'string' ? r.source : '';
  const type = typeof r.type === 'string' ? r.type : '';
  const status = typeof r.status === 'string' ? r.status : undefined;
  const hasError = status === 'ERROR' || Boolean(r.error);
  const contentStr = typeof r.content === 'string' ? r.content : '';
  const contentLength = contentStr.length;

  const step: KeptStep = {
    index,
    source,
    type,
    status,
    hasError,
    contentLength,
  };

  if (typeof r.created_at === 'string') step.createdAt = r.created_at;

  if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
    const input = num(r.input_tokens);
    const cacheRead = num(r.cache_read_tokens);
    const output = num(r.output_tokens);
    if (input !== null && cacheRead !== null) {
      step.tokens = { input, cacheRead, output: output ?? 0 };
    }

    if (Array.isArray(r.tool_calls)) {
      step.toolCalls = r.tool_calls.map((tc) => {
        const item = (tc && typeof tc === 'object') ? tc as { name?: unknown; args?: Record<string, unknown> } : {};
        const name = typeof item.name === 'string' ? item.name : 'tool';
        const target = extractTarget(item.args);
        const callChars = JSON.stringify(tc).length;
        return { name, target, callChars };
      });
    }
  }

  if (type === 'CHECKPOINT' && source === 'SYSTEM' && contentStr.startsWith(CHECKPOINT_PREFIX)) {
    step.compaction = true;
  }

  if (type === 'USER_INPUT' && contentStr) {
    const mc = MODEL_CHANGE.exec(contentStr);
    if (mc) step.modelChange = { from: mc[1]!.trim(), to: mc[2]!.trim() };
    // Only the request text counts as context text (labels/sizes only are kept, never the text).
    const req = extractUserRequest(contentStr);
    step.contentLength = req.length;
    step.prompt = req.slice(0, 200);
    if (/^\/compact(\s|$)/.test(req)) step.compactCommand = true;
    step.promptPreview = req.replace(/\s+/g, ' ').slice(0, 40) + (req.length > 40 ? '…' : '');
  }

  return step;
}

interface Entry {
  step: KeptStep;
  pos?: { start: number; length: number };
  /** Entry number this one continues from, or -1 (first step / nothing lower seen yet). */
  pred: number;
}

/**
 * Incremental transcript parser. Several runs can write into one transcript (a leftover server
 * after a forced close, spec 13), so step indices alone repeat and go backwards. The kept steps are
 * a chain traced back from the LAST line: each entry continues from the latest EARLIER line whose
 * index is exactly one less (else the closest lower index, so gaps never cut history). A genuine
 * rewind (an edited message) links back to the original earlier steps, so it still wins.
 */
export class TranscriptParser {
  /** Bytes consumed so far (never past an unterminated last line). */
  offset = 0;
  private entries: Entry[] = [];
  /** Latest entry number seen so far for each step index. */
  private lastAt = new Map<number, number>();
  private chain: { kept: KeptStep[]; lines: Map<number, { start: number; length: number }> } | null = null;

  reset(): void {
    this.offset = 0;
    this.entries = [];
    this.lastAt.clear();
    this.chain = null;
  }

  /** Kept steps in index order: the chain ending at the last line. */
  get kept(): KeptStep[] {
    return this.trace().kept;
  }

  /** Byte position of each kept step's line (absolute file offsets), so hover reads only those bytes. */
  get lines(): Map<number, { start: number; length: number }> {
    return this.trace().lines;
  }

  /** Feed bytes read from `this.offset`. Returns bytes consumed (up to the last newline). */
  ingest(buf: Uint8Array): number {
    const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const lastNl = b.lastIndexOf(0x0a);
    if (lastNl < 0) return 0;
    let pos = 0;
    while (pos <= lastNl) {
      let end = b.indexOf(0x0a, pos);
      if (end < 0 || end > lastNl) end = lastNl;
      const line = b.subarray(pos, end).toString('utf8');
      if (line.trim() !== '') {
        const step = parseLine(line);
        if (step) this.push(step, { start: this.offset + pos, length: end - pos });
      }
      pos = end + 1;
    }
    this.offset += lastNl + 1;
    return lastNl + 1;
  }

  push(step: KeptStep, pos?: { start: number; length: number }): void {
    let pred = this.lastAt.get(step.index - 1);
    if (pred === undefined) {
      // Gap: continue from the closest lower index seen so far.
      let best = -1;
      for (const k of this.lastAt.keys()) if (k < step.index && k > best) best = k;
      pred = best >= 0 ? this.lastAt.get(best)! : -1;
    }
    const n = this.entries.length;
    this.entries.push({ step, pos, pred });
    this.lastAt.set(step.index, n);
    this.chain = null;
  }

  private trace(): { kept: KeptStep[]; lines: Map<number, { start: number; length: number }> } {
    if (this.chain) return this.chain;
    const picked: Entry[] = [];
    for (let n = this.entries.length - 1; n >= 0; n = this.entries[n]!.pred) picked.push(this.entries[n]!);
    picked.reverse();
    const lines = new Map<number, { start: number; length: number }>();
    for (const e of picked) if (e.pos) lines.set(e.step.index, e.pos);
    this.chain = { kept: picked.map((e) => e.step), lines };
    return this.chain;
  }

  summary(): TranscriptSummary {
    const totals = { input: 0, cacheRead: 0, output: 0, calls: 0 };
    let used: number | null = null;
    let firstPrompt: string | null = null;
    for (const k of this.kept) {
      if (k.tokens) {
        // CHECKPOINT and other non-planner steps never carry tokens here.
        used = k.tokens.input + k.tokens.cacheRead;
        totals.input += k.tokens.input;
        totals.cacheRead += k.tokens.cacheRead;
        totals.output += k.tokens.output;
        totals.calls += 1;
      }
      if (firstPrompt === null && k.prompt) firstPrompt = k.prompt;
    }
    const last = this.kept[this.kept.length - 1];
    return {
      used,
      totals,
      lastStepIndex: last ? last.index : null,
      firstPrompt,
      lastActivity: last?.createdAt ?? null,
      compaction: detectCompaction(this.kept),
      modelChanges: detectModelChanges(this.kept),
      lastCheckpoint: lastCheckpointStep(this.kept),
    };
  }
}
