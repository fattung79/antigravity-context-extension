import { describe, expect, it } from 'vitest';
import { classify, lookupThreshold } from '../src/ui/classify';
import { parseConfig } from '../src/config';
import { formatTooltip } from '../src/ui/statusBarFormat';

describe('classify', () => {
  it('boundaries', () => {
    expect(classify(50, 100)).toBe('healthy');
    expect(classify(51, 100)).toBe('warn');
    expect(classify(80, 100)).toBe('warn');
    expect(classify(81, 100)).toBe('amber');
    expect(classify(100, 100)).toBe('amber');
    expect(classify(101, 100)).toBe('red');
    expect(classify(0, 100)).toBe('healthy');
  });
  it('none without threshold or used', () => {
    expect(classify(50, null)).toBe('none');
    expect(classify(null, 100)).toBe('none');
    expect(classify(5, 0)).toBe('none');
  });
});

describe('lookupThreshold', () => {
  const cfg = (raw: Record<string, unknown>) => parseConfig(<T>(k: string, f: T) => (k in raw ? (raw[k] as T) : f), '/h');
  it('per-model > default > context window > none', () => {
    expect(lookupThreshold('M', 256000, cfg({ threshold: { M: 190 } }))).toEqual({ tokens: 190000, source: 'M' });
    expect(lookupThreshold('M', 256000, cfg({}))).toEqual({ tokens: 150000, source: 'default' });
    expect(lookupThreshold('M', 256000, cfg({ 'threshold.default': null }))).toEqual({ tokens: 256000, source: 'context window' });
    expect(lookupThreshold('M', null, cfg({ 'threshold.default': null }))).toBeNull();
  });
  it('skips the dotted default property', () => {
    const c = cfg({ threshold: { default: 99, M: 10 }, 'threshold.default': 150 });
    expect(lookupThreshold('default', null, c)).toEqual({ tokens: 150000, source: 'default' });
    expect(lookupThreshold('X', null, c)?.tokens).toBe(150000);
  });
});

describe('tooltip threshold row', () => {
  const snap: any = { title: 'T', modelDisplay: 'M', used: 76000, limit: 256000, limitSource: 'server', estimate: null, source: 'file', notSelected: false, totals: { input: 0, cacheRead: 0, output: 0, calls: 0 } };
  it('shows threshold and omits when none', () => {
    const t = formatTooltip(snap, false, { tokens: 190000, source: 'Gemini 3.8 Flash' });
    expect(t).toContain('Threshold: 40% of 190,000 · `threshold["Gemini 3.8 Flash"]`');
    expect(t).toContain('Limit source: server');
    expect(formatTooltip(snap, false, null)).not.toContain('Threshold');
  });
});
