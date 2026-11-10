import * as vscode from 'vscode';

export const DECORATION_SCHEME = 'context-viewer';

/** Synthetic resourceUri for a tree node; `heavy` is carried in the query. */
export function nodeUri(id: string, heavy: boolean): vscode.Uri {
  return vscode.Uri.from({ scheme: DECORATION_SCHEME, path: '/' + id, query: heavy ? 'heavy' : '' });
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
    if (!isHeavyUri(uri)) return undefined;
    return new vscode.FileDecoration(undefined, 'Heavy item', new vscode.ThemeColor('errorForeground'));
  }

  refresh(): void { this.emitter.fire(undefined); }

  dispose(): void { this.reg.dispose(); this.emitter.dispose(); }
}
