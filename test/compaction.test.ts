import { describe, expect, it } from 'vitest';
import { TranscriptParser } from '../src/sources/transcript';
import { stepsFrom } from '../src/sources/compaction';
import { buildChatItems, computeBaseline } from '../src/sources/items';
import { buildBreakdownGroups } from '../src/sources/breakdown';
import { compactionLines, formatTooltip } from '../src/ui/statusBarFormat';
import { buildConversationDescription, buildTreeHierarchy } from '../src/ui/treeModel';
import type { Snapshot } from '../src/model';

const j = (o: object) => JSON.stringify(o);
const user = (i: number, text: string, extra = '') => j({ step_index: i, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: `<USER_REQUEST>${text}</USER_REQUEST>${extra}` });
const plan = (i: number, input: number, cache: number) => j({ step_index: i, source: 'MODEL', type: 'PLANNER_RESPONSE', input_tokens: input, cache_read_tokens: cache, output_tokens: 5 });
const ckpt = (i: number, body = 'x'.repeat(4500)) => j({ step_index: i, source: 'SYSTEM', type: 'CHECKPOINT', input_tokens: 900000, cache_read_tokens: 1, output_tokens: 9, content: `# Resuming from a compaction\n${body}` });

function parse(lines: string[]): TranscriptParser {
  const p = new TranscriptParser();
  p.ingest(Buffer.from(lines.join('\n') + '\n'));
  return p;
}

// manual at 5, auto at 9, auto at 13
const lines = [
  user(0, 'hello'), plan(1, 1000, 100000),
  user(2, 'more'), plan(3, 2000, 280000),
  user(4, '/compact '), ckpt(5), user(6, 'next'), plan(7, 3000, 20000),
  plan(8, 4000, 250000), ckpt(9), user(10, 'again'), plan(11, 5000, 30000),
  user(12, 'ok'), ckpt(13),
];

describe('compaction detection', () => {
  const s = parse(lines).summary();
  it('counts manual vs automatic, last step and was', () => {
    expect(s.compaction).toEqual({ count: 3, manual: 1, lastStep: 13, was: 35000 });
    expect(s.lastCheckpoint).toBe(13);
  });
  it('first compaction is manual with was = last planner figure', () => {
    const p = parse(lines.slice(0, 6)).summary();
    expect(p.compaction).toEqual({ count: 1, manual: 1, lastStep: 5, was: 282000 });
  });
  it('/compact separated from the CHECKPOINT by a model reply is automatic', () => {
    const p = parse([user(0, '/compact'), plan(1, 1, 1), ckpt(2)]).summary();
    expect(p.compaction?.manual).toBe(0);
  });
  it('CHECKPOINT never moves used; a later planner call does', () => {
    expect(s.used).toBe(35000);
    expect(parse(lines.slice(0, 6)).summary().used).toBe(282000);
  });
  it('null without CHECKPOINT; a non-compaction CHECKPOINT is ignored', () => {
    expect(parse([user(0, 'hi'), plan(1, 1, 1)]).summary().compaction).toBeNull();
    const p = parse([j({ step_index: 0, source: 'SYSTEM', type: 'CHECKPOINT', content: 'other' })]).summary();
    expect(p.compaction).toBeNull();
  });
  // Real wording (checked on 6 chats, 2026-11-09): backticks, then a trailing sentence.
  const setting = (from: string, to: string) =>
    `\n<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from ${from} to ${to}. No need to comment on this change unless asked.\n</USER_SETTINGS_CHANGE>`;
  it('model changes from the real Model Selection wording (dots in names, trailing sentence)', () => {
    const p = parse([user(0, 'hi', setting('None', 'Gemini 4 Argon (Low)')), plan(1, 1, 1),
      user(4, 'x', setting('Gemini 4 Argon (Low)', 'Gemini 3.8 Flash (Medium)'))]).summary();
    expect(p.modelChanges).toEqual([{ step: 4, from: 'Gemini 4 Argon (Low)', to: 'Gemini 3.8 Flash (Medium)' }]);
  });
  it('the initial pick (`from None`) is not a model change', () => {
    expect(parse([user(0, 'hi', setting('None', 'Gemini 3.8 Flash (Medium)'))]).summary().modelChanges).toEqual([]);
  });
  it('still reads the older wording without backticks', () => {
    const p = parse([plan(1, 1, 1), user(2, 'x', '\n<USER_SETTINGS_CHANGE>\nThe user changed setting Model Selection from Gemini 4 Argon (Medium) to Gemini 3.8 Flash (Medium)\n</USER_SETTINGS_CHANGE>')]).summary();
    expect(p.modelChanges).toEqual([{ step: 2, from: 'Gemini 4 Argon (Medium)', to: 'Gemini 3.8 Flash (Medium)' }]);
  });
});

const base: Snapshot = {
  conversationId: 'c', title: 'T', source: 'file', used: 14000, limit: 256000, limitSource: 'db',
  modelKey: null, modelDisplay: 'M', estimate: null, groups: [],
  totals: { input: 0, cacheRead: 0, output: 0, calls: 0 },
  compaction: { count: 4, manual: 1, lastStep: 211, was: 281740 }, modelChanges: [], startStepIndex: 211,
  notSelected: false, role: 'active',
};

describe('compaction tooltip', () => {
  it('shows the lines', () => {
    expect(compactionLines({ ...base, modelChanges: [{ step: 63, from: 'A', to: 'B' }] })).toEqual([
      'Compacted 4× (1 manual) · last at step 211 · was 281.7k',
      'Compacts at ~256k (soft limit)',
      'Model changed at step 63: A → B',
    ]);
  });
  it('omits manual when 0, soft limit without limit; none without compaction', () => {
    expect(compactionLines({ ...base, compaction: { count: 1, manual: 0, lastStep: 9 }, limit: null, modelChanges: [] })).toEqual(['Compacted 1× · last at step 9']);
    expect(compactionLines({ ...base, compaction: null })).toEqual([]);
  });
  it('is part of the status bar tooltip', () => {
    expect(formatTooltip(base)).toContain('Compacted 4× (1 manual) · last at step 211 · was 281.7k');
  });
});

describe('tree after compaction', () => {
  const p = parse(lines.slice(0, 8)); // ckpt at 5; step 6 after; empty planner 7 is dropped in ~est
  const kept = stepsFrom(p.kept, p.summary().lastCheckpoint);

  it('drops steps before the last CHECKPOINT; summary item first', () => {
    const items = buildChatItems(kept);
    expect(items.map((i) => i.step)).toEqual([5, 6]);
    expect(items[0]).toMatchObject({ kind: 'compaction', label: '#5 Compaction summary', tokens: 1510 });
  });
  it('~est Baseline is computed on kept steps only', () => {
    const items = buildChatItems(kept);
    const chat = items.reduce((a, b) => a + b.tokens, 0);
    expect(computeBaseline(23000, items)).toBe(23000 - chat);
    expect(computeBaseline(23000, buildChatItems(p.kept))).toBeLessThan(23000 - chat);
  });
  it('breakdown mode starts at startStepIndex', () => {
    const groups = buildBreakdownGroups(
      [{ name: 'Chat Messages', tokens: 1700, children: [{ name: '3: PLANNER_RESPONSE', tokens: 50 }, { name: '5: CHECKPOINT', tokens: 1503 }, { name: '6: USER_INPUT', tokens: 128 }] }],
      p.kept, 256000, 5, 5,
    );
    expect(groups[0]!.children.map((c) => c.label)).toEqual(['#5 Compaction summary', '#6 next']);
    expect(groups[0]!.children[0]!.kind).toBe('compaction');
  });
  it('root description says compacted; summary item label', () => {
    expect(buildConversationDescription(base)).toContain('compacted');
    const root = buildTreeHierarchy([{ ...base, groups: [{ name: 'Chat Messages', role: 'chat', tokens: 1503, children: [{ label: '#211 Compaction summary', tokens: 1503, step: 211, kind: 'compaction' }] }] }], false)[0]!;
    expect(root.children![0]!.children![0]!.label).toBe('#211 Compaction summary · 1.5k');
  });
});
