/** Pure hover content builder (no vscode): cut-off, masking, fencing. Text is read lazily by the caller. */

import { CSRF_SHAPE } from '../logger';
import { estimateTokens, extractTarget } from '../sources/items';
import { extractUserRequest } from '../sources/transcript';
import { formatTokens } from './statusBarFormat';

export const CSRF_MASK = '‹csrf›';

/** Mask this window's live CSRF token (exact string) and the token-shape regex used by log redaction. */
export function maskSecrets(text: string, token?: string): string {
  let out = text;
  if (token && token.length >= 8) out = out.split(token).join(CSRF_MASK);
  return out.replace(new RegExp(CSRF_SHAPE.source, 'gi'), `$1${CSRF_MASK}`);
}

/** Head 75% + tail 25% of `budget`, with an omitted-chars gap marker. Short text is untouched. */
export function cutHeadTail(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const tail = Math.floor(budget / 4);
  const head = budget - tail;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n… ${omitted} chars omitted …\n${text.slice(text.length - tail)}`;
}

/** Head only, with a trailing marker when cut. */
export function cutHead(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return `${text.slice(0, budget)}\n… ${text.length - budget} chars omitted …`;
}

/** Fence `text` in a code block that cannot be closed from inside (longer fence than any backtick run). */
export function fence(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `${f}\n${text}\n${f}`;
}

/** Escape markdown punctuation in labels (labels may carry file paths or prompt text). */
export function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}\[\]()#+!|<>~])/g, '\\$1');
}

function tok(chars: number): string {
  return `~${formatTokens(estimateTokens(chars))} tok`;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export interface ChatHoverInput {
  label: string;
  step: number;
  call?: number;
  resultStep?: number;
  /** Raw transcript lines (null = step missing). */
  line: Record<string, unknown> | null;
  resultLine?: Record<string, unknown> | null;
  hoverChars: number;
  token?: string;
}

function section(title: string, body: string, hoverChars: number, token: string | undefined, mode: 'ht' | 'h' = 'ht', budget = hoverChars): string {
  const masked = maskSecrets(body, token);
  const cut = mode === 'ht' ? cutHeadTail(masked, budget) : cutHead(masked, budget);
  return `**${escapeMd(title)}** (${tok(body.length)})\n\n${fence(cut)}`;
}

/** Markdown for a Chat Messages item (raw text sits in code fences). */
export function buildChatHover(i: ChatHoverInput): string {
  const head = `**${escapeMd(i.label)}**`;
  if (!i.line) return `${head}\n\ntext unavailable`;
  const type = str(i.line.type);
  const parts: string[] = [head];
  const half = Math.floor(i.hoverChars / 2);

  if (type === 'USER_INPUT') {
    parts.push(section('Message', extractUserRequest(str(i.line.content)), i.hoverChars, i.token));
  } else if (type === 'PLANNER_RESPONSE') {
    const thinking = str(i.line.thinking);
    const content = str(i.line.content);
    const calls = Array.isArray(i.line.tool_calls) ? (i.line.tool_calls as unknown[]) : [];
    const tc = i.call !== undefined ? calls[i.call] : undefined;
    if (tc !== undefined) {
      const args = (tc && typeof tc === 'object' ? (tc as { args?: unknown }).args : undefined) ?? {};
      const name = tc && typeof tc === 'object' ? str((tc as { name?: unknown }).name) || 'tool' : 'tool';
      const target = extractTarget(args as Record<string, unknown>);
      parts.push(section(`Call ${name}${target ? ` ${target}` : ''}`, JSON.stringify(args, null, 2), i.hoverChars, i.token));
      if (i.resultLine) parts.push(section('Result', str(i.resultLine.content), i.hoverChars, i.token));
      else if (i.resultStep !== undefined) parts.push('**Result**\n\ntext unavailable');
    } else if (content) {
      parts.push(section('Reply', content, i.hoverChars, i.token));
    }
    if (thinking) parts.push(section('Thinking', thinking, i.hoverChars, i.token, 'h', half));
  } else {
    parts.push(section('Content', str(i.line.content), i.hoverChars, i.token));
  }
  if (parts.length === 1) parts.push('text unavailable');
  return parts.join('\n\n');
}

export interface MetaHoverInput {
  name: string;
  count?: string;
  source?: string;
}

/** Metadata only (name, count, source): never any System Prompt text. */
export function buildMetaHover(i: MetaHoverInput): string {
  const lines = [`**${escapeMd(i.name)}**`];
  if (i.count) lines.push(`Tokens: ${escapeMd(i.count)}`);
  if (i.source) lines.push(`Source: ${i.source}`);
  return lines.join('\n\n');
}
