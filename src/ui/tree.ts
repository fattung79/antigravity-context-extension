import * as vscode from 'vscode';
import type { Config } from '../config';
import type { Store, StoreState } from '../model';
import { levelFor, type Level } from './classify';
import { nodeUri } from './decorations';
import { getKnownToken } from '../logger';
import { buildChatHover, buildMetaHover } from './hover';
import {
  buildTreeHierarchy,
  formatItemTokens,
  type RenderedItem,
} from './treeModel';

export interface HoverDeps {
  /** Read one transcript line by step index (null when the step is missing). */
  readStep: (conversationId: string, step: number) => Record<string, unknown> | null;
  hoverChars: () => number;
  token?: () => string | undefined;
}

/** contextValue for items that support Open: chat (one step), section (System Prompt), tool. */
export function openKindOf(e: RenderedItem): 'chat' | 'section' | 'tool' | undefined {
  if (e.type !== 'item') return undefined;
  if (e.groupName === 'Chat Messages' && e.step !== undefined) return 'chat';
  if (e.groupName === 'System Prompt' && e.kind === 'section' && e.name) return 'section';
  if (e.groupName === 'Tools' && e.kind === 'tool' && e.name) return 'tool';
  return undefined;
}

export class ContextInventoryProvider
  implements vscode.TreeDataProvider<RenderedItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<RenderedItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private largestFirst = false;
  private state: StoreState;
  private roots: RenderedItem[] = [];
  private byId = new Map<string, RenderedItem>();

  constructor(
    private store: Store,
    private config: () => Pick<Config, 'thresholdPerModel' | 'threshold' | 'roots'>,
    private hover?: HoverDeps,
  ) {
    this.state = store.get();
    this.rebuild();
    store.onChange((s) => {
      this.state = s;
      this.refresh();
    });
  }

  /** The Active Conversation root, if any (first root). */
  firstRoot(): RenderedItem | undefined { return this.roots[0]; }

  /** A Conversation's root by id (Recent roots are siblings of the Active root). */
  rootFor(id: string): RenderedItem | undefined { return this.roots.find((r) => r.id === id); }

  getParent(element: RenderedItem): RenderedItem | undefined {
    return element.parentId ? this.byId.get(element.parentId) : undefined;
  }

  private rebuild(): void {
    this.roots = buildTreeHierarchy(this.state.snapshots, this.largestFirst, Date.now(), undefined, this.config().roots);
    this.byId.clear();
    const walk = (n: RenderedItem) => { this.byId.set(n.id, n); n.children?.forEach(walk); };
    this.roots.forEach(walk);
  }

  toggleLargestFirst(): boolean {
    this.largestFirst = !this.largestFirst;
    this.refresh();
    return this.largestFirst;
  }

  isLargestFirst(): boolean {
    return this.largestFirst;
  }

  refresh(): void {
    this.rebuild();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: RenderedItem): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      element.type === 'file'
        ? vscode.TreeItemCollapsibleState.None
        : element.type === 'item'
        ? (element.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
        : element.role === 'recent'
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded,
    );

    item.id = element.id;
    item.description = element.description || undefined;
    if (element.tooltip) item.tooltip = element.tooltip;
    let level: Level = 'none';
    if (element.type === 'conversation') {
      const snap = this.state.snapshots.find((x) => x.conversationId === element.id);
      if (snap && !snap.notSelected) level = levelFor(snap, this.config());
    }
    item.resourceUri = element.type === 'file' && element.path
      ? vscode.Uri.file(element.path)
      : nodeUri(element.id, element.heavy === true, level);

    if (element.type === 'conversation') {
      const color = element.notSelected
        ? new vscode.ThemeColor('disabledForeground')
        : undefined;
      item.iconPath = new vscode.ThemeIcon('comment-discussion', color);
      item.contextValue = 'conversation';
    } else if (element.type === 'group') {
      item.contextValue = 'group';
      if (element.label === 'Baseline') {
        item.iconPath = new vscode.ThemeIcon('layers');
      } else if (element.label === 'Chat Messages') {
        item.iconPath = new vscode.ThemeIcon('history');
      } else if (element.label === 'System Prompt') {
        item.iconPath = new vscode.ThemeIcon('gear');
      } else if (element.label === 'Tools') {
        item.iconPath = new vscode.ThemeIcon('tools');
      }
    } else if (element.type === 'file') {
      item.contextValue = element.openable ? 'ruleFile' : 'ruleFileNoOpen';
      if (element.openable) item.command = { command: 'contextViewer.openRuleFile', title: 'Open rule file', arguments: [element] };
    } else {
      const cv = openKindOf(element);
      item.contextValue = cv ?? 'item';
      if (cv === 'chat') item.command = { command: 'contextViewer.openItem', title: 'Open item content', arguments: [element] };
      item.iconPath = this.getKindIcon(element.kind, element.heavy);
    }

    return item;
  }

  /** Lazy hover: text is read from the transcript only when the tooltip is requested. */
  resolveTreeItem(item: vscode.TreeItem, element: RenderedItem): vscode.TreeItem {
    if (element.type !== 'item') return item; // file rows keep their static tooltip
    let md: string;
    if (element.groupName === 'Chat Messages' && element.step !== undefined && element.conversationId && this.hover) {
      const h = this.hover;
      const read = (s: number | undefined) => {
        if (s === undefined) return null;
        try { return h.readStep(element.conversationId!, s); } catch { return null; }
      };
      md = buildChatHover({
        label: element.label,
        step: element.step,
        call: element.call,
        resultStep: element.resultStep,
        line: read(element.step),
        resultLine: read(element.resultStep),
        hoverChars: h.hoverChars(),
        token: (h.token ?? getKnownToken)(),
      });
    } else {
      md = buildMetaHover({ name: element.label, count: element.tokens !== undefined ? formatItemTokens(element.tokens, element.estimated) : undefined, source: element.sourceLabel });
    }
    const ms = new vscode.MarkdownString(md);
    ms.isTrusted = false;
    ms.supportHtml = false;
    item.tooltip = ms;
    return item;
  }

  getChildren(element?: RenderedItem): Thenable<RenderedItem[]> {
    if (!element) return Promise.resolve(this.roots);
    return Promise.resolve(element.children ?? []);
  }

  private getKindIcon(kind?: string, heavy?: boolean): vscode.ThemeIcon {
    const tint = heavy ? new vscode.ThemeColor('errorForeground') : undefined;
    switch (kind) {
      case 'user':
        return new vscode.ThemeIcon('account', tint);
      case 'model':
        return new vscode.ThemeIcon('sparkle', tint);
      case 'file-read':
        return new vscode.ThemeIcon('file-code', tint);
      case 'file-edit':
        return new vscode.ThemeIcon('edit', tint);
      case 'command':
        return new vscode.ThemeIcon('terminal', tint);
      case 'web':
        return new vscode.ThemeIcon('globe', tint);
      case 'agent':
        return new vscode.ThemeIcon('organization', tint);
      case 'error':
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      case 'section':
        return new vscode.ThemeIcon('symbol-namespace', tint);
      case 'tool':
        return new vscode.ThemeIcon('wrench', tint);
      case 'compaction':
        return new vscode.ThemeIcon('archive', tint);
      case 'system':
        return new vscode.ThemeIcon('info', tint);
      default:
        return new vscode.ThemeIcon('circle-outline', tint);
    }
  }
}
