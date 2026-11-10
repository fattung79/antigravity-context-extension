import type { Config } from '../config';

export type Level = 'none' | 'healthy' | 'warn' | 'amber' | 'red';

/** Pure: used / threshold ratio -> level. <=50% healthy, >50% warn, >80% amber, >100% red, no threshold -> none. */
export function classify(used: number | null, threshold: number | null): Level {
  if (used === null || threshold === null || !(threshold > 0)) return 'none';
  const r = used / threshold;
  if (r > 1) return 'red';
  if (r > 0.8) return 'amber';
  if (r > 0.5) return 'warn';
  return 'healthy';
}

export interface Threshold {
  tokens: number;
  /** `<model key>` or 'default' (shown in the tooltip). */
  source: string;
}

/**
 * Threshold lookup: per-model (thousands) > default (thousands) > Context window if default cleared > none.
 * Never reads the dotted `default` entry as a model key.
 */
export function lookupThreshold(
  modelKey: string | null,
  limit: number | null,
  cfg: Pick<Config, 'threshold' | 'thresholdDefault'>,
): Threshold | null {
  if (modelKey !== null && modelKey !== 'default' && Object.prototype.hasOwnProperty.call(cfg.threshold, modelKey)) {
    const k = cfg.threshold[modelKey] ?? 0;
    if (k > 0) return { tokens: k * 1000, source: modelKey };
  }
  if (cfg.thresholdDefault !== null && cfg.thresholdDefault > 0) return { tokens: cfg.thresholdDefault * 1000, source: 'default' };
  if (cfg.thresholdDefault === null && limit !== null && limit > 0) return { tokens: limit, source: 'context window' };
  return null;
}

/** Level for a Snapshot-like under the current settings. */
export function levelFor(
  s: { used: number | null; limit: number | null; modelKey: string | null },
  cfg: Pick<Config, 'threshold' | 'thresholdDefault'>,
): Level {
  return classify(s.used, lookupThreshold(s.modelKey, s.limit, cfg)?.tokens ?? null);
}
