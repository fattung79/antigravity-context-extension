import * as os from 'node:os';
import * as path from 'node:path';
import type { LogLevel } from './logger';

export interface Config {
  roots: string[];
  maxConversations: number;
  recentExpiryMinutes: number;
  threshold: Record<string, number>;
  thresholdDefault: number | null;
  limits: Record<string, number>;
  limitsDefault: number | null;
  heavyItemPercent: number;
  hoverChars: number;
  logLevel: LogLevel;
}

/** Minimal getter so parsing is testable without vscode. */
export type RawGetter = <T>(key: string, fallback: T) => T;

export const DEFAULT_ROOTS = ['~/.gemini/antigravity/'];

export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

function numMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'default') continue; // dotted key leaks in as a property
      if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
    }
  }
  return out;
}

function numOrNull(v: unknown, fallback: number | null): number | null {
  if (v === null) return null;
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function parseConfig(get: RawGetter, home?: string): Config {
  const rootsRaw = get<unknown>('roots', DEFAULT_ROOTS);
  const roots = (Array.isArray(rootsRaw) ? rootsRaw : DEFAULT_ROOTS)
    .filter((r): r is string => typeof r === 'string' && r.trim() !== '')
    .map((r) => expandHome(r.trim(), home));
  const max = get<unknown>('maxConversations', 3);
  const exp = get<unknown>('recentExpiryMinutes', 3);
  const heavy = get<unknown>('heavyItemPercent', 5);
  const hover = get<unknown>('hoverChars', 2000);
  const level = get<unknown>('logLevel', 'error');
  return {
    roots,
    maxConversations: typeof max === 'number' && max >= 1 ? Math.floor(max) : 3,
    recentExpiryMinutes: typeof exp === 'number' && exp >= 0 ? exp : 3,
    threshold: numMap(get<unknown>('threshold', {})),
    thresholdDefault: numOrNull(get<unknown>('threshold.default', 150), 150),
    limits: numMap(get<unknown>('limits', {})),
    limitsDefault: numOrNull(get<unknown>('limits.default', null), null),
    heavyItemPercent: typeof heavy === 'number' ? heavy : 5,
    hoverChars: typeof hover === 'number' ? hover : 2000,
    logLevel: level === 'off' || level === 'error' || level === 'info' || level === 'debug' ? level : 'error',
  };
}
