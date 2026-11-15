/**
 * Pure "Open item content" builders and URI codec (no vscode import).
 *
 * Request-snapshot field paths inside a gen_metadata `data` blob (spec 4.2), found 2026-11-09:
 *   .1.16[] = System Prompt section {1 name, 2 text}   (name == breakdown child name, e.g. `identity`)
 *   .1.8[]  = tool definition     {1 name, 2 description, 3 parameters schema (JSON text)}
 *   (.1.1 holds the whole concatenated prompt; it is NOT used, so one section can be shown alone.)
 * Mapping: a breakdown child name is matched to the entry whose field 1 equals it (exact, then
 * case/punctuation-insensitive). First match wins. No match => friendly one-line document.
 *
 * `user_information` is NEVER shown: refused before any text is read, matched on a normalised name
 * (case, spaces, `<>`, `-`, `_` ignored), and any such block is also stripped from other sections.
 */

import { decodeMessage, getAll } from '../protobuf';
import { redact } from '../logger';
import { extractTarget } from '../sources/items';
import { extractUserRequest } from '../sources/transcript';
import { fence, maskSecrets } from './hover';

export const CONTENT_SCHEME = 'context-viewer';

export type ContentRef =
  | { conversationId: string; kind: 'step'; step: number; call?: number; resultStep?: number }
  | { conversationId: string; kind: 'section' | 'tool'; name: string };

export interface UriParts { path: string; query: string }

function safeFile(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'item';
}

/** Encode a ref into URI path + query (path is only a readable tab title). */
export function encodeContentRef(ref: ContentRef): UriParts {
  const q = new URLSearchParams({ c: ref.conversationId, k: ref.kind });
  if (ref.kind === 'step') {
    q.set('s', String(ref.step));
    if (ref.call !== undefined) q.set('call', String(ref.call));
    if (ref.resultStep !== undefined) q.set('r', String(ref.resultStep));
    return { path: `/step-${ref.step}${ref.call !== undefined ? `-call-${ref.call}` : ''}.md`, query: q.toString() };
  }
  q.set('n', ref.name);
  return { path: `/${ref.kind}-${safeFile(ref.name)}.md`, query: q.toString() };
}

/** Inverse of encodeContentRef; null for anything malformed. */
export function decodeContentRef(parts: UriParts): ContentRef | null {
  const q = new URLSearchParams(parts.query);
  const c = q.get('c');
  const k = q.get('k');
  if (!c) return null;
  const int = (v: string | null): number | undefined => (v !== null && /^\d+$/.test(v) ? Number(v) : undefined);
  if (k === 'step') {
    const step = int(q.get('s'));
    if (step === undefined) return null;
    return { conversationId: c, kind: 'step', step, call: int(q.get('call')), resultStep: int(q.get('r')) };
  }
  if (k === 'section' || k === 'tool') {
    const n = q.get('n');
    return n ? { conversationId: c, kind: k, name: n } : null;
  }
  return null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------- step documents

export interface StepDocInput {
  label: string;
  /** Raw transcript lines (null = step missing). */
  line: Record<string, unknown> | null;
  resultLine?: Record<string, unknown> | null;
  call?: number;
  resultStep?: number;
  token?: string;
}

/** One step as Markdown sections, full text (no cut-off), masked with maskSecrets. */
export function buildStepDocument(i: StepDocInput): string {
  const head = `# ${i.label.replace(/\s+/g, ' ').trim()}`;
  if (!i.line) return `${head}\n\nText unavailable (step compacted away or rewound).`;
  const secs: string[] = [];
  const add = (title: string, body: string, asCode = true) => {
    const m = maskSecrets(body, i.token);
    secs.push(`## ${title}\n\n${asCode ? fence(m) : m}`);
  };
  const type = str(i.line.type);
  if (type === 'USER_INPUT') {
    add('User request', extractUserRequest(str(i.line.content)), false);
  } else if (type === 'PLANNER_RESPONSE') {
    const thinking = str(i.line.thinking);
    const content = str(i.line.content);
    const calls = Array.isArray(i.line.tool_calls) ? (i.line.tool_calls as unknown[]) : [];
    if (thinking) add('Thinking', thinking, false);
    if (content) add('Model reply', content, false);
    const picked = i.call !== undefined ? calls.slice(i.call, i.call + 1) : calls;
    picked.forEach((tc) => {
      const o = tc && typeof tc === 'object' ? (tc as { name?: unknown; args?: unknown }) : {};
      const args = (o.args && typeof o.args === 'object' ? o.args : {}) as Record<string, unknown>;
      const target = extractTarget(args);
      add(`Tool call: ${str(o.name) || 'tool'}${target ? ` ${target}` : ''}`, JSON.stringify(args, null, 2));
    });
    if (picked.length > 0) {
      if (i.resultLine) add('Tool result', str(i.resultLine.content));
      else if (i.resultStep !== undefined) secs.push('## Tool result\n\nText unavailable.');
    }
  } else {
    add(type || 'Content', str(i.line.content));
  }
  if (secs.length === 0) secs.push('Text unavailable.');
  return [head, ...secs].join('\n\n');
}

// ---------------------------------------------------------------- section / tool documents

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const FORBIDDEN = 'userinformation';

/** True for any spelling of the account-bearing `user_information` section name. */
export function isForbiddenSection(name: string): boolean {
  return norm(name) === FORBIDDEN;
}

const FORBIDDEN_BLOCK = /<\s*user[_ -]?information\s*>[\s\S]*?(?:<\/\s*user[_ -]?information\s*>|$)/gi;

/** Defence in depth: drop any user_information block that appears inside other text. */
function stripForbidden(text: string): string {
  return text.replace(FORBIDDEN_BLOCK, '[user_information omitted]');
}

function mask(text: string, token?: string): string {
  return redact(maskSecrets(stripForbidden(text), token), token);
}

const utf8 = (b: Uint8Array) => Buffer.from(b).toString('utf8');

interface Entry { name: string; text: string; extra?: string }

function entries(blob: Uint8Array, path: readonly number[], textNum: number, extraNum?: number): Entry[] {
  const out: Entry[] = [];
  for (const f of getAll(blob, path)) {
    if (!f.bytes) continue;
    const fs = decodeMessage(f.bytes);
    const name = fs.find((x) => x.num === 1 && x.bytes);
    if (!name?.bytes) continue;
    const text = fs.find((x) => x.num === textNum && x.bytes);
    const extra = extraNum === undefined ? undefined : fs.find((x) => x.num === extraNum && x.bytes);
    out.push({ name: utf8(name.bytes), text: text?.bytes ? utf8(text.bytes) : '', extra: extra?.bytes ? utf8(extra.bytes) : undefined });
  }
  return out;
}

function pick(list: Entry[], name: string): Entry | undefined {
  return list.find((e) => e.name === name) ?? list.find((e) => norm(e.name) === norm(name));
}

export interface BlobDocInput {
  /** gen_metadata `data` blob, or null when unreadable. */
  blob: Uint8Array | null;
  name: string;
  token?: string;
}

const REFUSED = (name: string) => `# ${name}\n\nThis section is never shown (it can contain account details).`;

function buildBlobDocument(kind: 'section' | 'tool', i: BlobDocInput): string {
  const title = i.name.replace(/\s+/g, ' ').trim() || kind;
  if (kind === 'section' && isForbiddenSection(i.name)) return REFUSED(redact(title));
  if (!i.blob) return `# ${redact(title)}\n\nText unavailable (no request data found for this Conversation).`;
  let list: Entry[];
  try {
    list = kind === 'section' ? entries(i.blob, [1, 16], 2) : entries(i.blob, [1, 8], 2, 3);
  } catch {
    return `# ${redact(title)}\n\nText unavailable (request data could not be parsed).`;
  }
  const e = pick(list, i.name);
  if (!e) return `# ${redact(title)}\n\nText unavailable (not found in the latest request).`;
  // Re-check on the resolved name: aliasing must not route around the refusal.
  if (kind === 'section' && isForbiddenSection(e.name)) return REFUSED(redact(title));
  if (kind === 'section') return `# ${redact(e.name)}\n\n${mask(e.text, i.token)}`;
  const parts = [`# ${redact(e.name)}`, mask(e.text, i.token)];
  if (e.extra) parts.push(`## Parameters\n\n${fence(mask(e.extra, i.token))}`);
  return parts.join('\n\n');
}

/** System Prompt section text from the last gen_metadata blob; refuses `user_information`. */
export function buildSectionDocument(i: BlobDocInput): string {
  return buildBlobDocument('section', i);
}

/** Tool definition (name, description, parameters) from the last gen_metadata blob. */
export function buildToolDocument(i: BlobDocInput): string {
  return buildBlobDocument('tool', i);
}
