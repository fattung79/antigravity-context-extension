import type { Group, GroupItem, Snapshot } from '../model';
import { countdownText } from '../recent';
import { formatTokens } from './statusBarFormat';

export interface RenderedItem {
  id: string;
  /** Id of the parent node (undefined for roots); used for reveal. */
  parentId?: string;
  type: 'conversation' | 'group' | 'item';
  label: string;
  description: string;
  tooltip?: string;
  kind?: string;
  tokens?: number;
  estimated?: boolean;
  heavy?: boolean;
  role?: 'active' | 'recent';
  notSelected?: boolean;
  children?: RenderedItem[];
  /** Hover lookup keys (no text is stored). */
  conversationId?: string;
  groupName?: string;
  step?: number;
  call?: number;
  resultStep?: number;
  /** Data source for non-chat hover metadata: `rpc` | `file` | `~est`. */
  sourceLabel?: string;
}

export function formatItemTokens(tokens: number, estimated?: boolean): string {
  const formatted = formatTokens(tokens);
  return estimated ? `~${formatted}` : formatted;
}

export function sortChatItems(items: GroupItem[], largestFirst: boolean): GroupItem[] {
  if (!largestFirst) {
    // Preserve step order
    return [...items].sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
  }
  return [...items].sort((a, b) => b.tokens - a.tokens);
}

/** Sum of Antigravity's own breakdown (exact groups only), or null in ~est mode. */
export function breakdownTotal(snap: Snapshot): number | null {
  if (snap.groups.length === 0 || snap.groups.some((g) => g.estimated)) return null;
  return snap.groups.reduce((a, g) => a + g.tokens, 0);
}

export function buildConversationTooltip(snap: Snapshot): string | undefined {
  const b = breakdownTotal(snap);
  if (b === null || snap.used === null) return undefined;
  return `Gauge ${formatTokens(snap.used)} = billed input + cached tokens of the last call. ` +
    `Groups are Antigravity's own count (${formatTokens(b)}), which differs from billed.`;
}

export function buildConversationDescription(snap: Snapshot, now: number = Date.now()): string {
  const parts: string[] = [];

  if (snap.used !== null && snap.limit !== null && snap.limit > 0) {
    const pct = Math.round((snap.used / snap.limit) * 100);
    parts.push(`${pct}% · ${formatTokens(snap.used)}/${formatTokens(snap.limit)}`);
  } else if (snap.used !== null) {
    parts.push(`${formatTokens(snap.used)} / ?`);
  }

  parts.push(snap.source);

  const b = breakdownTotal(snap);
  if (b !== null) parts.push(`breakdown ${formatTokens(b)} (Antigravity est.)`);

  if (snap.compaction) {
    parts.push('compacted');
  }

  if (snap.notSelected) {
    parts.push('not selected');
  }

  if (snap.role === 'recent' && snap.expiresAt !== undefined) {
    parts.push(countdownText(snap.expiresAt - now));
  }

  return parts.join(' · ');
}

export function buildTreeHierarchy(snapshots: Snapshot[], largestFirst: boolean, now: number = Date.now()): RenderedItem[] {
  return snapshots.map((snap) => {
    const groups: RenderedItem[] = snap.groups.map((g) => {
      let rawChildren = g.children;
      if (g.name === 'Chat Messages') {
        rawChildren = sortChatItems(g.children, largestFirst);
      }

      const children: RenderedItem[] = rawChildren.map((item, idx) => ({
        id: `${snap.conversationId}/${g.name}/${idx}/${item.step ?? ''}/${item.label}`,
        type: 'item',
        label: `${item.label} · ${formatItemTokens(item.tokens, item.estimated)}`,
        description: '',
        kind: item.kind,
        tokens: item.tokens,
        estimated: item.estimated,
        heavy: item.heavy,
        conversationId: snap.conversationId,
        groupName: g.name,
        step: item.step,
        call: item.call,
        resultStep: item.resultStep,
        sourceLabel: item.estimated || g.estimated ? '~est' : snap.source,
      }));

      return {
        id: `${snap.conversationId}/${g.name}`,
        type: 'group',
        label: g.name,
        description: formatItemTokens(g.tokens, g.estimated),
        tokens: g.tokens,
        estimated: g.estimated,
        children,
      };
    });

    for (const g of groups) {
      g.parentId = snap.conversationId;
      for (const c of g.children ?? []) c.parentId = g.id;
    }

    return {
      id: snap.conversationId,
      type: 'conversation',
      label: snap.title,
      description: buildConversationDescription(snap, now),
      tooltip: buildConversationTooltip(snap),
      role: snap.role,
      notSelected: snap.notSelected,
      children: groups,
    };
  });
}
