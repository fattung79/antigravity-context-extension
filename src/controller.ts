import * as path from 'node:path';
import type { Config } from './config';
import {
  existingRoots, listConversations, pickExisting, readSelectedId, readSummaries, resolveTitle, selectActive,
  stateDbCandidates, type ConversationInfo, type SummaryRow,
} from './discovery';
import type { RememberedLimits } from './limits';
import type { Logger } from './logger';
import type { Snapshot, Store } from './model';
import { INTERVALS_MS, Poller, sameStat, statKey, type StatKey, type Task } from './poller';
import { FileSource } from './sources/file';
import { RpcError } from './sources/rpc/client';
import type { Clock } from './sources/rpc/clock';
import { RpcManager } from './sources/rpc/manager';
import type { ProcessTable } from './sources/rpc/processTable';
import { Puller } from './sources/rpc/puller';
import { buildRpcSnapshot, lastPlannerStep, parseGeneratorMetadata } from './sources/rpc/reply';
import { StaleGuard } from './sources/rpc/staleGuard';
import { DbCopier, type OpenDb } from './sources/sqlite';
import { AnnotationReader, rankRecent } from './recent';

type FileKey = { t: StatKey | null; d: StatKey | null; w: StatKey | null; title: string; ns: boolean; role: 'active' | 'recent' };

/** Per tracked Conversation (Active or Recent): own FileSource, change key and stale guard. */
interface Track {
  source: FileSource | null;
  fileStat: FileKey | null;
  lastKey: FileKey | null;
  force: boolean;
  guard: StaleGuard;
}

export interface ControllerDeps {
  store: Store;
  logger: Logger;
  config: () => Config;
  openDb: OpenDb | null;
  /** Extension storage dir for DB copies. */
  storageDir: string;
  storageUriFsPath: string | undefined;
  workspaceUris: string[];
  /** Hook for a window title when the transcript is unreadable etc. */
  onNoRoot?: (noRoot: boolean) => void;
  /** Persisted limits seen from server/database. */
  remembered?: RememberedLimits;
  /** rpc source inputs; absent => file mode only. */
  rpc?: {
    procs: ProcessTable;
    hostPid: number;
    hostPpid: number;
    workspaceFolders: string[];
    transport?: import('./sources/rpc/client').Transport;
    clock?: Clock;
  };
}

/** Wires discovery + file source + store, driven by the stat poller. Never throws into the host. */
export class Controller {
  private poller: Poller;
  private copier: DbCopier;
  private conversations: ConversationInfo[] = [];
  private summaries = new Map<string, SummaryRow>();
  private summariesStat: StatKey | null = null;
  private summariesRoot: string | null = null;
  private selectedId: string | null | undefined = undefined;
  private selectionStat: { db: StatKey | null; wal: StatKey | null } | null = null;
  private activeId: string | null = null;
  private notSelected = false;
  private tracks = new Map<string, Track>();
  private annotations = new AnnotationReader();
  private views = new Map<string, number>();
  private rpc: RpcManager | null = null;
  private puller: Puller | null = null;
  /** Conversations the server could not answer for: file source until Refresh. */
  private fileOnly = new Set<string>();

  constructor(private deps: ControllerDeps) {
    this.copier = new DbCopier(deps.storageDir);
    const tasks: Task[] = [
      { name: 'selection', intervalMs: INTERVALS_MS.selection, run: () => this.pollSelection() },
      { name: 'listing', intervalMs: INTERVALS_MS.listing, run: () => this.pollListing() },
      { name: 'files', intervalMs: INTERVALS_MS.conversationFiles, run: () => this.pollFiles() },
    ];
    if (deps.rpc) {
      const r = deps.rpc;
      this.rpc = new RpcManager({
        procs: r.procs, transport: r.transport, clock: r.clock, hostPid: r.hostPid, hostPpid: r.hostPpid,
        workspaceFolders: () => r.workspaceFolders,
        info: (m) => deps.logger.info(m),
        debug: (m) => deps.logger.debug(m),
        onRecovered: () => this.rpcSwitched(),
      });
      this.puller = new Puller({
        clock: r.clock ?? { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
        fetch: (id) => this.pullRpc(id),
        onError: (id, e) => deps.logger.error(`rpc pull failed for ${id}: ${(e as Error).message}`),
      });
    }
    this.poller = new Poller(tasks, (name, e) => this.deps.logger.error(`poll ${name} failed: ${(e as Error).message}`));
  }

  start(): void {
    const roots = existingRoots(this.deps.config().roots);
    this.deps.store.set({ noRoot: roots.length === 0 });
    this.deps.onNoRoot?.(roots.length === 0);
    if (roots.length === 0) return; // no-op guard: stay quiet
    this.rpc?.start();
    this.poller.start();
  }

  setFocused(f: boolean): void { this.poller.setFocused(f); }

  /** Manual Refresh: ignore the "only when changed" checks. */
  async refresh(): Promise<void> {
    for (const t of this.tracks.values()) { t.force = true; t.guard.reset(); }
    this.selectionStat = null;
    this.summariesStat = null;
    this.fileOnly.clear();
    if (this.rpc) {
      const wasUp = this.rpc.up;
      const up = this.rpc.refreshLookup();
      if (up !== wasUp) for (const t of this.tracks.values()) t.fileStat = null;
    }
    const roots = existingRoots(this.deps.config().roots);
    this.deps.store.set({ noRoot: roots.length === 0 });
    this.deps.onNoRoot?.(roots.length === 0);
    if (roots.length === 0) return;
    await this.poller.runAll();
  }

  /** `maxConversations` changed: re-rank Recent now (no rescan, expiry timers untouched). */
  rerank(): void {
    const cfg = this.deps.config();
    const cands = this.conversations.map((c) => ({
      id: c.id,
      viewMs: this.views.get(c.id),
      // Without a summaries db, fall back to the transcript's last write.
      writtenMs: this.summaries.get(c.id)?.lastModifiedMs ?? (this.summaries.size === 0 ? c.transcriptMtimeMs : undefined),
    }));
    this.deps.store.syncRecent(rankRecent(cands, this.activeId, cfg.maxConversations), this.activeId, cfg.recentExpiryMinutes * 60_000);
  }

  /** Config change affecting roots/limits: rescan now. */
  configChanged(): void {
    void this.refresh();
  }

  dispose(): void { this.poller.dispose(); this.puller?.dispose(); this.rpc?.dispose(); }

  // ---- tasks -----------------------------------------------------------

  private roots(): string[] { return existingRoots(this.deps.config().roots); }

  private pollSelection(): void {
    const cands = stateDbCandidates(this.deps.storageUriFsPath);
    const file = pickExisting(cands);
    if (!file || !this.deps.openDb) {
      this.setSelected(undefined);
      return;
    }
    const key = { db: statKey(file), wal: statKey(file + '-wal') };
    if (this.selectionStat && sameStat(this.selectionStat.db, key.db) && sameStat(this.selectionStat.wal, key.wal)) return;
    const name = 'state.vscdb';
    try {
      const c = this.copier.copy(file, name);
      if (!c) { this.setSelected(undefined); return; }
      this.setSelected(readSelectedId(c.path, this.deps.openDb));
      this.selectionStat = key; // only remember on success; broken copies retry next poll
    } catch (e) {
      this.copier.invalidate(name);
      this.deps.logger.info(`state.vscdb copy/open failed (retry next poll): ${(e as Error).message}`);
      this.setSelected(undefined);
    }
  }

  private setSelected(id: string | null | undefined): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.recomputeActive();
  }

  private pollListing(): void {
    const roots = this.roots();
    this.conversations = listConversations(roots);
    this.refreshSummaries(roots);
    this.views = this.annotations.scan(roots);
    this.recomputeActive();
    this.rerank();
  }

  private refreshSummaries(roots: string[]): void {
    if (!this.deps.openDb) return;
    // Use the first root's summaries db (default config has one live root).
    for (const root of roots) {
      const src = path.join(root, 'conversation_summaries.db');
      const k = statKey(src);
      if (!k) continue;
      const wal = statKey(src + '-wal');
      const combined: StatKey = { mtimeMs: Math.max(k.mtimeMs, wal?.mtimeMs ?? 0), size: k.size + (wal?.size ?? 0) };
      if (this.summariesRoot === root && sameStat(this.summariesStat, combined)) return;
      try {
        const c = this.copier.copy(src, 'conversation_summaries.db');
        if (!c) continue;
        this.summaries = readSummaries(c.path, this.deps.openDb);
        this.summariesStat = combined;
        this.summariesRoot = root;
      } catch (e) {
        this.copier.invalidate('conversation_summaries.db');
        this.deps.logger.info(`summaries db copy/open failed: ${(e as Error).message}`);
      }
      return;
    }
  }

  private recomputeActive(): void {
    const res = selectActive({
      selectedId: this.selectedId,
      prevActiveId: this.activeId,
      conversations: this.conversations,
      summaries: this.summaries,
      workspaceUris: this.deps.workspaceUris,
    });
    if (!res) {
      if (this.activeId !== null) return; // keep showing the last Active
      this.deps.store.setActive(undefined);
      return;
    }
    if (res.id !== this.activeId) {
      this.activeId = res.id;
      const t = this.tracks.get(res.id);
      if (t) { t.fileStat = null; t.guard.reset(); }
      this.notSelected = res.notSelected;
      this.rerank(); // the new Active leaves Recent (cancels its timer); the old one may enter it
      return;
    }
    this.notSelected = res.notSelected;
  }

  /** Lazy hover read: one transcript line by step index, for any tracked Conversation. */
  readStep(conversationId: string, step: number): Record<string, unknown> | null {
    return this.tracks.get(conversationId)?.source?.readStepLine(step) ?? null;
  }

  private pollFiles(): void {
    const ids = [...(this.activeId !== null ? [this.activeId] : []), ...this.deps.store.recentIds()];
    for (const id of [...this.tracks.keys()]) {
      if (!ids.includes(id)) { this.tracks.delete(id); this.puller?.cancel(id); }
    }
    for (const id of ids) {
      try { this.pollOne(id); } catch (e) { this.deps.logger.error(`poll ${id} failed: ${(e as Error).message}`); }
    }
  }

  private roleOf(id: string): 'active' | 'recent' { return id === this.activeId ? 'active' : 'recent'; }

  private pollOne(id: string): void {
    const info = this.conversations.find((c) => c.id === id);
    if (!info) return;
    let tr = this.tracks.get(id);
    if (!tr) { tr = { source: null, fileStat: null, lastKey: null, force: false, guard: new StaleGuard(2) }; this.tracks.set(id, tr); }
    if (!tr.source || tr.source.transcriptPath !== info.transcriptPath) {
      const cfg = () => this.deps.config();
      tr.source = new FileSource(info.id, info.transcriptPath, info.dbPath, {
        openDb: this.deps.openDb,
        storageDir: this.deps.storageDir,
        limitOverrides: () => cfg().limits,
        limitDefault: () => cfg().limitsDefault,
        remembered: this.deps.remembered,
        heavyPercent: () => cfg().heavyItemPercent,
        onWarn: (m) => this.deps.logger.error(m),
      });
      tr.fileStat = null;
    }
    const role = this.roleOf(id);
    const ns = role === 'active' && this.notSelected;
    const sum = this.summaries.get(info.id);
    const title = resolveTitle({
      summaryTitle: sum?.title, preview: sum?.preview,
      firstPrompt: tr.source.summary().firstPrompt, lastActivity: tr.source.summary().lastActivity,
    });
    const key: FileKey = {
      t: statKey(info.transcriptPath), d: statKey(info.dbPath), w: statKey(info.dbPath + '-wal'),
      title, ns, role,
    };
    const prev = tr.fileStat;
    const forced = tr.force;
    const unchanged = prev && !forced && sameStat(prev.t, key.t) && sameStat(prev.d, key.d) && sameStat(prev.w, key.w)
      && prev.title === key.title && prev.ns === key.ns && prev.role === key.role;
    if (unchanged) return;
    this.deps.logger.debug(`poll hit: ${info.id} changed${forced ? ' (forced)' : ''}`);
    tr.force = false;
    if (this.rpc?.up && !this.fileOnly.has(info.id)) {
      // rpc source: pull on change (settle + single flight handled by the puller).
      tr.fileStat = key;
      tr.lastKey = key;
      this.puller?.notifyChange(info.id, forced);
      return;
    }
    this.updateFromFile(info, sum, title, key);
  }

  private publish(snap: Snapshot): void {
    if (snap.role === 'active') this.deps.store.setActive(snap);
    else this.deps.store.setRecent(snap);
  }

  private updateFromFile(info: ConversationInfo, sum: SummaryRow | undefined, title: string, key: FileKey): void {
    const tr = this.tracks.get(info.id);
    if (!tr?.source) return;
    const role = this.roleOf(info.id);
    try {
      const snap = tr.source.update(title, { notSelected: role === 'active' && this.notSelected, role });
      // Title may now come from the transcript's first prompt (after parsing).
      snap.title = resolveTitle({
        summaryTitle: sum?.title, preview: sum?.preview,
        firstPrompt: tr.source.summary().firstPrompt, lastActivity: tr.source.summary().lastActivity,
      });
      tr.fileStat = { ...key, title: snap.title, role };
      if (role === 'active') this.deps.store.set({ stale: false });
      this.publish(snap);
    } catch (e) {
      // Keep the last good snapshot, mark stale.
      this.deps.logger.error(`file read failed for ${info.id}: ${(e as Error).message}`);
      if (role === 'active') this.deps.store.set({ stale: true });
    }
  }

  // ---- rpc -------------------------------------------------------------

  /** rpc went down or came back: re-evaluate the active Conversation from its best source now. */
  private rpcSwitched(): void {
    for (const t of this.tracks.values()) { t.fileStat = null; t.guard.reset(); }
    this.pollFiles();
  }

  private rpcFailure(id: string, e: unknown): void {
    const err = e instanceof RpcError ? e : null;
    if (!err || err.kind === 'auth' || err.kind === 'connection') {
      this.rpc?.fail(err ? `${err.kind} failure (${err.message})` : 'unexpected failure');
    } else {
      // The server cannot return this Conversation's details: file for that Conversation only.
      this.fileOnly.add(id);
      this.deps.logger.info(`rpc: ${err.message}; using file for ${id}`);
    }
    this.rpcSwitched();
  }

  private async pullRpc(id: string): Promise<void> {
    const rpc = this.rpc;
    const tr = this.tracks.get(id);
    if (!rpc?.up || !tr?.source) return;
    const info = this.conversations.find((c) => c.id === id);
    if (!info) return;
    const source = tr.source;
    let steps: ReturnType<FileSource['readSteps']> = [];
    try { steps = source.readSteps(); } catch (e) { this.deps.logger.debug(`transcript read failed: ${(e as Error).message}`); }

    let meta;
    try {
      // One server answers for any Conversation (spec 13), so Recent ones use it too.
      meta = parseGeneratorMetadata(await rpc.call('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: id }));
    } catch (e) {
      if (this.tracks.get(id) === tr) this.rpcFailure(id, e);
      return;
    }
    if (this.tracks.get(id) !== tr || tr.source !== source) return; // dropped/switched while waiting
    const role = this.roleOf(id);
    const notSelected = role === 'active' && this.notSelected;

    const transcriptLast = lastPlannerStep(steps);
    if (!meta) {
      // No usable call for this Conversation: file source. If the transcript already has planner
      // steps the server does not know it => file for this Conversation until Refresh.
      if (transcriptLast !== null) {
        this.fileOnly.add(id);
        this.deps.logger.info(`rpc: no data for ${id}; using file for it`);
      }
      tr.guard.reset();
      const title = resolveTitle({
        summaryTitle: this.summaries.get(id)?.title, preview: this.summaries.get(id)?.preview,
        firstPrompt: source.summary().firstPrompt, lastActivity: source.summary().lastActivity,
      });
      this.updateFromFile(info, this.summaries.get(id), title, { ...(tr.lastKey ?? { t: null, d: null, w: null, ns: notSelected, role }), title });
      return;
    }
    if (tr.guard.check(meta.lastStepIndex, transcriptLast)) {
      this.rpc?.fail('server stale (trails the transcript)');
      this.rpcSwitched();
      return;
    }
    const sum = this.summaries.get(id);
    const titleOf = () => resolveTitle({
      summaryTitle: sum?.title, preview: sum?.preview,
      firstPrompt: source.summary().firstPrompt, lastActivity: source.summary().lastActivity,
    });
    const cfg = this.deps.config();
    const snap = buildRpcSnapshot(meta, {
      conversationId: id,
      title: titleOf(),
      steps,
      limitOverrides: cfg.limits,
      limitDefault: cfg.limitsDefault,
      remembered: this.deps.remembered?.all(),
      heavyPercent: cfg.heavyItemPercent,
      notSelected,
      role,
    });
    this.deps.remembered?.remember(snap.modelKey, meta.maxContextTokens);
    if (role === 'active') this.deps.store.set({ stale: false });
    this.publish(snap);
  }
}
