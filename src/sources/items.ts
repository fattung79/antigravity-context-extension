export type ContextItemKind =
  | 'user'
  | 'model'
  | 'file-read'
  | 'file-edit'
  | 'command'
  | 'web'
  | 'agent'
  | 'error'
  | 'system'
  | 'compaction'
  | 'section'
  | 'tool';

export interface ChatItem {
  step: number;
  kind: ContextItemKind;
  label: string;
  tokens: number;
  heavy?: boolean;
  /** Tool call position within the PLANNER_RESPONSE, and the paired result step (hover lookup). */
  call?: number;
  resultStep?: number;
}

export interface CompactStep {
  index: number;
  source: string;
  type: string;
  status?: string;
  hasError?: boolean;
  /** Chars of text that sits in the context for this step (user request text, reply/result content, system message). */
  contentLength: number;
  promptPreview?: string;
  /** CHECKPOINT step that starts with `# Resuming from a compaction`. */
  compaction?: boolean;
  /** USER_INPUT whose request is `/compact`. */
  compactCommand?: boolean;
  /** USER_INPUT carrying a `Model Selection` settings change. */
  modelChange?: { from: string; to: string };
  toolCalls?: Array<{
    name: string;
    target: string;
    callChars: number;
  }>;
  tokens?: { input: number; cacheRead: number; output: number };
  createdAt?: string;
}

export function classifyToolKind(toolName: string): ContextItemKind {
  switch (toolName) {
    case 'view_file':
    case 'read_file':
      return 'file-read';
    case 'edit_file':
    case 'replace_file_content':
    case 'write_file':
    case 'write_to_file':
      return 'file-edit';
    case 'run_command':
      return 'command';
    case 'search_web':
    case 'read_url_content':
      return 'web';
    case 'send_message':
    case 'invoke_subagent':
    case 'manage_subagents':
    case 'manage_task':
      return 'agent';
    default:
      return 'command';
  }
}

export function extractTarget(args?: Record<string, unknown>): string {
  if (!args) return '';
  const val =
    args.Path ??
    args.path ??
    args.AbsolutePath ??
    args.Url ??
    args.URL ??
    args.url ??
    args.Query ??
    args.FilePath ??
    args.file ??
    args.CommandLine ??
    args.command ??
    args.query ??
    args.Recipient ??
    args.recipient ??
    args.TypeName ??
    args.Action ??
    '';
  if (typeof val !== 'string') return '';
  const firstLine = val.split('\n')[0]?.trim() ?? '';
  if (firstLine.length > 30) {
    return firstLine.slice(0, 30) + '…';
  }
  return firstLine;
}

export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 3);
}

/** One token-bearing entry: a transcript step (estimated) or a db breakdown entry (exact). */
export interface Unit {
  step: number;
  type: string;
  tokens: number;
}

export interface BuildOptions {
  estimated: boolean;
}

/** Estimated chars in context for one step (reply content + tool_calls JSON, or content). */
export function stepChars(s: CompactStep): number {
  let n = s.contentLength;
  for (const tc of s.toolCalls ?? []) n += tc.callChars;
  return n;
}

/** Estimated units from transcript steps (a Compaction CHECKPOINT keeps its summary size; other CHECKPOINTs are left out). */
export function stepsToUnits(steps: CompactStep[]): Unit[] {
  return steps
    .filter((s) => s.type !== 'CHECKPOINT' || s.compaction)
    .map((s) => ({ step: s.index, type: s.type, tokens: estimateTokens(stepChars(s)) }));
}

function isErr(s?: CompactStep): boolean {
  return Boolean(s && (s.status === 'ERROR' || s.hasError));
}

/** Split `total` across weights, remainder to the first; the sum is preserved. */
export function splitTokens(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  parts[0] = (parts[0] ?? 0) + (total - parts.reduce((a, b) => a + b, 0));
  return parts;
}

/**
 * Chat Messages items from units (in step order). A PLANNER_RESPONSE with k tool calls
 * takes the next k contiguous GENERIC units by position; counts are summed per call.
 * Labels/kinds come from the transcript steps (by index); missing steps fall back to the type.
 */
export function buildItems(units: Unit[], steps: CompactStep[], opts: BuildOptions): ChatItem[] {
  const byIndex = new Map<number, CompactStep>();
  for (const s of steps) byIndex.set(s.index, s);
  const items: ChatItem[] = [];
  const push = (it: ChatItem) => {
    if (opts.estimated && it.tokens === 0 && it.kind !== 'error') return;
    items.push(it);
  };

  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    const s = byIndex.get(u.step);
    const type = s?.type ?? u.type;
    const err = isErr(s);

    if (type === 'USER_INPUT') {
      push({ step: u.step, kind: err ? 'error' : 'user', label: `#${u.step} ${s?.promptPreview || 'User request'}`, tokens: u.tokens });
    } else if (type === 'SYSTEM_MESSAGE') {
      push({ step: u.step, kind: err ? 'error' : 'system', label: `#${u.step} System message`, tokens: u.tokens });
    } else if (type === 'CHECKPOINT') {
      push({ step: u.step, kind: 'compaction', label: `#${u.step} Compaction summary`, tokens: u.tokens });
    } else if (type === 'PLANNER_RESPONSE') {
      const calls = s?.toolCalls ?? [];
      if (calls.length === 0) {
        push({ step: u.step, kind: err ? 'error' : 'model', label: `#${u.step} Model reply`, tokens: u.tokens });
        continue;
      }
      const results: Unit[] = [];
      while (results.length < calls.length) {
        const next = units[i + 1 + results.length];
        if (!next || next.type !== 'GENERIC') break;
        results.push(next);
      }
      const shares = splitTokens(u.tokens, calls.map((c) => c.callChars));
      calls.forEach((tc, j) => {
        const r = results[j];
        const rErr = isErr(byIndex.get(r?.step ?? -1));
        push({
          step: u.step,
          kind: err || rErr ? 'error' : classifyToolKind(tc.name),
          label: `#${u.step} ${tc.name}${tc.target ? ` ${tc.target}` : ''}`,
          tokens: (shares[j] ?? 0) + (r?.tokens ?? 0),
          call: j,
          resultStep: r?.step,
        });
      });
      i += results.length;
    } else {
      push({ step: u.step, kind: err ? 'error' : 'system', label: `#${u.step} ${type === 'GENERIC' ? 'Tool result' : type}`, tokens: u.tokens });
    }
  }
  return items;
}

/** File-mode (estimated) Chat Messages items straight from kept transcript steps. */
export function buildChatItems(steps: CompactStep[]): ChatItem[] {
  return buildItems(stepsToUnits(steps), steps, { estimated: true });
}

export function computeBaseline(used: number | null, chatItems: Pick<ChatItem, 'tokens'>[]): number {
  if (used === null) return 0;
  const chatSum = chatItems.reduce((acc, it) => acc + it.tokens, 0);
  return Math.max(0, used - chatSum);
}

/** Heavy = strictly above `percent` of the Context window. */
export function isHeavy(tokens: number, limit: number | null, percent: number): boolean {
  return limit !== null && limit > 0 && tokens > limit * (percent / 100);
}
