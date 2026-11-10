import { describe, expect, it } from 'vitest';
import { BUILT_IN_LIMITS, RememberedLimits, normaliseModelKey, resolveLimit } from '../src/limits';
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

describe('resolveLimit full chain', () => {
  const base = { modelKey: 'Gemini 3.8 Flash', override: {}, server: null, database: null, remembered: {}, defaultLimit: null };
  it('override > server > database > remembered > built-in > default', () => {
    const all = { ...base, override: { 'Gemini 3.8 Flash': 1 }, server: 2, database: 3, remembered: { 'Gemini 3.8 Flash': 4 }, defaultLimit: 6 };
    expect(resolveLimit(all)).toEqual({ limit: 1, limitSource: 'override' });
    expect(resolveLimit({ ...all, override: {} })).toEqual({ limit: 2, limitSource: 'server' });
    expect(resolveLimit({ ...all, override: {}, server: null })).toEqual({ limit: 3, limitSource: 'database' });
    expect(resolveLimit({ ...all, override: {}, server: null, database: null })).toEqual({ limit: 4, limitSource: 'remembered' });
    expect(resolveLimit({ ...base, defaultLimit: 6 })).toEqual({ limit: 256000, limitSource: 'built-in' });
    expect(resolveLimit({ ...base, modelKey: 'Claude X', defaultLimit: 6 })).toEqual({ limit: 6, limitSource: 'default' });
    expect(resolveLimit({ ...base, modelKey: null })).toEqual({ limit: null, limitSource: 'unknown' });
  });
  it('built-in table has only the two confirmed models', () => {
    expect(BUILT_IN_LIMITS).toEqual({ 'Gemini 3.8 Flash': 256000, 'Gemini 4 Argon': 256000 });
  });
  it('model key is normalised before lookup by callers', () => {
    const key = normaliseModelKey('Gemini 4 Argon (High)');
    expect(resolveLimit({ ...base, modelKey: key })).toEqual({ limit: 256000, limitSource: 'built-in' });
  });
});

describe('RememberedLimits', () => {
  it('saves seen limits and feeds resolveLimit', () => {
    const store: Record<string, unknown> = {};
    const m = { get: <T>(k: string, f: T) => (k in store ? (store[k] as T) : f), update: (k: string, v: unknown) => { store[k] = v; } };
    const r = new RememberedLimits(m);
    r.remember('Claude X', 200000);
    r.remember(null, 5);
    r.remember('Bad', 0);
    expect(r.all()).toEqual({ 'Claude X': 200000 });
    expect(resolveLimit({ modelKey: 'Claude X', override: {}, database: null, remembered: r.all(), defaultLimit: null }))
      .toEqual({ limit: 200000, limitSource: 'remembered' });
  });
});
