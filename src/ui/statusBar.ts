import * as vscode from 'vscode';
import type { StoreState } from '../model';
import { EMPTY_LABEL, EMPTY_TOOLTIP, formatLabel, formatTooltip } from './statusBarFormat';

/** Single Active item (slice 1). No threshold colours yet (slice 4). */
export class StatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem | undefined;

  constructor(private revealCommand: string) {}

  render(state: StoreState): void {
    if (state.noRoot) { // no-op guard: no status bar item at all
      this.item?.dispose();
      this.item = undefined;
      return;
    }
    if (!this.item) {
      this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
      this.item.name = 'Context Viewer';
      this.item.command = this.revealCommand;
    }
    const s = state.snapshots.find((x) => x.role === 'active');
    if (!s) {
      this.item.text = EMPTY_LABEL;
      this.item.color = undefined;
      this.item.tooltip = EMPTY_TOOLTIP;
    } else {
      this.item.text = formatLabel(s);
      this.item.color = s.notSelected ? new vscode.ThemeColor('disabledForeground') : undefined;
      const md = new vscode.MarkdownString(formatTooltip(s, state.stale));
      md.isTrusted = false;
      md.supportHtml = false;
      this.item.tooltip = md;
    }
    this.item.show();
  }

  dispose(): void {
    this.item?.dispose();
    this.item = undefined;
  }
}
