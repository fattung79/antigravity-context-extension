import * as vscode from 'vscode';
import { parseConfig, type Config } from './config';
import { Controller } from './controller';
import { Logger } from './logger';
import { Store } from './model';
import { loadSqlite } from './sources/sqlite';
import { StatusBar } from './ui/statusBar';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Context Viewer');
  const readConfig = (): Config => {
    const c = vscode.workspace.getConfiguration('contextViewer');
    return parseConfig(<T>(key: string, fallback: T) => c.get<T>(key, fallback));
  };
  let config = readConfig();
  const logger = new Logger(channel, config.logLevel);
  const store = new Store();
  const statusBar = new StatusBar('contextViewer.reveal');

  try {
    const storageDir = (context.globalStorageUri ?? context.storageUri)?.fsPath;
    if (!storageDir) throw new Error('no storage uri');
    const controller = new Controller({
      store,
      logger,
      config: () => config,
      openDb: loadSqlite(),
      storageDir,
      storageUriFsPath: context.storageUri?.fsPath,
      workspaceUris: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString()),
      onNoRoot: (noRoot) => { void vscode.commands.executeCommand('setContext', 'contextViewer.noRoot', noRoot); },
    });

    context.subscriptions.push(
      channel,
      statusBar,
      store.onChange((s) => statusBar.render(s)),
      vscode.window.onDidChangeWindowState((e) => controller.setFocused(e.focused)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('contextViewer')) return;
        config = readConfig();
        logger.setLevel(config.logLevel);
        if (e.affectsConfiguration('contextViewer.roots') || e.affectsConfiguration('contextViewer.limits')) controller.configChanged();
      }),
      vscode.commands.registerCommand('contextViewer.refresh', () => controller.refresh()),
      vscode.commands.registerCommand('contextViewer.reveal', () => vscode.commands.executeCommand('contextViewer.inventory.focus')),
      { dispose: () => controller.dispose() },
    );
    controller.setFocused(vscode.window.state.focused);
    controller.start();
    statusBar.render(store.get());
  } catch (e) {
    logger.error(`activation failed: ${(e as Error).message}`);
    context.subscriptions.push(channel, statusBar);
  }
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
