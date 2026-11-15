import type { Clock } from './clock';

export interface PullOptions {
  clock: Clock;
  /** Performs one RPC pull for the Conversation. Errors are reported via onError, never thrown. */
  fetch: (id: string) => Promise<void>;
  onError?: (id: string, e: unknown) => void;
  settleMs?: number;   // 500
  slowMs?: number;     // 2000
  backoffMs?: number;  // 10000
}

interface State {
  timer?: unknown;
  inFlight: boolean;
  pending: boolean;
  /** Earliest time the next call may start (back-off after a slow reply). */
  notBefore: number;
}

/**
 * Pull on change (spec 4.1): wait `settleMs` for activity to settle; one call in flight per
 * Conversation plus one follow-up if a change arrived meanwhile; a reply slower than `slowMs`
 * limits that Conversation to one call per `backoffMs`.
 */
export class Puller {
  private states = new Map<string, State>();
  private disposed = false;
  private readonly settleMs: number;
  private readonly slowMs: number;
  private readonly backoffMs: number;

  constructor(private o: PullOptions) {
    this.settleMs = o.settleMs ?? 500;
    this.slowMs = o.slowMs ?? 2000;
    this.backoffMs = o.backoffMs ?? 10000;
  }

  private st(id: string): State {
    let s = this.states.get(id);
    if (!s) { s = { inFlight: false, pending: false, notBefore: 0 }; this.states.set(id, s); }
    return s;
  }

  /** A tracked file changed. `immediate` (manual Refresh) skips the settle wait and any back-off. */
  notifyChange(id: string, immediate = false): void {
    if (this.disposed) return;
    const s = this.st(id);
    if (s.inFlight) { s.pending = true; return; }
    if (immediate) s.notBefore = 0;
    this.arm(id, s, immediate ? 0 : this.settleMs);
  }

  private arm(id: string, s: State, delay: number): void {
    if (s.timer !== undefined) this.o.clock.clearTimeout(s.timer);
    const wait = Math.max(delay, s.notBefore - this.o.clock.now());
    s.timer = this.o.clock.setTimeout(() => { s.timer = undefined; void this.run(id, s); }, wait);
  }

  private async run(id: string, s: State): Promise<void> {
    if (this.disposed) return;
    if (s.inFlight) { s.pending = true; return; }
    s.inFlight = true;
    s.pending = false;
    const t0 = this.o.clock.now();
    try {
      await this.o.fetch(id);
    } catch (e) {
      try { this.o.onError?.(id, e); } catch { /* swallow */ }
    }
    const took = this.o.clock.now() - t0;
    s.inFlight = false;
    s.notBefore = took > this.slowMs ? t0 + this.backoffMs : 0;
    if (s.pending && !this.disposed) {
      s.pending = false;
      this.arm(id, s, 0);
    }
  }

  cancel(id: string): void {
    const s = this.states.get(id);
    if (s?.timer !== undefined) this.o.clock.clearTimeout(s.timer);
    this.states.delete(id);
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.states.values()) if (s.timer !== undefined) this.o.clock.clearTimeout(s.timer);
    this.states.clear();
  }
}
