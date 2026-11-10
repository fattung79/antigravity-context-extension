import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../src/model';
import {
  breakdownTotal,
  buildConversationDescription,
  buildConversationTooltip,
  buildTreeHierarchy,
  formatItemTokens,
  sortChatItems,
} from '../src/ui/treeModel';

describe('formatItemTokens', () => {
  it('formats exact tokens without prefix', () => {
    expect(formatItemTokens(3100, false)).toBe('3.1k');
  });

  it('formats estimated tokens with ~ prefix', () => {
    expect(formatItemTokens(3100, true)).toBe('~3.1k');
  });
});

describe('sortChatItems', () => {
  const items = [
    { label: '#1 first', tokens: 500, step: 1 },
    { label: '#3 third', tokens: 2000, step: 3 },
    { label: '#2 second', tokens: 100, step: 2 },
  ];

  it('keeps time/step order when largestFirst is false', () => {
    const sorted = sortChatItems(items, false);
    expect(sorted.map((i) => i.step)).toEqual([1, 2, 3]);
  });

  it('sorts descending by tokens when largestFirst is true', () => {
    const sorted = sortChatItems(items, true);
    expect(sorted.map((i) => i.tokens)).toEqual([2000, 500, 100]);
    expect(sorted.map((i) => i.step)).toEqual([3, 1, 2]);
  });
});

describe('formatItemTokens edge cases', () => {
  it('formats small, 159k and exact values', () => {
    expect(formatItemTokens(950, true)).toBe('~950');
    expect(formatItemTokens(159000, false)).toBe('159k');
  });
});

describe('buildConversationDescription', () => {
  const baseSnap: Snapshot = {
    conversationId: 'abc',
    title: 'Test',
    source: 'file',
    used: 159000,
    limit: 256000,
    limitSource: 'built-in',
    modelKey: 'flash',
    modelDisplay: 'Gemini 3.8 Flash',
    estimate: null,
    groups: [],
    totals: { input: 0, cacheRead: 0, output: 0, calls: 0 },
    compaction: null,
    modelChanges: [],
    startStepIndex: null,
    notSelected: false,
    role: 'active',
  };

  it('builds standard active description', () => {
    expect(buildConversationDescription(baseSnap)).toBe('62% · 159k/256k · file');
  });

  it('adds not selected when applicable', () => {
    expect(buildConversationDescription({ ...baseSnap, notSelected: true })).toBe(
      '62% · 159k/256k · file · not selected',
    );
  });

  it('adds compacted when compaction occurred', () => {
    expect(
      buildConversationDescription({
        ...baseSnap,
        compaction: { count: 1, manual: 0 },
      }),
    ).toBe('62% · 159k/256k · file · compacted');
  });
});

describe('buildTreeHierarchy', () => {
  it('builds full hierarchy with groups and items', () => {
    const snap: Snapshot = {
      conversationId: 'abc',
      title: 'Fix issue',
      source: 'file',
      used: 5000,
      limit: 100000,
      limitSource: 'built-in',
      modelKey: 'flash',
      modelDisplay: 'Flash',
      estimate: null,
      groups: [
        {
          name: 'Baseline',
          tokens: 4000,
          estimated: true,
          children: [],
        },
        {
          name: 'Chat Messages',
          tokens: 1000,
          estimated: true,
          children: [
            { label: '#1 prompt', tokens: 600, step: 1, kind: 'user', estimated: true },
            { label: '#2 tool', tokens: 400, step: 2, kind: 'command', estimated: true, heavy: true },
          ],
        },
      ],
      totals: { input: 0, cacheRead: 0, output: 0, calls: 0 },
      compaction: null,
      modelChanges: [],
      startStepIndex: null,
      notSelected: false,
      role: 'active',
    };

    const roots = buildTreeHierarchy([snap], false);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.type).toBe('conversation');
    expect(roots[0]!.children).toHaveLength(2);

    const baselineGroup = roots[0]!.children![0]!;
    expect(baselineGroup.label).toBe('Baseline');
    expect(baselineGroup.description).toBe('~4k');

    const chatGroup = roots[0]!.children![1]!;
    expect(chatGroup.label).toBe('Chat Messages');
    expect(chatGroup.description).toBe('~1k');
    expect(chatGroup.children).toHaveLength(2);
    expect(chatGroup.children![1]!.heavy).toBe(true);
    expect(chatGroup.children![1]!.label).toBe('#2 tool · ~400');
    expect(chatGroup.children![1]!.parentId).toBe('abc/Chat Messages');
    expect(chatGroup.parentId).toBe('abc');
    expect(roots[0]!.parentId).toBeUndefined();
  });
});

describe('breakdown vs billed labelling', () => {
  const snap = (groups: Snapshot['groups']): Snapshot => ({
    conversationId: 'abc', title: 'T', source: 'file', used: 14086, limit: 256000, limitSource: 'database',
    modelKey: 'm', modelDisplay: 'm', estimate: 19670, groups,
    totals: { input: 0, cacheRead: 0, output: 0, calls: 0 }, compaction: null, modelChanges: [],
    startStepIndex: null, notSelected: false, role: 'active',
  } as Snapshot);
  const g = (name: string, tokens: number, estimated = false) => ({ name, tokens, estimated, children: [] }) as unknown as Snapshot['groups'][number];

  it('labels the exact breakdown total as Antigravity est.', () => {
    const s = snap([g('System Prompt', 12485), g('Tools', 5789), g('Chat Messages', 1396)]);
    expect(breakdownTotal(s)).toBe(19670);
    expect(buildConversationDescription(s)).toBe('6% · 14.1k/256k · file · breakdown 19.7k (Antigravity est.)');
    expect(buildConversationTooltip(s)).toContain("Antigravity's own count");
  });

  it('omits it in ~est mode', () => {
    const s = snap([g('Baseline', 12000, true), g('Chat Messages', 2086, true)]);
    expect(breakdownTotal(s)).toBeNull();
    expect(buildConversationDescription(s)).toBe('6% · 14.1k/256k · file');
    expect(buildConversationTooltip(s)).toBeUndefined();
  });
});
