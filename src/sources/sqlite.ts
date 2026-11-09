import * as fs from 'node:fs';
import * as path from 'node:path';
import { sameStat, statKey, type StatKey } from '../poller';

/** Minimal shape of node:sqlite's DatabaseSync that we use. */
export interface Db {
  prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
  close(): void;
}
export type OpenDb = (file: string) => Db;

/** Load node:sqlite lazily; absence degrades to null (transcript-only). */
export function loadSqlite(): OpenDb | null {
  try {
    // Dynamic require keeps node:sqlite a runtime import (not bundled).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('node:sqlite') as { DatabaseSync: new (f: string) => Db };
    return (file) => new mod.DatabaseSync(file);
  } catch {
    return null;
  }
}

const SUFFIXES = ['', '-wal', '-shm'] as const;

/**
 * Copies <src>(+ -wal/-shm) into destDir/<name>; re-copies only when the .db or
 * -wal mtime/size changed. Originals are only read via copyFile, never opened.
 */
export class DbCopier {
  private seen = new Map<string, { db: StatKey | null; wal: StatKey | null }>();

  constructor(private destDir: string) {}

  /** Returns the copy path, `copied` true when a fresh copy was made, or null if the source is missing. */
  copy(src: string, name: string): { path: string; copied: boolean } | null {
    const db = statKey(src);
    if (!db) return null;
    const wal = statKey(src + '-wal');
    const dest = path.join(this.destDir, name);
    const prev = this.seen.get(name);
    if (prev && sameStat(prev.db, db) && sameStat(prev.wal, wal) && fs.existsSync(dest)) {
      return { path: dest, copied: false };
    }
    fs.mkdirSync(this.destDir, { recursive: true });
    for (const s of SUFFIXES) {
      const from = src + s;
      const to = dest + s;
      if (fs.existsSync(from)) fs.copyFileSync(from, to);
      else fs.rmSync(to, { force: true });
    }
    this.seen.set(name, { db, wal });
    return { path: dest, copied: true };
  }

  /** Forget the cached stat so the next copy() re-copies (e.g. after a broken copy). */
  invalidate(name: string): void {
    this.seen.delete(name);
  }
}
