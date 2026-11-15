import { describe, expect, it } from 'vitest';
import {
  buildChatItems,
  buildItems,
  classifyToolKind,
  extractTarget,
  isHeavy,
  splitTokens,
  computeBaseline,
  estimateTokens,
  type CompactStep,
} from '../src/sources/items';

describe('estimateTokens', () => {
  it('estimates ~3 chars per token rounding up', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(3)).toBe(1);
    expect(estimateTokens(4)).toBe(2);
    expect(estimateTokens(300)).toBe(100);
  });
});

describe('classifyToolKind', () => {
  it('classifies file read tools', () => {
    expect(classifyToolKind('view_file')).toBe('file-read');
    expect(classifyToolKind('read_file')).toBe('file-read');
  });

  it('classifies file edit tools', () => {
    expect(classifyToolKind('edit_file')).toBe('file-edit');
    expect(classifyToolKind('write_file')).toBe('file-edit');
    expect(classifyToolKind('replace_file_content')).toBe('file-edit');
  });

  it('classifies command tools', () => {
    expect(classifyToolKind('run_command')).toBe('command');
  });

  it('classifies web tools', () => {
    expect(classifyToolKind('search_web')).toBe('web');
    expect(classifyToolKind('read_url_content')).toBe('web');
  });

  it('classifies agent tools', () => {
    expect(classifyToolKind('send_message')).toBe('agent');
    expect(classifyToolKind('invoke_subagent')).toBe('agent');
  });
});

describe('buildChatItems', () => {
  const steps: CompactStep[] = [
    { index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', contentLength: 60, promptPreview: 'Please examine src/main.ts' },
    {
      index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', contentLength: 30,
      toolCalls: [
        { name: 'read_file', target: 'src/main.ts', callChars: 60 },
        { name: 'run_command', target: 'npm test', callChars: 30 },
      ],
    },
    { index: 2, source: 'MODEL', type: 'GENERIC', contentLength: 300 },
    { index: 3, source: 'MODEL', type: 'GENERIC', contentLength: 201 },
    { index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', contentLength: 15 },
  ];

  it('pairs k tool calls with the next k GENERIC steps by position and sums counts', () => {
    const items = buildChatItems(steps);
    expect(items.map((i) => [i.step, i.kind, i.label])).toEqual([
      [0, 'user', '#0 Please examine src/main.ts'],
      [1, 'file-read', '#1 read_file src/main.ts'],
      [1, 'command', '#1 run_command npm test'],
      [4, 'model', '#4 Model reply'],
    ]);
    expect(items[0]!.tokens).toBe(20); // 60/3
    // planner = (30+60+30)/3 = 40 split 2:1 -> 27/13 (remainder first); results 100 and 67
    expect(items[1]!.tokens).toBe(27 + 100);
    expect(items[2]!.tokens).toBe(13 + 67);
    expect(items[3]!.tokens).toBe(5);
  });

  it('item token sum equals the sum of step estimates (merging loses nothing)', () => {
    const total = buildChatItems(steps).reduce((a, b) => a + b.tokens, 0);
    expect(total).toBe(20 + 40 + 100 + 67 + 5);
  });

  it('marks items as error when the result step errored', () => {
    const items = buildChatItems([
      { index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', contentLength: 0, toolCalls: [{ name: 'run_command', target: 'git status', callChars: 30 }] },
      { index: 2, source: 'MODEL', type: 'GENERIC', status: 'ERROR', contentLength: 90 },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('error');
  });

  it('does not make items for CHECKPOINT or empty planner steps; SYSTEM_MESSAGE is an item', () => {
    const items = buildChatItems([
      { index: 0, source: 'SYSTEM', type: 'CHECKPOINT', contentLength: 5000 },
      { index: 1, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', contentLength: 30 },
      { index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', contentLength: 0 },
    ]);
    expect(items.map((i) => [i.kind, i.label])).toEqual([['system', '#1 System message']]);
  });
});

describe('buildItems (exact units)', () => {
  it('falls back to type labels when the transcript step is missing', () => {
    const items = buildItems(
      [{ step: 9, type: 'PLANNER_RESPONSE', tokens: 7 }, { step: 10, type: 'GENERIC', tokens: 5 }],
      [], { estimated: false },
    );
    expect(items.map((i) => [i.label, i.tokens])).toEqual([['#9 Model reply', 7], ['#10 Tool result', 5]]);
  });

  it('keeps zero-count items when exact', () => {
    const items = buildItems([{ step: 1, type: 'USER_INPUT', tokens: 0 }], [], { estimated: false });
    expect(items).toHaveLength(1);
  });
});

describe('splitTokens / isHeavy', () => {
  it('preserves the total', () => {
    expect(splitTokens(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(splitTokens(5, [0, 0])).toEqual([5, 0]);
  });
  it('heavy is strictly above percent of the limit', () => {
    expect(isHeavy(5000, 100000, 5)).toBe(false);
    expect(isHeavy(5001, 100000, 5)).toBe(true);
    expect(isHeavy(9, null, 5)).toBe(false);
  });
});

describe('extractTarget', () => {
  it('takes the path / command head / url and trims to the first line', () => {
    expect(extractTarget({ Path: 'src/a.ts' })).toBe('src/a.ts');
    expect(extractTarget({ CommandLine: 'npm test\nmore' })).toBe('npm test');
    expect(extractTarget({ Url: 'https://x.dev/a' })).toBe('https://x.dev/a');
    expect(extractTarget(undefined)).toBe('');
  });
});

describe('computeBaseline', () => {
  it('returns used minus chat tokens', () => {
    const chatItems = [
      { step: 0, kind: 'user' as const, label: '', tokens: 1000 },
      { step: 1, kind: 'model' as const, label: '', tokens: 2000 },
    ];
    expect(computeBaseline(10000, chatItems)).toBe(7000);
  });

  it('clamps to 0 if chat exceeds used', () => {
    const chatItems = [
      { step: 0, kind: 'user' as const, label: '', tokens: 5000 },
    ];
    expect(computeBaseline(3000, chatItems)).toBe(0);
  });

  it('returns 0 when used is null', () => {
    expect(computeBaseline(null, [])).toBe(0);
  });
});
