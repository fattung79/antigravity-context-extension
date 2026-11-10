import * as vscode from 'vscode';
import type { Config } from '../config';
import type { Snapshot, StoreState } from '../model';
import { classify, lookupThreshold, type Level } from './classify';
import { EMPTY_LABEL, EMPTY_TOOLTIP, formatLabel, formatTooltip, statusBarSnapshot } from './statusBarFormat';

const BG: Partial<Record<Level, string>> = { amber: 'statusBarItem.warningBackground', red: 'statusBarItem.errorBackground' };

/** A single item for the Active Conversation; Recent ones live in the tree only (spec 7.1). */
export class StatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem | undefined;

  constructor(private revealCommand: string, private config: () => Pick<Config, 'threshold' | 'thresholdDefault'>) {}

  private ensure(): vscode.StatusBarItem {
    if (!this.item) {
      this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
      this.item.name = 'Context Viewer';
    }
    return this.item;
  }

  render(state: StoreState): void {
    if (state.noRoot) { // no-op guard: no status bar item at all
      this.dispose();
      return;
    }
    const it = this.ensure();
    const s = statusBarSnapshot(state.snapshots);
    if (!s) {
      it.command = this.revealCommand;
      it.text = EMPTY_LABEL;
      it.color = undefined;
      it.backgroundColor = undefined;
      it.tooltip = EMPTY_TOOLTIP;
      it.show();
      return;
    }
    this.draw(it, s, state.stale);
  }

  private draw(it: vscode.StatusBarItem, s: Snapshot, stale: boolean): void {
    it.command = { command: this.revealCommand, title: 'Reveal Conversation', arguments: [s.conversationId] };
    const th = lookupThreshold(s.modelKey, s.limit, this.config());
    const level = classify(s.used, th?.tokens ?? null);
    it.text = formatLabel(s, level);
    // Text keeps the theme colour (readable on any status bar); the dot carries the level.
    const bg = BG[level];
    it.backgroundColor = bg ? new vscode.ThemeColor(bg) : undefined;
    it.color = s.notSelected && !bg ? new vscode.ThemeColor('disabledForeground') : undefined;
    const md = new vscode.MarkdownString(formatTooltip(s, stale, th));
    md.isTrusted = false;
    md.supportHtml = false;
    it.tooltip = md;
    it.show();
  }

  dispose(): void {
    this.item?.dispose();
    this.item = undefined;
  }
}
