import * as vscode from 'vscode';
import type { Level } from './classify';

export const DECORATION_SCHEME = 'context-viewer';

/** Synthetic resourceUri for a tree node; `heavy` is carried in the query. */
export function nodeUri(id: string, heavy: boolean, level: Level = 'none'): vscode.Uri {
  const query = heavy ? 'heavy' : TINTED.has(level) ? `level=${level}` : '';
  return vscode.Uri.from({ scheme: DECORATION_SCHEME, path: '/' + id, query });
}

const TINTED = new Set<Level>(['warn', 'amber', 'red']);
const TINT: Record<string, string> = { warn: 'charts.yellow', amber: 'charts.orange', red: 'charts.red' };

/** Threshold level encoded in a node uri (conversation roots), or 'none'. */
export function levelOfUri(uri: { scheme: string; query: string }): Level {
  if (uri.scheme !== DECORATION_SCHEME) return 'none';
  const m = /^level=(warn|amber|red)$/.exec(uri.query);
  return m ? (m[1] as Level) : 'none';
}

export function isHeavyUri(uri: { scheme: string; query: string }): boolean {
  return uri.scheme === DECORATION_SCHEME && uri.query === 'heavy';
}

/** Tints heavy Chat Messages items in the error colour (native trees cannot colour labels otherwise). */
export class HeavyDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private reg = vscode.window.registerFileDecorationProvider(this);

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const lv = levelOfUri(uri);
    if (lv !== 'none') return new vscode.FileDecoration(undefined, 'Threshold', new vscode.ThemeColor(TINT[lv] ?? "charts.red"));
    if (!isHeavyUri(uri)) return undefined;
    return new vscode.FileDecoration(undefined, 'Heavy item', new vscode.ThemeColor('errorForeground'));
  }

  refresh(): void { this.emitter.fire(undefined); }

  dispose(): void { this.reg.dispose(); this.emitter.dispose(); }
}
