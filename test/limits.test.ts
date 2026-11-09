import { describe, expect, it } from 'vitest';
import { normaliseModelKey, resolveLimit } from '../src/limits';
import { parseConfig } from '../src/config';

describe('normaliseModelKey', () => {
  it('strips a trailing effort level', () => {
    expect(normaliseModelKey('Gemini 3.8 Flash (Medium)')).toBe('Gemini 3.8 Flash');
    expect(normaliseModelKey('Gemini 4 Argon (Low)')).toBe('Gemini 4 Argon');
  });
  it('keeps names without an effort level and handles empties', () => {
    expect(normaliseModelKey('Claude Opus 4.6')).toBe('Claude Opus 4.6');
    expect(normaliseModelKey(null)).toBeNull();
    expect(normaliseModelKey('')).toBeNull();
  });
});

describe('resolveLimit', () => {
  const base = { modelKey: 'M', override: {}, database: null, defaultLimit: null };
  it('override > database > default > null', () => {
    expect(resolveLimit({ ...base, override: { M: 1 }, database: 2, defaultLimit: 3 })).toEqual({ limit: 1, limitSource: 'override' });
    expect(resolveLimit({ ...base, database: 2, defaultLimit: 3 })).toEqual({ limit: 2, limitSource: 'database' });
    expect(resolveLimit({ ...base, defaultLimit: 3 })).toEqual({ limit: 3, limitSource: 'default' });
    expect(resolveLimit(base)).toEqual({ limit: null, limitSource: 'unknown' });
  });
});

describe('parseConfig', () => {
  it('skips the dotted `default` property in per-model maps', () => {
    const raw: Record<string, unknown> = { limits: { default: 5, 'A': 10 }, 'limits.default': 7 };
    const c = parseConfig(<T>(k: string, f: T) => (k in raw ? (raw[k] as T) : f), '/home/u');
    expect(c.limits).toEqual({ A: 10 });
    expect(c.limitsDefault).toBe(7);
    expect(c.roots).toEqual(['/home/u/.gemini/antigravity/']);
  });
});
