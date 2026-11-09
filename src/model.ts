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
    const rest = this.state.snapshots.filter((s) => s.role !== 'active');
    this.set({ snapshots: snapshot ? [snapshot, ...rest] : rest });
  }

  onChange(l: Listener): { dispose(): void } {
    this.listeners.add(l);
    return { dispose: () => { this.listeners.delete(l); } };
  }
}
