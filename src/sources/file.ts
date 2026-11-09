import * as fs from 'node:fs';
import * as path from 'node:path';
import { normaliseModelKey, resolveLimit } from '../limits';
import type { Group, GroupItem, Snapshot } from '../model';
import { decodeGenMetadata, type GenMetadata } from './genMetadata';
import { buildChatItems, computeBaseline } from './items';
import { DbCopier, type OpenDb } from './sqlite';
import { TranscriptParser } from './transcript';

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

  /** Title fallback inputs from the transcript. */
  summary() { return this.parser.summary(); }

  /** Re-read the transcript and db. Throws on transcript failure (caller keeps last good snapshot). */
  update(title: string, base: Pick<Snapshot, 'notSelected' | 'role'>): Snapshot {
    readTranscript(this.parser, this.transcriptPath, this.deps.io);
    this.refreshMeta();
    const s = this.parser.summary();
    const modelDisplay = this.meta?.modelDisplay ?? null;
    const modelKey = normaliseModelKey(modelDisplay);
    const { limit, limitSource } = resolveLimit({
      modelKey,
      override: this.deps.limitOverrides(),
      database: this.meta?.limit ?? null,
      defaultLimit: this.deps.limitDefault(),
    });
    const chatItems = buildChatItems(this.parser.kept);
    const heavyThreshold = limit !== null ? limit * ((this.deps.heavyPercent?.() ?? 5) / 100) : Infinity;
    const chatChildren: GroupItem[] = chatItems.map((ci) => ({
      label: ci.label,
      tokens: ci.tokens,
      step: ci.step,
      kind: ci.kind,
      estimated: true,
      heavy: ci.tokens >= heavyThreshold,
    }));
    const chatTotal = chatChildren.reduce((a, b) => a + b.tokens, 0);
    const baselineTokens = computeBaseline(s.used, chatItems);

    const groups: Group[] = [
      {
        name: 'Baseline',
        tokens: baselineTokens,
        estimated: true,
        children: [],
      },
      {
        name: 'Chat Messages',
        tokens: chatTotal,
        estimated: true,
        children: chatChildren,
      },
    ];

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
      compaction: null,
      modelChanges: [],
      startStepIndex: this.meta?.startStepIndex ?? null,
      notSelected: base.notSelected,
      role: base.role,
    };
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
