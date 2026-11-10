import * as fs from 'node:fs';
import * as path from 'node:path';

// ---- annotations (last_user_view_time) -----------------------------------

/** Parse `last_user_view_time:{seconds:1793165308 nanos:909000000}` to epoch ms, or null. */
export function parseAnnotation(text: string): number | null {
  const m = /last_user_view_time\s*:\s*\{([^}]*)\}/.exec(text);
  if (!m) return null;
  const body = m[1]!;
  const s = /seconds\s*:\s*(\d+)/.exec(body);
  if (!s) return null;
  const n = /nanos\s*:\s*(\d+)/.exec(body);
  return Number(s[1]) * 1000 + Math.floor(Number(n ? n[1] : 0) / 1e6);
}

export interface AnnotationFs {
  list(dir: string): string[];
  mtimeMs(file: string): number | null;
  read(file: string): string;
}

export const realAnnotationFs: AnnotationFs = {
  list: (dir) => { try { return fs.readdirSync(dir); } catch { return []; } },
  mtimeMs: (f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } },
  read: (f) => fs.readFileSync(f, 'utf8'),
};

/** `annotations/*.pbtxt` reader: a file is re-read only when its mtime changed. Read-only. */
export class AnnotationReader {
  private cache = new Map<string, { mtimeMs: number; viewMs: number | null }>();
  /** Files actually read in the last scan (for tests / debug). */
  lastReads = 0;

  constructor(private io: AnnotationFs = realAnnotationFs) {}

  /** Conversation id -> last_user_view_time (ms), across all roots (latest wins). */
  scan(roots: string[]): Map<string, number> {
    const out = new Map<string, number>();
    const seen = new Set<string>();
    this.lastReads = 0;
    for (const root of roots) {
      const dir = path.join(root, 'annotations');
      for (const name of this.io.list(dir)) {
        if (!name.endsWith('.pbtxt')) continue;
        const file = path.join(dir, name);
        const mtime = this.io.mtimeMs(file);
        if (mtime === null) continue;
        seen.add(file);
        let e = this.cache.get(file);
        if (!e || e.mtimeMs !== mtime) {
          let viewMs: number | null = null;
          try { viewMs = parseAnnotation(this.io.read(file)); } catch { /* unreadable: ignore */ }
          this.lastReads++;
          e = { mtimeMs: mtime, viewMs };
          this.cache.set(file, e);
        }
        if (e.viewMs === null) continue;
        const id = name.slice(0, -'.pbtxt'.length);
        const prev = out.get(id);
        if (prev === undefined || e.viewMs > prev) out.set(id, e.viewMs);
      }
    }
    for (const k of [...this.cache.keys()]) if (!seen.has(k)) this.cache.delete(k);
    return out;
  }
}

// ---- ranking -------------------------------------------------------------

export interface RankInput {
  id: string;
  viewMs?: number | null;
  writtenMs?: number | null;
}

export interface Ranked { id: string; rankMs: number }

/** Rank key = later of last seen and last written. Newest first; ties broken by id (stable). */
export function rankRecent(cands: RankInput[], activeId: string | null, maxConversations: number): Ranked[] {
  const n = Math.max(0, Math.floor(maxConversations) - 1);
  return cands
    .filter((c) => c.id !== activeId)
    .map((c) => ({ id: c.id, rankMs: Math.max(c.viewMs ?? 0, c.writtenMs ?? 0) }))
    .filter((c) => c.rankMs > 0)
    .sort((a, b) => b.rankMs - a.rankMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, n);
}

// ---- countdown -----------------------------------------------------------

/** `drops in 3m`, then `drops in <1m` for the last minute. */
export function countdownText(remainingMs: number): string {
  if (remainingMs <= 60_000) return 'drops in <1m';
  return `drops in ${Math.ceil(remainingMs / 60_000)}m`;
}
