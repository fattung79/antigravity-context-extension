import { realClock, type Clock } from './sources/rpc/clock';

export interface GroupItem {
  label: string;
  tokens: number;
  step?: number;
  kind?: string;
  estimated?: boolean;
  heavy?: boolean;
}

export interface Group {
  name: string;
  tokens: number;
  estimated?: boolean;
  children: GroupItem[];
}

export interface Snapshot {
  conversationId: string; title: string;
  source: 'rpc' | 'file';
  used: number | null;           // input + cache read; null = n/a
  limit: number | null; limitSource: string;
  modelKey: string | null; modelDisplay: string | null;
  estimate: number | null;       // Antigravity's own estimate (tooltip)
  groups: Group[];               // System Prompt/Tools/Chat Messages, or Baseline + Chat Messages (~est)
  totals: { input: number; cacheRead: number; output: number; calls: number };
  compaction: { count: number; manual: number; lastStep?: number; was?: number } | null;
  modelChanges: { step: number; from: string; to: string }[];
  startStepIndex: number | null;
  truncationReason?: string | null; // rpc only; feeds Compaction (slice 6)
  notSelected: boolean; role: 'active' | 'recent'; expiresAt?: number;
}

export interface StoreState {
  /** True when no configured root exists on this host (no-op guard). */
  noRoot: boolean;
  snapshots: Snapshot[]; // Active first
  /** Set when the last file read failed and the snapshot is a stale one. */
  stale: boolean;
}

export type Listener = (state: StoreState) => void;

/** In-memory store with change events. Views subscribe here only. */
export class Store {
  private state: StoreState = { noRoot: false, snapshots: [], stale: false };
  private listeners = new Set<Listener>();
  /** Recent Conversations: expiry timers live here (spec 6.3). */
  private recents = new Map<string, { expiresAt: number; rankMs: number; handle: unknown }>();
  /** Dropped by expiry: stay out until their rank key moves past the value at drop time. */
  private expired = new Map<string, number>();
  private ticker: unknown;

  constructor(private clock: Clock = realClock, private tickMs = 15_000) {}

  get(): StoreState {
    return this.state;
  }

  active(): Snapshot | undefined {
    return this.state.snapshots.find((s) => s.role === 'active');
  }

  set(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) {
      try { l(this.state); } catch { /* a view must never break the store */ }
    }
  }

  setActive(snapshot: Snapshot | undefined): void {
    if (snapshot) this.cancelRecent(snapshot.conversationId, true);
    const rest = this.state.snapshots.filter((s) => s.role !== 'active' && s.conversationId !== snapshot?.conversationId);
    this.set({ snapshots: snapshot ? [snapshot, ...rest] : rest });
  }

  /** Ids of tracked Recent Conversations, rank order. */
  recentIds(): string[] {
    return [...this.recents.keys()];
  }

  /**
   * Install the ranked Recent list (already capped, Active excluded). New entrants start their expiry
   * timer; those no longer listed (or now Active) lose theirs. Refresh never calls this.
   */
  syncRecent(ranked: { id: string; rankMs: number }[], activeId: string | null, expiryMs: number): void {
    const keep: string[] = [];
    for (const r of ranked) {
      if (r.id === activeId) continue;
      const dropped = this.expired.get(r.id);
      if (dropped !== undefined) {
        if (r.rankMs <= dropped) continue;
        this.expired.delete(r.id);
      }
      keep.push(r.id);
      const cur = this.recents.get(r.id);
      if (cur) { cur.rankMs = r.rankMs; continue; }
      const entry = { expiresAt: this.clock.now() + expiryMs, rankMs: r.rankMs, handle: undefined as unknown };
      entry.handle = this.clock.setTimeout(() => this.expire(r.id), expiryMs);
      this.recents.set(r.id, entry);
    }
    for (const id of [...this.recents.keys()]) if (!keep.includes(id)) this.cancelRecent(id, false);
    this.recents = new Map(keep.map((id) => [id, this.recents.get(id)!]));
    const order = new Map(keep.map((id, i) => [id, i]));
    const active = this.state.snapshots.filter((s) => s.role === 'active');
    const rec = this.state.snapshots.filter((s) => s.role !== 'active' && order.has(s.conversationId));
    rec.sort((a, b) => order.get(a.conversationId)! - order.get(b.conversationId)!);
    this.set({ snapshots: [...active, ...rec] });
    this.armTicker();
  }

  /** Upsert a Recent Conversation's snapshot; ignored unless it is tracked as Recent. */
  setRecent(snapshot: Snapshot): void {
    const r = this.recents.get(snapshot.conversationId);
    if (!r) return;
    const snap: Snapshot = { ...snapshot, role: 'recent', expiresAt: r.expiresAt };
    const order = this.recentIds();
    const others = this.state.snapshots.filter((s) => s.conversationId !== snap.conversationId);
    const active = others.filter((s) => s.role === 'active');
    const rec = [...others.filter((s) => s.role !== 'active'), snap];
    rec.sort((a, b) => order.indexOf(a.conversationId) - order.indexOf(b.conversationId));
    this.set({ snapshots: [...active, ...rec] });
  }

  private cancelRecent(id: string, clearExpired: boolean): void {
    const r = this.recents.get(id);
    if (r) { this.clock.clearTimeout(r.handle); this.recents.delete(id); }
    if (clearExpired) this.expired.delete(id);
  }

  private expire(id: string): void {
    const r = this.recents.get(id);
    if (!r) return;
    this.recents.delete(id);
    this.expired.set(id, r.rankMs);
    this.set({ snapshots: this.state.snapshots.filter((s) => !(s.role === 'recent' && s.conversationId === id)) });
    this.armTicker();
  }

  /** Countdown redraw every 15 s while any Recent is listed. */
  private armTicker(): void {
    if (this.ticker !== undefined) { this.clock.clearTimeout(this.ticker); this.ticker = undefined; }
    if (this.recents.size === 0) return;
    this.ticker = this.clock.setTimeout(() => {
      this.ticker = undefined;
      this.set({});
      this.armTicker();
    }, this.tickMs);
  }

  dispose(): void {
    for (const r of this.recents.values()) this.clock.clearTimeout(r.handle);
    this.recents.clear();
    if (this.ticker !== undefined) this.clock.clearTimeout(this.ticker);
    this.ticker = undefined;
  }

  onChange(l: Listener): { dispose(): void } {
    this.listeners.add(l);
    return { dispose: () => { this.listeners.delete(l); } };
  }
}
