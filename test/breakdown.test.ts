import { describe, expect, it } from 'vitest';
import { buildBreakdownGroups, decodeBreakdown, groupRole, parseStepName } from '../src/sources/breakdown';
import { decodeGenMetadata } from '../src/sources/genMetadata';
import type { CompactStep } from '../src/sources/items';

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do { let b = v & 0x7f; v = Math.floor(v / 128); if (v > 0) b |= 0x80; out.push(b); } while (v > 0);
  return out;
}
const vf = (num: number, v: number) => [...varint(num * 8), ...varint(v)];
const lf = (num: number, p: number[]) => [...varint(num * 8 + 2), ...varint(p.length), ...p];
const sf = (num: number, s: string) => lf(num, [...Buffer.from(s)]);
const child = (name: string, tokens: number) => lf(5, [...sf(1, name), ...vf(3, tokens)]);
const group = (name: string, tokens: number, kids: [string, number][]) =>
  lf(1, [...sf(1, name), ...vf(2, 0), ...vf(4, tokens), ...kids.flatMap(([n, t]) => child(n, t))]);

function blob(): Uint8Array {
  const breakdown = [
    ...group('System Prompt', 300, [['identity', 100], ['user_rules', 200]]),
    ...group('Tools', 150, [['read_file', 80], ['run_command', 70]]),
    ...group('Chat Messages', 1000, [
      ['0: USER_INPUT', 100], ['1: PLANNER_RESPONSE', 40], ['2: GENERIC', 500], ['3: GENERIC', 60],
      ['4: PLANNER_RESPONSE', 30], ['5: USER_INPUT', 270],
    ]),
  ];
  const window = [...vf(1, 1450), ...lf(3, breakdown), ...vf(4, 100000)];
  const one = [...lf(9, [...vf(1, 0), ...lf(10, window)]), ...sf(21, 'Model X')];
  return Uint8Array.from(lf(1, one));
}

const steps: CompactStep[] = [
  { index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', contentLength: 10, promptPreview: 'Fix the bug' },
  {
    index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', contentLength: 0,
    toolCalls: [{ name: 'view_file', target: 'src/a.ts', callChars: 30 }, { name: 'run_command', target: 'ls', callChars: 10 }],
  },
  { index: 2, source: 'MODEL', type: 'GENERIC', contentLength: 1 },
  { index: 3, source: 'MODEL', type: 'GENERIC', contentLength: 1 },
  { index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', contentLength: 5 },
];

describe('decodeBreakdown', () => {
  it('decodes groups, counts and children', () => {
    const b = decodeBreakdown(blob())!;
    expect(b.map((g) => [g.name, g.tokens, g.children.length])).toEqual([
      ['System Prompt', 300, 2], ['Tools', 150, 2], ['Chat Messages', 1000, 6],
    ]);
    expect(b[0]!.children[1]).toEqual({ name: 'user_rules', tokens: 200 });
  });

  it('is null when absent and exposed through decodeGenMetadata', () => {
    expect(decodeBreakdown(Uint8Array.from(lf(1, sf(21, 'x'))))).toBeNull();
    expect(decodeGenMetadata(blob()).breakdown).toHaveLength(3);
    expect(decodeGenMetadata(blob()).limit).toBe(100000);
  });
});

describe('parseStepName', () => {
  it('parses "<step>: <TYPE>"', () => {
    expect(parseStepName('42: PLANNER_RESPONSE', 9)).toEqual({ step: 42, type: 'PLANNER_RESPONSE', tokens: 9 });
    expect(parseStepName('identity', 9)).toBeNull();
  });
});

describe('buildBreakdownGroups (breakdown + transcript join)', () => {
  const groups = buildBreakdownGroups(decodeBreakdown(blob())!, steps, 1000, 20);

  it('keeps System Prompt / Tools exact with named children', () => {
    expect(groups.map((g) => [g.name, g.tokens, g.estimated])).toEqual([
      ['System Prompt', 300, undefined], ['Tools', 150, undefined], ['Chat Messages', 1000, undefined],
    ]);
    expect(groups[1]!.children.map((c) => [c.label, c.tokens, c.kind])).toEqual([['read_file', 80, 'tool'], ['run_command', 70, 'tool']]);
    expect(groups[0]!.children[0]!.kind).toBe('section');
  });

  it('merges tool call + result by position with exact counts; unknown steps use type labels', () => {
    const chat = groups[2]!.children;
    expect(chat.map((c) => [c.label, c.tokens, c.kind])).toEqual([
      ['#0 Fix the bug', 100, 'user'],
      ['#1 view_file src/a.ts', 30 + 500, 'file-read'],   // planner split 30:10 of 40 -> 30/10
      ['#1 run_command ls', 10 + 60, 'command'],
      ['#4 Model reply', 30, 'model'],
      ['#5 User request', 270, 'user'],
    ]);
    expect(chat.reduce((a, c) => a + c.tokens, 0)).toBe(1000);
    expect(chat.every((c) => c.estimated === false)).toBe(true);
  });

  it('flags heavy items above the percent of the limit', () => {
    expect(groups[2]!.children.filter((c) => c.heavy).map((c) => c.step)).toEqual([1, 5]);
  });
});

describe('group type + role', () => {
  const typed = (name: string, type: number | null, kids: [string, number][]) =>
    lf(1, [...sf(1, name), ...(type === null ? [] : vf(2, type)), ...vf(4, 10), ...kids.flatMap(([n, t]) => child(n, t))]);
  const wrap = (groups: number[]) => Uint8Array.from(lf(1, lf(9, lf(10, lf(3, groups)))));

  it('decodeBreakdown reads field 2 as a type tag', () => {
    const b = decodeBreakdown(wrap([
      ...typed('System Prompt', 1, []), ...typed('Tools', 2, []), ...typed('Chat Messages', 7, []),
      ...typed('Skills', 5, []), ...typed('Misc', null, []),
    ]))!;
    expect(b.map((g) => g.type)).toEqual([
      'TOKEN_TYPE_SYSTEM_PROMPT', 'TOKEN_TYPE_TOOLS', 'TOKEN_TYPE_CHAT', 'TOKEN_TYPE_5', undefined,
    ]);
  });

  it('groupRole: type wins over name', () => {
    expect(groupRole({ name: 'Whatever', type: 'TOKEN_TYPE_CHAT', tokens: 1, children: [] })).toBe('chat');
    expect(groupRole({ name: 'Chat Messages', type: 'TOKEN_TYPE_TOOLS', tokens: 1, children: [] })).toBe('tools');
  });
  it('groupRole: name fallback, shape fallback, unknown -> section', () => {
    expect(groupRole({ name: 'Chat Messages', tokens: 1, children: [] })).toBe('chat');
    expect(groupRole({ name: 'Tools', tokens: 1, children: [] })).toBe('tools');
    expect(groupRole({ name: 'Renamed', tokens: 1, children: [{ name: '3: USER_INPUT', tokens: 1 }] })).toBe('chat');
    expect(groupRole({ name: 'Renamed', tokens: 1, children: [{ name: '3: USER_INPUT', tokens: 1 }, { name: 'x', tokens: 1 }] })).toBe('section');
    expect(groupRole({ name: 'Rules', type: 'TOKEN_TYPE_3', tokens: 1, children: [{ name: 'user_rules', tokens: 1 }] })).toBe('section');
    expect(groupRole({ name: 'New', type: 'TOKEN_TYPE_42', tokens: 1, children: [] })).toBe('section');
  });
  it('buildBreakdownGroups sets role/type', () => {
    const bd = [
      { name: 'Rules', type: 'TOKEN_TYPE_3', tokens: 5, children: [{ name: 'user_rules', tokens: 5 }] },
      { name: 'Z', type: 'TOKEN_TYPE_42', tokens: 1, children: [] },
    ];
    const g = buildBreakdownGroups(bd, [], null, 20);
    expect(g[0]).toMatchObject({ role: 'section', type: 'TOKEN_TYPE_3' });
    expect(g[0]!.children[0]).toMatchObject({ kind: 'section' });
  });
});
