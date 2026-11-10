import { decodeMessage, getAll } from '../protobuf';
import type { Group, GroupItem } from '../model';
import { buildItems, isHeavy, type CompactStep, type Unit } from './items';

export interface BreakdownGroup {
  name: string;
  tokens: number;
  children: { name: string; tokens: number }[];
}

const str = (b: Uint8Array) => Buffer.from(b).toString('utf8');

/** Decode `.1.9.10.3.1[]` = {1 name, 4 tokens, 5[] {1 name, 3 tokens}}. null when absent. */
export function decodeBreakdown(blob: Uint8Array): BreakdownGroup[] | null {
  const out: BreakdownGroup[] = [];
  for (const g of getAll(blob, [1, 9, 10, 3, 1])) {
    if (!g.bytes) continue;
    const fields = decodeMessage(g.bytes);
    const name = fields.find((f) => f.num === 1 && f.bytes);
    if (!name?.bytes) continue;
    const tokens = Number(fields.find((f) => f.num === 4 && f.wire === 0)?.varint ?? 0n);
    const children: BreakdownGroup['children'] = [];
    for (const c of fields.filter((f) => f.num === 5 && f.bytes)) {
      const cf = decodeMessage(c.bytes!);
      const cn = cf.find((f) => f.num === 1 && f.bytes);
      if (!cn?.bytes) continue;
      children.push({ name: str(cn.bytes), tokens: Number(cf.find((f) => f.num === 3 && f.wire === 0)?.varint ?? 0n) });
    }
    out.push({ name: str(name.bytes), tokens, children });
  }
  return out.length > 0 ? out : null;
}

const STEP_NAME = /^(\d+):\s*([A-Z_]+)/;

/** Parse a Chat Messages child name `"<stepIndex>: <STEP_TYPE>"` into a Unit. */
export function parseStepName(name: string, tokens: number): Unit | null {
  const m = STEP_NAME.exec(name);
  return m ? { step: Number(m[1]), type: m[2]!, tokens } : null;
}

/**
 * Breakdown + transcript labels -> exact Groups. System Prompt / Tools children are the
 * named sections/tools; Chat Messages children are joined to transcript steps by index.
 */
export function buildBreakdownGroups(
  breakdown: BreakdownGroup[],
  steps: CompactStep[],
  limit: number | null,
  heavyPercent: number,
  startStepIndex: number | null = null,
): Group[] {
  return breakdown.map((g): Group => {
    if (g.name === 'Chat Messages') {
      const units = g.children.flatMap((c) => parseStepName(c.name, c.tokens) ?? [])
        .filter((u) => startStepIndex === null || u.step >= startStepIndex);
      const children: GroupItem[] = buildItems(units, steps, { estimated: false }).map((it) => ({
        label: it.label, tokens: it.tokens, step: it.step, kind: it.kind,
        estimated: false, heavy: isHeavy(it.tokens, limit, heavyPercent),
      }));
      return { name: g.name, tokens: g.tokens, children };
    }
    const kind = g.name === 'Tools' ? 'tool' : 'section';
    return {
      name: g.name,
      tokens: g.tokens,
      children: g.children.map((c) => ({ label: c.name, tokens: c.tokens, kind })),
    };
  });
}
