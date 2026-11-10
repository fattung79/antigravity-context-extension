/** Model key = display name without the trailing effort level in brackets. */
export function normaliseModelKey(display: string | null | undefined): string | null {
  if (!display) return null;
  const key = display.replace(/\s*\([^()]*\)\s*$/, '').trim();
  return key === '' ? null : key;
}

/** Confirmed values only; no guesses for Claude or GPT-OSS. */
export const BUILT_IN_LIMITS: Readonly<Record<string, number>> = {
  'Gemini 3.8 Flash': 256000,
  'Gemini 4 Argon': 256000,
};

export type LimitSource = 'override' | 'server' | 'database' | 'remembered' | 'built-in' | 'default' | 'unknown';

export interface LimitInputs {
  modelKey: string | null;
  override: Record<string, number>;   // contextViewer.limits
  server?: number | null;             // live server maxContextTokens (slice 3)
  database: number | null;            // gen_metadata .1.9.10.4
  remembered?: Record<string, number>; // persisted limits seen earlier
  defaultLimit: number | null;        // contextViewer.limits.default
}

export interface ResolvedLimit {
  limit: number | null;
  limitSource: LimitSource;
}

function pos(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** Spec section 5: override > server > database > remembered > built-in > default > unknown. */
export function resolveLimit(inp: LimitInputs): ResolvedLimit {
  const k = inp.modelKey;
  const own = (m: Record<string, number> | undefined): number | undefined =>
    k !== null && m && Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined;
  const o = own(inp.override);
  if (pos(o)) return { limit: o, limitSource: 'override' };
  if (pos(inp.server)) return { limit: inp.server, limitSource: 'server' };
  if (pos(inp.database)) return { limit: inp.database, limitSource: 'database' };
  const r = own(inp.remembered);
  if (pos(r)) return { limit: r, limitSource: 'remembered' };
  const b = own(BUILT_IN_LIMITS);
  if (pos(b)) return { limit: b, limitSource: 'built-in' };
  if (pos(inp.defaultLimit)) return { limit: inp.defaultLimit, limitSource: 'default' };
  return { limit: null, limitSource: 'unknown' };
}

/** Minimal vscode.Memento shape (injected so this module stays vscode-free). */
export interface MementoLike {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void> | void;
}

export const REMEMBERED_KEY = 'contextViewer.rememberedLimits';

/** Remembered limits per model key, the only persisted state of the extension. */
export class RememberedLimits {
  constructor(private memento: MementoLike) {}

  all(): Record<string, number> {
    const v = this.memento.get<Record<string, number>>(REMEMBERED_KEY, {});
    return v && typeof v === 'object' ? v : {};
  }

  /** Save a limit seen from server/database. No-op if unchanged or invalid. */
  remember(modelKey: string | null, limit: number | null | undefined): void {
    if (modelKey === null || !pos(limit)) return;
    const cur = this.all();
    if (cur[modelKey] === limit) return;
    void this.memento.update(REMEMBERED_KEY, { ...cur, [modelKey]: limit });
  }
}
