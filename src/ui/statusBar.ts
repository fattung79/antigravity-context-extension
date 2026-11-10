import * as vscode from 'vscode';
import type { Config } from '../config';
import type { Snapshot, StoreState } from '../model';
import { classify, lookupThreshold, type Level } from './classify';
import { EMPTY_LABEL, EMPTY_TOOLTIP, formatActiveLabelMulti, formatLabel, formatRecentLabel, formatTooltip } from './statusBarFormat';

const TEXT: Partial<Record<Level, string>> = { healthy: 'testing.iconPassed', warn: 'charts.yellow' };
const BG: Partial<Record<Level, string>> = { amber: 'statusBarItem.warningBackground', red: 'statusBarItem.errorBackground' };

/** One item per tracked Conversation, Active first (spec 7.1). */
export class StatusBar implements vscode.Disposable {
  private items: vscode.StatusBarItem[] = [];

  constructor(private revealCommand: string, private config: () => Pick<Config, 'threshold' | 'thresholdDefault'>) {}

  private item(i: number): vscode.StatusBarItem {
    let it = this.items[i];
    if (!it) {
      // Higher priority sits further left: Active (100) first, Recent follow with descending priority.
      it = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100 - i);
      it.name = i === 0 ? 'Context Viewer' : `Context Viewer (Recent ${i})`;
      this.items[i] = it;
    }
    return it;
  }

  private trim(n: number): void {
    for (const it of this.items.splice(n)) it.dispose();
  }

  render(state: StoreState): void {
    if (state.noRoot) { // no-op guard: no status bar item at all
      this.trim(0);
      return;
    }
    const snaps = state.snapshots;
    if (snaps.length === 0) {
      this.trim(1);
      const it = this.item(0);
      it.command = this.revealCommand;
      it.text = EMPTY_LABEL;
      it.color = undefined;
      it.backgroundColor = undefined;
      it.tooltip = EMPTY_TOOLTIP;
      it.show();
      return;
    }
    this.trim(snaps.length);
    const multi = snaps.length > 1;
    snaps.forEach((s, i) => this.draw(this.item(i), s, state.stale, multi));
  }

  private draw(it: vscode.StatusBarItem, s: Snapshot, stale: boolean, multi: boolean): void {
    it.command = { command: this.revealCommand, title: 'Reveal Conversation', arguments: [s.conversationId] };
    it.text = s.role === 'recent' ? formatRecentLabel(s) : multi ? formatActiveLabelMulti(s) : formatLabel(s);
    const th = lookupThreshold(s.modelKey, s.limit, this.config());
    const level = classify(s.used, th?.tokens ?? null);
    const text = s.notSelected && level === 'healthy' ? 'disabledForeground' : TEXT[level];
    it.color = s.notSelected && !text ? new vscode.ThemeColor('disabledForeground') : text ? new vscode.ThemeColor(text) : undefined;
    const bg = BG[level];
    it.backgroundColor = bg ? new vscode.ThemeColor(bg) : undefined;
    const md = new vscode.MarkdownString(formatTooltip(s, stale, th));
    md.isTrusted = false;
    md.supportHtml = false;
    it.tooltip = md;
    it.show();
  }

  dispose(): void {
    this.trim(0);
  }
}
