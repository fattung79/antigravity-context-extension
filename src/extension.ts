import * as vscode from 'vscode';
import { parseConfig, type Config } from './config';
import { Controller } from './controller';
import { Logger } from './logger';
import { RememberedLimits } from './limits';
import { Store } from './model';
import { readProcTable } from './sources/rpc/processTable';
import { loadSqlite } from './sources/sqlite';
import { HeavyDecorationProvider } from './ui/decorations';
import { StatusBar } from './ui/statusBar';
import { ContextInventoryProvider } from './ui/tree';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Context Viewer');
  const readConfig = (): Config => {
    const c = vscode.workspace.getConfiguration('contextViewer');
    return parseConfig(<T>(key: string, fallback: T) => c.get<T>(key, fallback));
  };
  let config = readConfig();
  const logger = new Logger(channel, config.logLevel);
  const store = new Store();
  const statusBar = new StatusBar('contextViewer.reveal', () => config);
  let controllerRef: Controller | undefined;
  const provider = new ContextInventoryProvider(store, () => config, {
    readStep: (id, step) => controllerRef?.readStep(id, step) ?? null,
    hoverChars: () => config.hoverChars,
  });
  const decorations = new HeavyDecorationProvider();
  const treeView = vscode.window.createTreeView('contextViewer.inventory', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const setLargestFirst = (on: boolean) => { void vscode.commands.executeCommand('setContext', 'contextViewer.largestFirst', on); };
  setLargestFirst(false);

  try {
    const storageDir = (context.globalStorageUri ?? context.storageUri)?.fsPath;
    if (!storageDir) throw new Error('no storage uri');
    const controller = new Controller({
      store,
      logger,
      config: () => config,
      openDb: loadSqlite(),
      storageDir,
      remembered: new RememberedLimits(context.globalState),
      storageUriFsPath: context.storageUri?.fsPath,
      workspaceUris: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString()),
      rpc: process.platform === 'linux'
        ? {
          procs: readProcTable(),
          hostPid: process.pid,
          hostPpid: process.ppid,
          workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
        }
        : undefined,
      onNoRoot: (noRoot) => { void vscode.commands.executeCommand('setContext', 'contextViewer.noRoot', noRoot); },
    });
    controllerRef = controller;

    context.subscriptions.push(
      channel,
      statusBar,
      treeView,
      decorations,
      store.onChange((s) => { statusBar.render(s); decorations.refresh(); }),
      vscode.window.onDidChangeWindowState((e) => controller.setFocused(e.focused)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('contextViewer')) return;
        config = readConfig();
        logger.setLevel(config.logLevel);
        if (e.affectsConfiguration('contextViewer.roots') || e.affectsConfiguration('contextViewer.limits')) controller.configChanged();
        else if (e.affectsConfiguration('contextViewer.maxConversations')) controller.rerank();
        // Threshold/colour settings: redraw only.
        statusBar.render(store.get());
        provider.refresh();
        decorations.refresh();
      }),
      vscode.commands.registerCommand('contextViewer.refresh', () => controller.refresh()),
      vscode.commands.registerCommand('contextViewer.reveal', async (conversationId?: unknown) => {
        await vscode.commands.executeCommand('contextViewer.inventory.focus');
        const root = (typeof conversationId === 'string' ? provider.rootFor(conversationId) : undefined) ?? provider.firstRoot();
        if (root) {
          try { await treeView.reveal(root, { select: false, focus: true, expand: true }); } catch { /* view not ready */ }
        }
      }),
      vscode.commands.registerCommand('contextViewer.toggleLargestFirst', () => setLargestFirst(provider.toggleLargestFirst())),
      vscode.commands.registerCommand('contextViewer.toggleLargestFirst.active', () => setLargestFirst(provider.toggleLargestFirst())),
      vscode.commands.registerCommand('contextViewer.collapseAll', () => vscode.commands.executeCommand('workbench.actions.treeView.contextViewer.inventory.collapseAll')),
      { dispose: () => { controller.dispose(); store.dispose(); } },
    );
    controller.setFocused(vscode.window.state.focused);
    controller.start();
    statusBar.render(store.get());
  } catch (e) {
    logger.error(`activation failed: ${(e as Error).message}`);
    context.subscriptions.push(channel, statusBar, treeView, decorations);
  }
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
