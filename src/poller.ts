import * as fs from 'node:fs';

export const INTERVALS_MS = {
  conversationFiles: 1500,
  selection: 1000,
  listing: 5000,
} as const;
export const UNFOCUSED_FACTOR = 5;

export interface StatKey { mtimeMs: number; size: number }

export function statKey(p: string, statSync: (p: string) => fs.Stats = fs.statSync): StatKey | null {
  try {
    const s = statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

export function sameStat(a: StatKey | null | undefined, b: StatKey | null | undefined): boolean {
  if (!a || !b) return a === b || (!a && !b);
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export interface Task {
  name: string;
  intervalMs: number;
  run: () => void | Promise<void>;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** Self-rescheduling stat poller; no fs.watch anywhere. Ticks never throw. */
export class Poller {
  private handles = new Map<Task, unknown>();
  private running = false;
  private focused = true;

  constructor(private tasks: Task[], private onError: (name: string, e: unknown) => void, private timers: Timers = realTimers) {}

  start(): void {
    this.running = true;
    for (const t of this.tasks) this.schedule(t, 0);
  }

  setFocused(focused: boolean): void {
    const was = this.focused;
    this.focused = focused;
    if (!this.running || was === focused) return;
    // Catch up at once on focus; otherwise just stretch the next wait.
    for (const t of this.tasks) this.schedule(t, focused ? 0 : this.interval(t));
  }

  /** Run every task now (manual Refresh). */
  async runAll(): Promise<void> {
    for (const t of this.tasks) await this.safeRun(t);
  }

  interval(t: Task): number {
    return this.focused ? t.intervalMs : t.intervalMs * UNFOCUSED_FACTOR;
  }

  dispose(): void {
    this.running = false;
    for (const h of this.handles.values()) this.timers.clearTimeout(h);
    this.handles.clear();
  }

  private schedule(t: Task, delay: number): void {
    const old = this.handles.get(t);
    if (old !== undefined) this.timers.clearTimeout(old);
    this.handles.set(t, this.timers.setTimeout(() => {
      void this.safeRun(t).finally(() => {
        if (this.running) this.schedule(t, this.interval(t));
      });
    }, delay));
  }

  private async safeRun(t: Task): Promise<void> {
    try {
      await t.run();
    } catch (e) {
      try { this.onError(t.name, e); } catch { /* swallow */ }
    }
  }
}
