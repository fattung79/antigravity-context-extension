import * as vscode from 'vscode';
import type { Config } from '../config';
import type { Store, StoreState } from '../model';
import { levelFor, type Level } from './classify';
import { nodeUri } from './decorations';
import {
  buildTreeHierarchy,
  type RenderedItem,
} from './treeModel';

export class ContextInventoryProvider
  implements vscode.TreeDataProvider<RenderedItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<RenderedItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private largestFirst = false;
  private state: StoreState;
  private roots: RenderedItem[] = [];
  private byId = new Map<string, RenderedItem>();

  constructor(private store: Store, private config: () => Pick<Config, 'threshold' | 'thresholdDefault'>) {
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
    this.roots = buildTreeHierarchy(this.state.snapshots, this.largestFirst);
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
      element.type === 'item'
        ? vscode.TreeItemCollapsibleState.None
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
    item.resourceUri = nodeUri(element.id, element.heavy === true, level);

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
    } else {
      item.contextValue = 'item';
      item.iconPath = this.getKindIcon(element.kind, element.heavy);
    }

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
