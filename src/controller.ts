import * as path from 'node:path';
import type { Config } from './config';
import {
  existingRoots, listConversations, pickExisting, readSelectedId, readSummaries, resolveTitle, selectActive,
  stateDbCandidates, type ConversationInfo, type SummaryRow,
} from './discovery';
import type { RememberedLimits } from './limits';
import type { Logger } from './logger';
import type { Store } from './model';
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
  private source: FileSource | null = null;
  private fileStat: { t: StatKey | null; d: StatKey | null; w: StatKey | null; title: string; ns: boolean } | null = null;
  private forceNext = false;
  private rpc: RpcManager | null = null;
  private puller: Puller | null = null;
  /** Conversations the server could not answer for: file source until Refresh. */
  private fileOnly = new Set<string>();
  private guard = new StaleGuard(2);
  private lastKey: Controller['fileStat'] = null;

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
    this.forceNext = true;
    this.selectionStat = null;
    this.summariesStat = null;
    this.fileOnly.clear();
    this.guard.reset();
    if (this.rpc) {
      const wasUp = this.rpc.up;
      const up = this.rpc.refreshLookup();
      if (up !== wasUp) this.fileStat = null;
    }
    const roots = existingRoots(this.deps.config().roots);
    this.deps.store.set({ noRoot: roots.length === 0 });
    this.deps.onNoRoot?.(roots.length === 0);
    if (roots.length === 0) return;
    await this.poller.runAll();
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
      this.deps.logger.debug(`state.vscdb read failed (retry next poll): ${(e as Error).message}`);
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
    this.recomputeActive();
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
        this.deps.logger.debug(`summaries read failed: ${(e as Error).message}`);
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
      this.source = null;
      this.fileStat = null;
      this.guard.reset();
    }
    this.notSelected = res.notSelected;
  }

  private pollFiles(): void {
    if (this.activeId === null) return;
    const info = this.conversations.find((c) => c.id === this.activeId);
    if (!info) return;
    if (!this.source || this.source.transcriptPath !== info.transcriptPath) {
      const cfg = () => this.deps.config();
      this.source = new FileSource(info.id, info.transcriptPath, info.dbPath, {
        openDb: this.deps.openDb,
        storageDir: this.deps.storageDir,
        limitOverrides: () => cfg().limits,
        limitDefault: () => cfg().limitsDefault,
        remembered: this.deps.remembered,
        heavyPercent: () => cfg().heavyItemPercent,
        onWarn: (m) => this.deps.logger.error(m),
      });
      this.fileStat = null;
    }
    const sum = this.summaries.get(info.id);
    const title = resolveTitle({
      summaryTitle: sum?.title, preview: sum?.preview,
      firstPrompt: this.source.summary().firstPrompt, lastActivity: this.source.summary().lastActivity,
    });
    const key = {
      t: statKey(info.transcriptPath), d: statKey(info.dbPath), w: statKey(info.dbPath + '-wal'),
      title, ns: this.notSelected,
    };
    const prev = this.fileStat;
    const forced = this.forceNext;
    const unchanged = prev && !this.forceNext && sameStat(prev.t, key.t) && sameStat(prev.d, key.d) && sameStat(prev.w, key.w)
      && prev.title === key.title && prev.ns === key.ns;
    if (unchanged) return;
    this.forceNext = false;
    if (this.rpc?.up && !this.fileOnly.has(info.id)) {
      // rpc source: pull on change (settle + single flight handled by the puller).
      this.fileStat = key;
      this.lastKey = key;
      this.puller?.notifyChange(info.id, forced);
      return;
    }
    this.updateFromFile(info, sum, title, key);
  }

  private updateFromFile(info: ConversationInfo, sum: SummaryRow | undefined, title: string, key: NonNullable<Controller['fileStat']>): void {
    if (!this.source) return;
    try {
      const snap = this.source.update(title, { notSelected: this.notSelected, role: 'active' });
      // Title may now come from the transcript's first prompt (after parsing).
      snap.title = resolveTitle({
        summaryTitle: sum?.title, preview: sum?.preview,
        firstPrompt: this.source.summary().firstPrompt, lastActivity: this.source.summary().lastActivity,
      });
      this.fileStat = { ...key, title: snap.title };
      this.deps.store.set({ stale: false });
      this.deps.store.setActive(snap);
    } catch (e) {
      // Keep the last good snapshot, mark stale.
      this.deps.logger.error(`file read failed for ${info.id}: ${(e as Error).message}`);
      this.deps.store.set({ stale: true });
    }
  }

  // ---- rpc -------------------------------------------------------------

  /** rpc went down or came back: re-evaluate the active Conversation from its best source now. */
  private rpcSwitched(): void {
    this.fileStat = null;
    this.guard.reset();
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
    if (!rpc?.up || id !== this.activeId || !this.source) return;
    const info = this.conversations.find((c) => c.id === id);
    if (!info) return;
    const source = this.source;
    let steps: ReturnType<FileSource['readSteps']> = [];
    try { steps = source.readSteps(); } catch (e) { this.deps.logger.debug(`transcript read failed: ${(e as Error).message}`); }

    let meta;
    try {
      meta = parseGeneratorMetadata(await rpc.call('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: id }));
    } catch (e) {
      if (id === this.activeId) this.rpcFailure(id, e);
      return;
    }
    if (id !== this.activeId || this.source !== source) return; // switched while waiting

    const transcriptLast = lastPlannerStep(steps);
    if (!meta) {
      // No usable call for this Conversation: file source. If the transcript already has planner
      // steps the server does not know it => file for this Conversation until Refresh.
      if (transcriptLast !== null) {
        this.fileOnly.add(id);
        this.deps.logger.info(`rpc: no data for ${id}; using file for it`);
      }
      this.guard.reset();
      const title = resolveTitle({
        summaryTitle: this.summaries.get(id)?.title, preview: this.summaries.get(id)?.preview,
        firstPrompt: source.summary().firstPrompt, lastActivity: source.summary().lastActivity,
      });
      this.updateFromFile(info, this.summaries.get(id), title, { ...(this.lastKey ?? { t: null, d: null, w: null, ns: this.notSelected }), title });
      return;
    }
    if (this.guard.check(meta.lastStepIndex, transcriptLast)) {
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
      notSelected: this.notSelected,
      role: 'active',
    });
    this.deps.remembered?.remember(snap.modelKey, meta.maxContextTokens);
    this.deps.store.set({ stale: false });
    this.deps.store.setActive(snap);
  }
}
