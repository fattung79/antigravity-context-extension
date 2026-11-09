import { describe, expect, it } from 'vitest';
import { formatLabel, formatTokens, formatTooltip, EMPTY_LABEL } from '../src/ui/statusBarFormat';
import type { Snapshot } from '../src/model';

describe('formatLabel', () => {
  it('limit known, file source', () => {
    expect(formatLabel({ used: 159000, limit: 256000, source: 'file' })).toBe('◔ ctx 62% · 159k/256k~');
  });
  it('rpc source has no trailing tilde', () => {
    expect(formatLabel({ used: 159000, limit: 256000, source: 'rpc' })).toBe('◔ ctx 62% · 159k/256k');
  });
  it('no limit', () => {
    expect(formatLabel({ used: 124000, limit: null, source: 'file' })).toBe('◔ ctx 124k / ?~');
  });
  it('n/a', () => {
    expect(formatLabel({ used: null, limit: 256000, source: 'file' })).toBe('◔ ctx n/a');
  });
  it('may exceed 100%', () => {
    expect(formatLabel({ used: 282000, limit: 256000, source: 'file' })).toBe('◔ ctx 110% · 282k/256k~');
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
