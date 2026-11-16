import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../src/model';
import {
  breakdownTotal,
  buildConversationDescription,
  buildConversationTooltip,
  buildTreeHierarchy,
  formatItemTokens,
  groupIcon,
  groupIconColor,
  openKindOf,
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
          name: 'Baseline', role: 'baseline',
          tokens: 4000,
          estimated: true,
          children: [],
        },
        {
          name: 'Chat Messages',
          role: 'chat',
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

describe('rule file children', () => {
  const snap = (ruleFiles?: Snapshot['ruleFiles']): Snapshot => ({
    conversationId: 'c1', title: 't', source: 'rpc', used: 1, limit: 10, limitSource: 'server',
    modelKey: null, modelDisplay: null, estimate: null,
    groups: [{ name: 'System Prompt', role: 'section', tokens: 10, children: [
      { label: 'user_rules', tokens: 5, kind: 'section' }, { label: 'skills', tokens: 5, kind: 'section' },
    ] }],
    totals: { input: 0, cacheRead: 0, output: 0, calls: 0 }, compaction: null, modelChanges: [],
    startStepIndex: null, notSelected: false, role: 'active', ruleFiles,
  });
  const rules = (roots: ReturnType<typeof buildTreeHierarchy>) => roots[0]!.children![0]!.children!.find((c) => c.name === 'user_rules')!;

  it('adds one child per file with label, description (home as ~), openable', () => {
    const roots = buildTreeHierarchy([snap([
      { path: '/home/u/proj/AGENTS.md', scope: 'workspace' },
      { path: '/home/u/.gemini/AGENTS.md', scope: 'global' },
      { path: '/etc/rules/a.md', scope: 'global' },
    ])], false, 0, '/home/u', []);
    const ur = rules(roots);
    expect(ur.children!.map((c) => c.label)).toEqual(['AGENTS.md', 'AGENTS.md', 'a.md']);
    expect(ur.children!.map((c) => c.description)).toEqual(['workspace · ~/proj', 'global · ~/.gemini', 'global · /etc/rules']);
    expect(ur.children![0]).toMatchObject({ type: 'file', openable: true, path: '/home/u/proj/AGENTS.md', conversationId: 'c1' });
    expect(ur.children![0]!.tooltip).toBe('/home/u/proj/AGENTS.md\nLoaded rule file; its tokens are part of user_rules.');
    expect(roots[0]!.children![0]!.children!.find((c) => c.name === 'skills')!.children).toBeUndefined();
  });
  it('files under a data root are not openable', () => {
    const ur = rules(buildTreeHierarchy([snap([
      { path: '/data/brain/x.md', scope: 'workspace' }, { path: '/data2/x.md', scope: 'workspace' },
    ])], false, 0, '/home/u', ['/data']));
    expect(ur.children!.map((c) => c.openable)).toEqual([false, true]);
  });
  it('no ruleFiles => no children; parentId chain intact', () => {
    expect(rules(buildTreeHierarchy([snap()], false)).children).toBeUndefined();
    expect(rules(buildTreeHierarchy([snap([])], false)).children).toBeUndefined();
    const roots = buildTreeHierarchy([snap([{ path: '/a/b.md', scope: 'global' }])], false, 0, '/home/u');
    const ur = rules(roots);
    expect(ur.parentId).toBe('c1/System Prompt');
    expect(ur.children![0]!.parentId).toBe(ur.id);
    expect(roots[0]!.children![0]!.parentId).toBe('c1');
  });
});

describe('Rules group (role-based)', () => {
  const snap = {
    conversationId: 'c1', title: 't', source: 'rpc', used: 1, limit: 10, limitSource: 'server',
    modelKey: null, modelDisplay: null, estimate: null,
    groups: [
      { name: 'Rules', role: 'section', type: 'TOKEN_TYPE_3', tokens: 5, children: [{ label: 'user_rules', tokens: 5, kind: 'section' }] },
      { name: 'Mystery', role: 'section', tokens: 1, children: [] },
    ],
    totals: { input: 0, cacheRead: 0, output: 0, calls: 0 }, compaction: null, modelChanges: [],
    startStepIndex: null, notSelected: false, role: 'active', ruleFiles: [{ path: '/x/AGENTS.md', scope: 'workspace' }],
  } as Snapshot;
  const roots = buildTreeHierarchy([snap], false, 0, '/home/u', []);
  const rules = roots[0]!.children![0]!;

  it('section item in Rules is openable and gets rule files', () => {
    const ur = rules.children![0]!;
    expect(openKindOf(ur)).toBe('section');
    expect(ur.children!.map((c) => c.label)).toEqual(['AGENTS.md']);
  });
  it('group icons by role, fallback for unknown', () => {
    expect(groupIcon(rules)).toBe('law');
    expect(groupIcon(roots[0]!.children![1]!)).toBe('symbol-namespace');
    expect(groupIcon({ groupRole: 'chat', label: 'x' })).toBe('history');
    expect(groupIconColor(rules)).toBe('charts.red');
    expect(groupIconColor({ groupRole: 'tools', label: 'Tools' })).toBe('charts.orange');
    expect(groupIconColor({ groupRole: 'section', label: 'Brand New' })).toBeUndefined();
    expect(groupIconColor({ groupRole: 'chat', label: 'Chat Messages' })).toBeUndefined();
  });
});
