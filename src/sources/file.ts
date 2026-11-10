import * as fs from 'node:fs';
import * as path from 'node:path';
import { normaliseModelKey, resolveLimit, type RememberedLimits } from '../limits';
import type { Group, GroupItem, Snapshot } from '../model';
import { decodeGenMetadata, type GenMetadata } from './genMetadata';
import { buildBreakdownGroups } from './breakdown';
import { stepsFrom } from './compaction';
import { buildChatItems, computeBaseline, isHeavy, type CompactStep } from './items';
import { DbCopier, type OpenDb } from './sqlite';
import { TranscriptParser, type KeptStep } from './transcript';

export interface FileIo {
  /** Size in bytes, or null if missing. */
  size(file: string): number | null;
  read(file: string, from: number, to: number): Buffer;
}

export const realFileIo: FileIo = {
  size(file) {
    try { return fs.statSync(file).size; } catch { return null; }
  },
  read(file, from, to) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.max(0, to - from));
      const n = fs.readSync(fd, buf, 0, buf.length, from);
      return buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  },
};

const MAX_CHUNK = 8 * 1024 * 1024;

/** Read new bytes of the transcript into the parser (shrink => reread from the top). */
export function readTranscript(parser: TranscriptParser, file: string, io: FileIo = realFileIo): boolean {
  const size = io.size(file);
  if (size === null) throw new Error('transcript missing');
  if (size < parser.offset) parser.reset();
  let changed = false;
  while (size > parser.offset) {
    const to = Math.min(size, parser.offset + MAX_CHUNK);
    const consumed = parser.ingest(io.read(file, parser.offset, to));
    if (consumed === 0) {
      if (to >= size) break; // partial last line: wait for the rest
      throw new Error('transcript line exceeds chunk size');
    }
    changed = true;
  }
  return changed;
}

/** Read the LAST gen_metadata row from a copy of the conversation db. Never exposes the blob. */
export function readLastGenMetadata(copyPath: string, open: OpenDb): GenMetadata | null {
  const db = open(copyPath);
  try {
    const row = db.prepare('SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1').get() as { data?: Uint8Array } | undefined;
    if (!row?.data) return null;
    return decodeGenMetadata(row.data);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

export interface FileSourceDeps {
  openDb: OpenDb | null;
  storageDir: string;
  io?: FileIo;
  limitOverrides: () => Record<string, number>;
  limitDefault: () => number | null;
  remembered?: RememberedLimits;
  heavyPercent?: () => number;
  onWarn?: (msg: string) => void;
}

/** Per-Conversation file-mode source: transcript (incremental) + optional db metadata. */
export class FileSource {
  private parser = new TranscriptParser();
  private copier: DbCopier;
  private meta: GenMetadata | null = null;

  constructor(readonly conversationId: string, readonly transcriptPath: string, readonly dbPath: string, private deps: FileSourceDeps) {
    this.copier = new DbCopier(deps.storageDir);
  }

  /** Re-read only the transcript (rpc mode: labels + stale check). Throws if it is missing. */
  readSteps(): KeptStep[] {
    readTranscript(this.parser, this.transcriptPath, this.deps.io);
    return this.parser.kept;
  }

  /** Title fallback inputs from the transcript. */
  summary() { return this.parser.summary(); }

  /** Re-read the transcript and db. Throws on transcript failure (caller keeps last good snapshot). */
  update(title: string, base: Pick<Snapshot, 'notSelected' | 'role'>): Snapshot {
    readTranscript(this.parser, this.transcriptPath, this.deps.io);
    this.refreshMeta();
    const s = this.parser.summary();
    const modelDisplay = this.meta?.modelDisplay ?? null;
    const modelKey = normaliseModelKey(modelDisplay);
    this.deps.remembered?.remember(modelKey, this.meta?.limit);
    const { limit, limitSource } = resolveLimit({
      modelKey,
      override: this.deps.limitOverrides(),
      database: this.meta?.limit ?? null,
      remembered: this.deps.remembered?.all(),
      defaultLimit: this.deps.limitDefault(),
    });
    const heavyPercent = this.deps.heavyPercent?.() ?? 5;
    const breakdown = this.meta?.breakdown ?? null;
    // Steps before the last Compaction are gone from the context: db `.1.9.1` wins, else the CHECKPOINT step.
    const startStepIndex = this.meta?.startStepIndex ?? s.lastCheckpoint;
    const groups: Group[] = breakdown
      ? buildBreakdownGroups(breakdown, this.parser.kept, limit, heavyPercent, startStepIndex)
      : this.estimatedGroups(stepsFrom(this.parser.kept, startStepIndex), s.used, limit, heavyPercent);

    return {
      conversationId: this.conversationId,
      title,
      source: 'file',
      used: s.used,
      limit,
      limitSource,
      modelKey,
      modelDisplay,
      estimate: this.meta?.estimate ?? null,
      groups,
      totals: s.totals,
      compaction: s.compaction,
      modelChanges: s.modelChanges,
      startStepIndex,
      notSelected: base.notSelected,
      role: base.role,
    };
  }

  /** File mode without db breakdown: Baseline (~est) + Chat Messages (~est). */
  private estimatedGroups(steps: CompactStep[], used: number | null, limit: number | null, heavyPercent: number): Group[] {
    const chatItems = buildChatItems(steps);
    const children: GroupItem[] = chatItems.map((ci) => ({
      label: ci.label,
      tokens: ci.tokens,
      step: ci.step,
      kind: ci.kind,
      estimated: true,
      heavy: isHeavy(ci.tokens, limit, heavyPercent),
    }));
    return [
      { name: 'Baseline', tokens: computeBaseline(used, chatItems), estimated: true, children: [] },
      { name: 'Chat Messages', tokens: children.reduce((a, b) => a + b.tokens, 0), estimated: true, children },
    ];
  }

  private refreshMeta(): void {
    const open = this.deps.openDb;
    if (!open) return;
    try {
      const name = path.basename(this.dbPath);
      const c = this.copier.copy(this.dbPath, name);
      if (!c) return;
      if (!c.copied && this.meta) return;
      this.meta = readLastGenMetadata(c.path, open);
    } catch (e) {
      // Keep the previous metadata; retry on the next change.
      this.copier.invalidate(path.basename(this.dbPath));
      this.deps.onWarn?.(`db read failed for ${this.conversationId}: ${(e as Error).message}`);
    }
  }
}
