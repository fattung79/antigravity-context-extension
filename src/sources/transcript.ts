/** Incremental parser for transcript_full.jsonl (pure; no fs). */

import { extractTarget, type CompactStep } from './items';

export interface KeptStep extends CompactStep {
  /** First ~200 chars of a user request (for title fallback). */
  prompt?: string;
}

export interface TranscriptSummary {
  used: number | null;
  totals: { input: number; cacheRead: number; output: number; calls: number };
  lastStepIndex: number | null;
  firstPrompt: string | null;
  lastActivity: string | null;
}

const USER_REQUEST = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/;

export function extractUserRequest(content: string): string {
  const m = USER_REQUEST.exec(content);
  return (m ? m[1]! : content).trim();
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function parseLine(line: string): KeptStep | null {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const index = num(r.step_index);
  if (index === null) return null;
  const source = typeof r.source === 'string' ? r.source : '';
  const type = typeof r.type === 'string' ? r.type : '';
  const status = typeof r.status === 'string' ? r.status : undefined;
  const hasError = status === 'ERROR' || Boolean(r.error);
  const contentStr = typeof r.content === 'string' ? r.content : '';
  const contentLength = contentStr.length;

  const step: KeptStep = {
    index,
    source,
    type,
    status,
    hasError,
    contentLength,
  };

  if (typeof r.created_at === 'string') step.createdAt = r.created_at;

  if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
    const input = num(r.input_tokens);
    const cacheRead = num(r.cache_read_tokens);
    const output = num(r.output_tokens);
    if (input !== null && cacheRead !== null) {
      step.tokens = { input, cacheRead, output: output ?? 0 };
    }

    if (Array.isArray(r.tool_calls)) {
      step.toolCalls = r.tool_calls.map((tc) => {
        const item = (tc && typeof tc === 'object') ? tc as { name?: unknown; args?: Record<string, unknown> } : {};
        const name = typeof item.name === 'string' ? item.name : 'tool';
        const target = extractTarget(item.args);
        const callChars = JSON.stringify(tc).length;
        return { name, target, callChars };
      });
    }
  }

  if (type === 'USER_INPUT' && contentStr) {
    // Only the request text counts as context text (labels/sizes only are kept, never the text).
    const req = extractUserRequest(contentStr);
    step.contentLength = req.length;
    step.prompt = req.slice(0, 200);
    step.promptPreview = req.replace(/\s+/g, ' ').slice(0, 40) + (req.length > 40 ? '…' : '');
  }

  return step;
}

export class TranscriptParser {
  /** Bytes consumed so far (never past an unterminated last line). */
  offset = 0;
  kept: KeptStep[] = [];

  reset(): void {
    this.offset = 0;
    this.kept = [];
  }

  /** Feed bytes read from `this.offset`. Returns bytes consumed (up to the last newline). */
  ingest(buf: Uint8Array): number {
    const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const lastNl = b.lastIndexOf(0x0a);
    if (lastNl < 0) return 0;
    const text = b.subarray(0, lastNl + 1).toString('utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const step = parseLine(line);
      if (step) this.push(step);
    }
    this.offset += lastNl + 1;
    return lastNl + 1;
  }

  /** Rewind rule: entry index <= last kept index => drop kept entries with index >= it. */
  push(step: KeptStep): void {
    const last = this.kept[this.kept.length - 1];
    if (last && step.index <= last.index) {
      this.kept = this.kept.filter((k) => k.index < step.index);
    }
    this.kept.push(step);
  }

  summary(): TranscriptSummary {
    const totals = { input: 0, cacheRead: 0, output: 0, calls: 0 };
    let used: number | null = null;
    let firstPrompt: string | null = null;
    for (const k of this.kept) {
      if (k.tokens) {
        // CHECKPOINT and other non-planner steps never carry tokens here.
        used = k.tokens.input + k.tokens.cacheRead;
        totals.input += k.tokens.input;
        totals.cacheRead += k.tokens.cacheRead;
        totals.output += k.tokens.output;
        totals.calls += 1;
      }
      if (firstPrompt === null && k.prompt) firstPrompt = k.prompt;
    }
    const last = this.kept[this.kept.length - 1];
    return {
      used,
      totals,
      lastStepIndex: last ? last.index : null,
      firstPrompt,
      lastActivity: last?.createdAt ?? null,
    };
  }
}
