/** Model key = display name without the trailing effort level in brackets. */
export function normaliseModelKey(display: string | null | undefined): string | null {
  if (!display) return null;
  const key = display.replace(/\s*\([^()]*\)\s*$/, '').trim();
  return key === '' ? null : key;
}

export interface LimitInputs {
  modelKey: string | null;
  override: Record<string, number>;   // contextViewer.limits
  database: number | null;            // gen_metadata .1.9.10.4
  defaultLimit: number | null;        // contextViewer.limits.default
}

export interface ResolvedLimit {
  limit: number | null;
  limitSource: string; // 'override' | 'database' | 'default' | 'unknown'
}

/**
 * Slice 1 chain: override > database > default > null.
 * SEAM (slice 4): insert server (rpc), remembered (globalState) and built-in table
 * between `database` and `default`, per spec section 5.
 */
export function resolveLimit(inp: LimitInputs): ResolvedLimit {
  const o = inp.modelKey !== null ? inp.override[inp.modelKey] : undefined;
  if (typeof o === 'number' && o > 0) return { limit: o, limitSource: 'override' };
  if (inp.database !== null && inp.database > 0) return { limit: inp.database, limitSource: 'database' };
  if (inp.defaultLimit !== null && inp.defaultLimit > 0) return { limit: inp.defaultLimit, limitSource: 'default' };
  return { limit: null, limitSource: 'unknown' };
}
