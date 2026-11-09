export type ContextItemKind =
  | 'user'
  | 'model'
  | 'file-read'
  | 'file-edit'
  | 'command'
  | 'web'
  | 'agent'
  | 'error'
  | 'system';

export interface ChatItem {
  step: number;
  kind: ContextItemKind;
  label: string;
  tokens: number;
  chars: number;
  heavy?: boolean;
}

export interface CompactStep {
  index: number;
  source: string;
  type: string;
  status?: string;
  hasError?: boolean;
  contentLength: number;
  promptPreview?: string;
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

/**
 * Builds chat items by pairing tool calls with subsequent GENERIC steps in order.
 */
export function buildChatItems(steps: CompactStep[]): ChatItem[] {
  const items: ChatItem[] = [];

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.type === 'CHECKPOINT') continue;

    const isError = s.status === 'ERROR' || s.hasError;

    if (s.type === 'USER_INPUT') {
      const preview = s.promptPreview || 'User request';
      items.push({
        step: s.index,
        kind: isError ? 'error' : 'user',
        label: `#${s.index} ${preview}`,
        tokens: estimateTokens(s.contentLength),
        chars: s.contentLength,
      });
      continue;
    }

    if (s.type === 'SYSTEM_MESSAGE') {
      items.push({
        step: s.index,
        kind: isError ? 'error' : 'system',
        label: `#${s.index} System message`,
        tokens: estimateTokens(s.contentLength),
        chars: s.contentLength,
      });
      continue;
    }

    if (s.source === 'MODEL' && s.type === 'PLANNER_RESPONSE') {
      const toolCalls = s.toolCalls ?? [];

      if (toolCalls.length > 0) {
        let genericIdx = i + 1;
        for (let t = 0; t < toolCalls.length; t++) {
          const tc = toolCalls[t]!;
          let resultChars = 0;
          let resultError = false;

          while (genericIdx < steps.length) {
            const next = steps[genericIdx]!;
            if (next.type === 'GENERIC' || next.source === 'MODEL') {
              resultChars += next.contentLength;
              if (next.status === 'ERROR' || next.hasError) {
                resultError = true;
              }
              genericIdx++;
              break;
            }
            genericIdx++;
          }

          const totalChars = tc.callChars + resultChars;
          const kind = isError || resultError ? 'error' : classifyToolKind(tc.name);
          const labelTarget = tc.target ? ` ${tc.target}` : '';
          items.push({
            step: s.index,
            kind,
            label: `#${s.index} ${tc.name}${labelTarget}`,
            tokens: estimateTokens(totalChars),
            chars: totalChars,
          });
        }
        if (genericIdx > i + 1) {
          i = genericIdx - 1;
        }
      } else if (s.contentLength > 0 || isError) {
        items.push({
          step: s.index,
          kind: isError ? 'error' : 'model',
          label: `#${s.index} Model reply`,
          tokens: estimateTokens(s.contentLength),
          chars: s.contentLength,
        });
      }
    }
  }

  return items;
}

export function computeBaseline(used: number | null, chatItems: ChatItem[]): number {
  if (used === null) return 0;
  const chatSum = chatItems.reduce((acc, it) => acc + it.tokens, 0);
  return Math.max(0, used - chatSum);
}
