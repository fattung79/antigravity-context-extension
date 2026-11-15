# Extension host under WSL: where it runs, what it can reach

Ticket: wayfinder/context-viewer/04-extension-host-wsl.md. Researched 2026-11-05 on this machine (Windows on ARM host, WSL2 Ubuntu aarch64).

## Installed product (primary: product.json / package.json)
- Install: `C:\Users\<user>\AppData\Local\Programs\Antigravity IDE\` ("Antigravity IDE" 2.6.0, VS Code base 1.107.0, Electron 39.2.3 / Chrome 142; `resources/app/product.json`, `package.json`, strings of the .exe). A second, older install `...\Programs\antigravity\` also exists (Electron-style, `version` file 44.5.1); not used by the current IDE.
- Per-user data is under **`Antigravity IDE`**, not `Antigravity`: `%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb` exists; `%APPDATA%\Antigravity\` does not exist here. The ticket's path is stale.
- Brain roots exist for BOTH product generations: `~/.gemini/antigravity/brain`, `~/.gemini/antigravity-ide/brain`, `C:\Users\<user>\.gemini\antigravity\brain`, `C:\Users\<user>\.gemini\antigravity-ide\brain` (all present, populated). Which one the current IDE writes to for WSL vs Windows workspaces was NOT determined.

## (1) Where does an extension run
- VS Code docs (code.visualstudio.com/api/advanced-topics/remote-extensions): `ui` extensions run in the local (client) extension host; `workspace` extensions run in the remote extension host in the VS Code Server on the workspace machine (WSL here). If an extension declares both, VS Code picks the optimal one. Workspace extensions get Node fs/child_process of the remote machine.
- Antigravity honours the same model. Evidence:
  - `product.json` has `extensionKind` overrides (`["ui"]`, `["ui","workspace"]`) and `extensionPointExtensionKind`, plus `serverApplicationName: antigravity-ide-server`.
  - A real server is installed in WSL at `~/.antigravity-ide-server/` (bin/2.6.0-<commit>, node v22.21.1, extensions/ dir, `data/logs/*/exthost*/remoteexthost.log`). Extension host runs there: log shows `ExtensionService#_doActivateExtension google.google-antigravity` activating in the WSL host.
  - WSL remote is the built-in `antigravity-remote-wsl` extension (derived from open-remote-wsl; `extensionKind: ["ui"]`, proposals `resolvers`, `contribViewsRemote`), so the resolver runs on Windows and starts the server in WSL.
  - Installed in WSL server: claude-code, python, powershell, `n2ns.antigravity-panel` (`extensionKind: ["workspace","ui"]`), claude-context-bar, etc. Third-party extensions with no extensionKind default to workspace in a remote window (VS Code rule; docs do not state a default explicitly, the pattern here matches).
- Consequence: in a WSL window with no `extensionKind`, our extension runs in WSL (Linux, aarch64). With `["ui"]` it runs on Windows. The same extension can run in different hosts in different windows (local window: Windows host; WSL window: WSL host if workspace is preferred).
- `["ui","workspace"]` = prefer UI, fall back to workspace; `["workspace","ui"]` = prefer workspace. In a local (non-remote) window there is only one host (Windows), so both work.

## (2) Reachability
- From WSL host: `/mnt/c/Users/<user>/.gemini/antigravity{,-ide}/brain` and `/mnt/c/Users/<user>/AppData/Roaming/Antigravity IDE/User/globalStorage/state.vscdb` readable (verified by ls; state.vscdb 1 MB, rwx via drvfs). WSL brains are native ext4 (fast, inotify-capable).
- From Windows host: `\\wsl.localhost\Ubuntu\home\<user>\.gemini\antigravity-ide\brain` and `\\wsl$\Ubuntu\...\antigravity\brain` both returned `Test-Path = True` (via powershell.exe). Requires the distro to be running; path needs the distro name (`Ubuntu` here), which a Windows-side extension must discover (e.g. `wsl.exe -l -q`, or a setting).
- So either host can read all roots; each reads its own side natively and the other side over a bridge (9p on WSL; the WSL network redirector on Windows).
- Note: state.vscdb is SQLite on a live DB. Reading from WSL over 9p with SQLite locking is risky; use read-only open (`?mode=ro`/immutable or copy-then-read), not verified here.

## (3) File watching across /mnt/c (empirical)
- `/mnt/c` is mounted `9p` (`aname=drvfs`, `cache=0x5`).
- Test (own temp dir `C:\Users\<user>\AppData\Local\Temp\claude_wtest`, removed after): from WSL node v24.19, `fs.watch(file)`, `fs.watch(dir)` and `fs.watchFile(file, {interval:1000})`; then powershell.exe appended to the file and created a new file in the dir.
- Result: **fs.watch (inotify) on file and dir fired nothing** for the Windows-process changes; **`fs.watchFile` stat polling fired ~1s after the change** (size 14 observed). One attempt, unambiguous; interop works.
- Inference (not separately tested): `vscode.workspace.createFileSystemWatcher` on paths outside the workspace in a remote host uses the same underlying watchers (parcel/inotify on Linux), so it is expected to miss Windows-side writes under /mnt/c too. Prefer plain Node polling.
- Inotify on WSL-native paths (`~/.gemini/...`) is reliable for WSL-side writers. Not tested here; standard Linux behavior. From a Windows host, `fs.watch` (ReadDirectoryChangesW) on `\\wsl.localhost\` is known to be unreliable; not tested.

## (4) Antigravity-specific API
- `out/vscode-dts/vscode.d.ts` adds a namespace `vscode.antigravityExtensibility` (line ~21268): `registerCellExecutionInterceptor`, `sendToAgentPanel({message, files, autoSend})`, `refreshMcpServers`, `writeMcpConfig`, `getMcpConfig`. Also `TabInputJetskiArtifacts` tab input. **No API exposing conversation/agent state or token counts.**
- Bundled `google.google-antigravity` (`extensions/agy`) declares proposals `antigravityInlineCompletions`, `antigravityTabToJump`, `antigravityLanguageServer`, `antigravityUnifiedStateSync` (usable only by allow-listed extensions via `extensionEnabledApiProposals`; none listed for ours). Its registered commands: getUserSettings/setUserSettings, startSnooze/endSnooze, `antigravity.internal.getAuthStatus|loginWithRedirect|logout|getBuildWithGooglePlugins`, generateCommitMessage, completion accept; manifest also lists `antigravity.resetConversationState`, `antigravity.panel.focus`. None returns conversation or token data. So files/db remain the data source.

## (5) Runtime versions
- Windows UI host: Electron 39.2.3 => Node 22.20.0 (`package.json` engines.node 22.20.0; `product.json` target `user`).
- WSL remote host: `~/.antigravity-ide-server/bin/2.6.0-*/node` = **v22.21.1** (run `--version`).
- Both >= 22.13 so `node:sqlite` (DatabaseSync) is available without flag (experimental warning; stability 1.x). Not executed inside the extension host here; fallback is `better-sqlite3`/sql.js, which adds native-binary headaches on aarch64 Linux + Windows ARM.

## Recommendation
- extensionKind: `["workspace", "ui"]`? Trade-off: workspace host in WSL reads WSL brains natively with real inotify but reads Windows brains and state.vscdb over 9p (needs polling); a ui host reads Windows files natively but WSL brains over \\wsl.localhost. Since the activity being watched most (agent runs for WSL workspaces) is likely written to the WSL-side brain, recommend **`["workspace", "ui"]`**: one host per window, which is WSL in WSL windows and Windows in local windows, and every root is a settings entry resolved from whichever host is running. Caveat to confirm: which side's brain the IDE writes for a WSL workspace (see new question).
- Watching: do not rely on `createFileSystemWatcher`/`fs.watch` for any `/mnt/c` or `\\wsl` root. Use per-root strategy: native path => `fs.watch` plus a slow safety poll; cross-boundary path (`/mnt/c/...`) => `fs.stat` polling every 1-2 s of the active transcript file(s) (mtime/size, tail-read on change) plus a slower (5-10 s) directory scan to find new/active conversations. Poll only the Active/Recent conversation files, not the whole tree. state.vscdb: poll mtime, read a copy or read-only.
