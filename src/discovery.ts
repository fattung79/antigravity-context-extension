import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Db, OpenDb } from './sources/sqlite';

export interface ConversationInfo {
  id: string;
  root: string;
  transcriptPath: string;
  dbPath: string;
  /** mtime of transcript_full.jsonl in ms, 0 if unknown. */
  transcriptMtimeMs: number;
}

export interface SummaryRow {
  title: string;
  preview: string;
  workspaceUris: string[];
  lastModifiedMs: number;
  source: string;
}

// ---- 3.1 roots and conversation list -------------------------------------

export function existingRoots(roots: string[], exists: (p: string) => boolean = fs.existsSync): string[] {
  return roots.filter((r) => exists(r));
}

export function listConversations(roots: string[]): ConversationInfo[] {
  const out = new Map<string, ConversationInfo>();
  for (const root of roots) {
    let ids: string[];
    try { ids = fs.readdirSync(path.join(root, 'brain')); } catch { continue; }
    for (const id of ids) {
      const transcriptPath = path.join(root, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
      let mtime: number;
      try { mtime = fs.statSync(transcriptPath).mtimeMs; } catch { continue; }
      const prev = out.get(id);
      if (prev && prev.transcriptMtimeMs >= mtime) continue;
      out.set(id, { id, root, transcriptPath, dbPath: path.join(root, 'conversations', `${id}.db`), transcriptMtimeMs: mtime });
    }
  }
  return [...out.values()];
}

// ---- 3.2 title ------------------------------------------------------------

export function formatHHmm(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface TitleInputs {
  summaryTitle?: string | null;
  preview?: string | null;
  firstPrompt?: string | null;
  lastActivity?: string | null;
}

/** summaries.title > preview > first user prompt (~40 chars) + last-activity HH:mm. */
export function resolveTitle(i: TitleInputs): string {
  const t = i.summaryTitle?.trim();
  if (t) return t;
  const p = i.preview?.trim();
  if (p) return p;
  const prompt = i.firstPrompt?.replace(/\s+/g, ' ').trim();
  if (prompt) {
    const cut = prompt.length > 40 ? prompt.slice(0, 40).trimEnd() + '…' : prompt;
    const hm = formatHHmm(i.lastActivity);
    return hm ? `${cut} (${hm})` : cut;
  }
  return 'Untitled Conversation';
}

// ---- 3.3 Active Conversation ---------------------------------------------

export interface ActiveInput {
  /** string = selected id; null = cleared / nothing selected; undefined = state.vscdb unreadable. */
  selectedId: string | null | undefined;
  prevActiveId: string | null;
  conversations: Pick<ConversationInfo, 'id' | 'transcriptMtimeMs'>[];
  /** Latest-write conversations of this window's folder, from summaries (id -> info). */
  summaries: Map<string, Pick<SummaryRow, 'workspaceUris' | 'lastModifiedMs'>>;
  workspaceUris: string[];
}

export interface ActiveResult { id: string; notSelected: boolean }

function newestTranscript(c: ActiveInput['conversations']): string | null {
  let best: { id: string; m: number } | null = null;
  for (const x of c) if (!best || x.transcriptMtimeMs > best.m) best = { id: x.id, m: x.transcriptMtimeMs };
  return best ? best.id : null;
}

export function selectActive(inp: ActiveInput): ActiveResult | null {
  const known = new Set(inp.conversations.map((c) => c.id));
  if (inp.selectedId === undefined) {
    // state.vscdb unreadable: newest transcript write.
    const id = newestTranscript(inp.conversations);
    return id ? { id, notSelected: false } : null;
  }
  if (typeof inp.selectedId === 'string' && known.has(inp.selectedId)) {
    return { id: inp.selectedId, notSelected: false };
  }
  // Nothing selected (cleared, or another workspace's / not-yet-written chat).
  if (inp.prevActiveId && known.has(inp.prevActiveId)) return { id: inp.prevActiveId, notSelected: true };
  const folders = new Set(inp.workspaceUris.map(normUri));
  let best: { id: string; m: number } | null = null;
  for (const c of inp.conversations) {
    const s = inp.summaries.get(c.id);
    if (!s || !s.workspaceUris.some((u) => folders.has(normUri(u)))) continue;
    const m = Math.max(s.lastModifiedMs, c.transcriptMtimeMs);
    if (!best || m > best.m) best = { id: c.id, m };
  }
  return best ? { id: best.id, notSelected: true } : null;
}

function normUri(u: string): string {
  return u.replace(/\/+$/, '');
}

// ---- state.vscdb (selection) ---------------------------------------------

/** Candidate locations of this window's workspace state.vscdb. */
export function stateDbCandidates(storageUriFsPath: string | undefined, listWindowsUsers: () => string[] = defaultWindowsUsers): string[] {
  if (!storageUriFsPath) return [];
  const hashDir = path.dirname(storageUriFsPath);
  const hash = path.basename(hashDir);
  const out = [path.join(hashDir, 'state.vscdb')];
  for (const userDir of listWindowsUsers()) {
    out.push(path.join(userDir, 'AppData', 'Roaming', 'Antigravity IDE', 'User', 'workspaceStorage', hash, 'state.vscdb'));
  }
  return out;
}

function defaultWindowsUsers(): string[] {
  try {
    return fs.readdirSync('/mnt/c/Users').map((u) => path.join('/mnt/c/Users', u));
  } catch {
    return [];
  }
}

export function pickExisting(cands: string[], exists: (p: string) => boolean = fs.existsSync): string | null {
  return cands.find((c) => exists(c)) ?? null;
}

function findKey(v: unknown, key: string, depth = 0): unknown {
  if (!v || typeof v !== 'object' || depth > 4) return undefined;
  const o = v as Record<string, unknown>;
  if (key in o) return o[key];
  for (const x of Object.values(o)) {
    const r = findKey(x, key, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** Parse the JSON value of ItemTable key google.google-antigravity => lastConversationId or null. */
export function parseSelection(value: unknown): string | null {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (value instanceof Uint8Array) text = Buffer.from(value).toString('utf8');
  else return null;
  let json: unknown;
  try { json = JSON.parse(text); } catch { return null; }
  const id = findKey(json, 'lastConversationId');
  return typeof id === 'string' && id !== '' ? id : null;
}

/** Throws when the copy is broken (e.g. no such table: ItemTable) so the caller retries next poll. */
export function readSelectedId(copyPath: string, open: OpenDb): string | null {
  const db: Db = open(copyPath);
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'google.google-antigravity'").get() as { value?: unknown } | undefined;
    return row ? parseSelection(row.value) : null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// ---- conversation_summaries.db -------------------------------------------

export function readSummaries(copyPath: string, open: OpenDb): Map<string, SummaryRow> {
  const db = open(copyPath);
  try {
    const rows = db.prepare('SELECT conversation_id, title, preview, workspace_uris, last_modified_time, source FROM conversation_summaries').all() as Record<string, unknown>[];
    const out = new Map<string, SummaryRow>();
    for (const r of rows) {
      const id = String(r.conversation_id ?? '');
      if (!id) continue;
      let uris: string[] = [];
      try {
        const j: unknown = JSON.parse(String(r.workspace_uris ?? '[]'));
        if (Array.isArray(j)) uris = j.filter((x): x is string => typeof x === 'string');
      } catch { /* keep empty */ }
      const t = Date.parse(String(r.last_modified_time ?? ''));
      out.set(id, {
        title: String(r.title ?? ''),
        preview: String(r.preview ?? ''),
        workspaceUris: uris,
        lastModifiedMs: Number.isNaN(t) ? 0 : t,
        source: String(r.source ?? ''),
      });
    }
    return out;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}
