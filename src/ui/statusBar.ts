import * as vscode from 'vscode';
import type { Config } from '../config';
import type { StoreState } from '../model';
import { classify, lookupThreshold, type Level } from './classify';
import { EMPTY_LABEL, EMPTY_TOOLTIP, formatLabel, formatTooltip } from './statusBarFormat';

const TEXT: Partial<Record<Level, string>> = { healthy: 'testing.iconPassed', warn: 'charts.yellow' };
const BG: Partial<Record<Level, string>> = { amber: 'statusBarItem.warningBackground', red: 'statusBarItem.errorBackground' };

/** Single Active item with Threshold colours (spec 7.1). */
export class StatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem | undefined;

  constructor(private revealCommand: string, private config: () => Pick<Config, 'threshold' | 'thresholdDefault'>) {}

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
      this.item.backgroundColor = undefined;
      this.item.tooltip = EMPTY_TOOLTIP;
    } else {
      this.item.text = formatLabel(s);
      const cfg = this.config();
      const th = lookupThreshold(s.modelKey, s.limit, cfg);
      const level = classify(s.used, th?.tokens ?? null);
      const text = s.notSelected && level === 'healthy' ? 'disabledForeground' : TEXT[level];
      this.item.color = s.notSelected && !text ? new vscode.ThemeColor('disabledForeground') : text ? new vscode.ThemeColor(text) : undefined;
      const bg = BG[level];
      this.item.backgroundColor = bg ? new vscode.ThemeColor(bg) : undefined;
      const md = new vscode.MarkdownString(formatTooltip(s, state.stale, th));
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
