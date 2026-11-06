---
id: 04-extension-host-wsl
title: Where does the extension run under WSL, and what can it reach?
labels: [wayfinder:research]
parent: MAP
blocked_by: []
assignee:
status: closed
---

## Question

With Antigravity running on Windows and workspaces opened in WSL: where does the extension run (Windows UI side vs. WSL side, extensionKind), and can it read both brain roots and %APPDATA%\\Antigravity? Does file watching work across /mnt/c, or is polling needed? Is the Antigravity extension API a VS Code fork with any extra namespaces?

## Resolution

- In a WSL window, `workspace` extensions run in the WSL-side server (`~/.antigravity-ide-server`, Node 22.21.1); `ui` ones on Windows (Electron 39.2.3, Node 22.20.0). Antigravity honours `extensionKind` like VS Code. Both Node versions support `node:sqlite`.
- Both hosts can read both brain roots and `%APPDATA%\Antigravity IDE\...\state.vscdb` (note: dir is `Antigravity IDE`, not `Antigravity`); also brain dirs exist under both `antigravity` and `antigravity-ide`.
- Empirical: inotify (`fs.watch`) does NOT fire on `/mnt/c` for Windows-process changes (9p drvfs); stat polling (`fs.watchFile`) does within ~1s. Poll across the boundary.
- No Antigravity API exposes conversation or token state (`vscode.antigravityExtensibility` is MCP/agent-panel send only). Recommended: `extensionKind: ["workspace","ui"]`, native watch plus polling for cross-boundary roots.
- Findings: [docs/research/extension-host-wsl.md](../../docs/research/extension-host-wsl.md)
