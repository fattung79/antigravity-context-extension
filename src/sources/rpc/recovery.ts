import type { Clock } from './clock';

/** Retry the lookup after 5 s, 15 s, 30 s, then every 60 s (spec 4.1). */
export const RECOVERY_DELAYS_MS: readonly number[] = [5000, 15000, 30000, 60000];

export function recoveryDelay(attempt: number): number {
  return RECOVERY_DELAYS_MS[Math.min(Math.max(attempt, 0), RECOVERY_DELAYS_MS.length - 1)]!;
}

/** Drives lookup retries. `tryLookup` returns true on success (then the schedule resets). */
export class Recovery {
  private attempt = 0;
  private timer: unknown = undefined;
  private active = false;

  constructor(private clock: Clock, private tryLookup: () => boolean, private onRecovered: () => void) {}

  get running(): boolean { return this.active; }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.attempt = 0;
    this.schedule();
  }

  /** Manual Refresh: lookup now; on failure the schedule restarts from the first delay. */
  retryNow(): boolean {
    this.cancelTimer();
    this.attempt = -1; // a failed run bumps it to 0 => next retry after the first delay (5 s)
    return this.run();
  }

  stop(): void {
    this.active = false;
    this.cancelTimer();
  }

  private schedule(): void {
    this.cancelTimer();
    this.timer = this.clock.setTimeout(() => { this.timer = undefined; this.run(); }, recoveryDelay(this.attempt));
  }

  private run(): boolean {
    let ok = false;
    try { ok = this.tryLookup(); } catch { ok = false; }
    if (ok) {
      this.active = false;
      this.attempt = 0;
      this.onRecovered();
      return true;
    }
    this.active = true;
    this.attempt += 1;
    this.schedule();
    return false;
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
