import { describe, expect, it } from 'vitest';
import { formatLabel, formatTokens, formatTooltip, EMPTY_LABEL } from '../src/ui/statusBarFormat';
import type { Snapshot } from '../src/model';

describe('formatLabel', () => {
  const T = 'Fix WSL path handling in the poller';
  it('traffic-light dot, title cut at ~18 chars, then % of window and used/window', () => {
    expect(formatLabel({ title: T, used: 159000, limit: 256000, source: 'rpc' }, 'warn')).toBe('🟡 Fix WSL path… · 62% · 159k/256k');
  });
  it('one dot per level; no Threshold is a white dot', () => {
    const s = { title: 'Short', used: 10000, limit: 100000, source: 'rpc' as const };
    expect(formatLabel(s, 'healthy')).toBe('🟢 Short · 10% · 10k/100k');
    expect(formatLabel(s, 'amber')).toBe('🟠 Short · 10% · 10k/100k');
    expect(formatLabel(s, 'red')).toBe('🔴 Short · 10% · 10k/100k');
    expect(formatLabel(s, 'none')).toBe('⚪ Short · 10% · 10k/100k');
  });
  it('file source keeps the trailing tilde', () => {
    expect(formatLabel({ title: 'Short', used: 159000, limit: 256000, source: 'file' }, 'red')).toBe('🔴 Short · 62% · 159k/256k~');
  });
  it('no limit', () => {
    expect(formatLabel({ title: 'Short', used: 124000, limit: null, source: 'file' }, 'healthy')).toBe('🟢 Short · 124k / ?~');
  });
  it('n/a', () => {
    expect(formatLabel({ title: 'Short', used: null, limit: 256000, source: 'file' }, 'none')).toBe('⚪ Short · n/a');
  });
  it('may exceed 100%', () => {
    expect(formatLabel({ title: 'Short', used: 282000, limit: 256000, source: 'file' }, 'red')).toBe('🔴 Short · 110% · 282k/256k~');
  });
  it('escapes icon syntax in titles', () => {
    expect(formatLabel({ title: '$(zap) x', used: null, limit: null, source: 'rpc' }, 'none')).toBe('⚪ \\$(zap) x · n/a');
  });
  it('empty label', () => {
    expect(EMPTY_LABEL).toBe('◌ ctx —');
  });
});

describe('formatTokens', () => {
  it('formats', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(3100)).toBe('3.1k');
    expect(formatTokens(159400)).toBe('159k');
  });
});

describe('formatTooltip', () => {
  const snap: Snapshot = {
    conversationId: 'a', title: 'Fix (WSL)', source: 'file', used: 1000, limit: null, limitSource: 'unknown',
    modelKey: null, modelDisplay: null, estimate: null, groups: [], totals: { input: 1, cacheRead: 2, output: 3, calls: 1 },
    compaction: null, modelChanges: [], startStepIndex: null, notSelected: true, role: 'active',
  };
  it('has the not-selected first line, limit unknown and data source', () => {
    const t = formatTooltip(snap);
    expect(t.startsWith('**Not selected:** last viewed Conversation in this window')).toBe(true);
    expect(t).toContain('limit unknown');
    expect(t).toContain('Data source: file');
  });
});
