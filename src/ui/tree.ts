import * as vscode from 'vscode';
import type { Store, StoreState } from '../model';
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

  constructor(private store: Store) {
    this.state = store.get();
    store.onChange((s) => {
      this.state = s;
      this.refresh();
    });
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
    item.description = element.description;

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
    if (!element) {
      const roots = buildTreeHierarchy(this.state.snapshots, this.largestFirst);
      return Promise.resolve(roots);
    }
    return Promise.resolve(element.children ?? []);
  }

  private getKindIcon(kind?: string, heavy?: boolean): vscode.ThemeIcon {
    if (heavy) {
      return new vscode.ThemeIcon('flame', new vscode.ThemeColor('errorForeground'));
    }
    switch (kind) {
      case 'user':
        return new vscode.ThemeIcon('account');
      case 'model':
        return new vscode.ThemeIcon('sparkle');
      case 'file-read':
        return new vscode.ThemeIcon('file-code');
      case 'file-edit':
        return new vscode.ThemeIcon('edit');
      case 'command':
        return new vscode.ThemeIcon('terminal');
      case 'web':
        return new vscode.ThemeIcon('globe');
      case 'agent':
        return new vscode.ThemeIcon('organization');
      case 'error':
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      case 'system':
        return new vscode.ThemeIcon('info');
      default:
        return new vscode.ThemeIcon('circle-outline');
    }
  }
}
