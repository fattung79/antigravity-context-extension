# Prior art: installed context-monitor extensions (ticket 12)

Read-only inspection of installed folders (2026-11-05). Nothing was run.

## What is actually installed

- `antigravity-context-monitor`: **not installed** anywhere (searched `~/.antigravity-ide-server/extensions/`, `/mnt/c/Users/*/.antigravity-ide/extensions/`, whole-disk name find; `extensions.json` on both sides). The Windows user dir `/mnt/c/Users/WsiAccount` was permission-denied, but the Windows `extensions.json` lists no such extension.
- `n2ns.antigravity-panel` 2.8.2: installed (WSL side), `~/.antigravity-ide-server/extensions/n2ns.antigravity-panel-2.8.2-universal`.
- Also installed, closest to the name: `ezoosk.claude-context-bar` 1.7.0 (MIT). It monitors **Claude Code** `.jsonl` sessions under `~/.claude/projects`, not Antigravity. Only useful as UI inspiration (per-tab status bar item, tooltips with cache_read, colour thresholds).

## n2ns.antigravity-panel 2.8.2

- Licence Apache-2.0; repo https://github.com/n2ns/antigravity-panel; `extensionKind ["workspace","ui"]`; activation `onStartupFinished`; single webview sidebar (`tfa.sidebar`) plus a status bar item (right, priority 100, click opens panel). Minified esbuild bundle (`dist/extension.js`, 195 KB), no native modules.
- Data source for context: **not files**. It finds the Antigravity `language_server*` / `agy` process (`ps`/`wmic`, parses `--csrf_token`, `--extension_server_port`), probes listening ports, then calls Connect-RPC `/exa.language_server_pb.LanguageServerService/...` with header `X-Codeium-Csrf-Token`:
  - `GetAllCascadeTrajectories` -> `trajectorySummaries` (id, `summary` = title, `stepCount`, `lastModifiedTime`, `status`, `trajectoryType`).
  - `GetCascadeTrajectoryGeneratorMetadata {cascadeId}` -> per-LLM-call `chatModel.chatStartMetadata.contextWindowMetadata {maxContextTokens, estimatedTokensUsed, truncationReason}`, `checkpointIndex`, `chatModel.usage {inputTokens, cacheReadTokens}`, `responseModel`.
  - Used = max(estimatedTokensUsed, inputTokens+cacheReadTokens) of the latest call that has maxContextTokens. This matches our gauge formula and gives the real model limit (our "built-in table" may be unnecessary).
  - Compression detection: change in `checkpointIndex` -> notification; warning at `tfa.context.warningThreshold` (80%).
- Active conversation: `pickCurrent` = trajectory (type CASCADE) with newest `lastModifiedTime`. Not selection-aware. One conversation only.
- Cadence: polling via a scheduler; context job has an interval constant (`p=1e4`, probably 10 s; not fully traced), skips the second RPC when `stepCount` unchanged. Quota 90 s default, cache scan 120 s. No `fs.watch` use at all.
- Files it does read: `.gemini/antigravity-ide/{brain,conversations,config}` sizes for its Cache Manager (browse/delete brain tasks). Not tokens, not transcripts. No refs to state.vscdb, annotations, conversation_summaries, stats_cache.
- WSL: explicit support. Detects WSL via `/proc/version`; reads `/etc/resolv.conf` host IP and tries it if 127.0.0.1 fails (changelog: NAT-mode fix, "requests go to the host that answered"). Resolves `.gemini` from `/etc/wsl.conf` automount root, scanning `/mnt/<drive>/Users/*/.gemini`; from Windows side resolves `\\wsl.localhost\<distro>\home`. Runs on the workspace side (changelog 168). aarch64 handled (`language_server_linux_arm`).
- Display: status bar shows quota/cache only (no context gauge); the context is a card in the webview (tokens vs limit, title, model, compression time). No per-item inventory, no Recent Conversations.
- Known breakages (GitHub issues page, only 3 open): auto-reports `no_process` for 2.8.1/2.8.2 (#214, #219, #220), i.e. language-server process detection failing. Intrinsic risk: depends on process listing, CSRF token and undocumented RPC; breaks when Antigravity renames the binary (it already added `agy.exe` in 2.6.0). Issue bodies not fetched.

## Comparison with the destination

| Feature | antigravity-panel | Destination | Gap |
|---|---|---|---|
| Status bar token gauge | No (quota/cache only) | `ctx 62% · 124k/200k` | Full gap |
| Used-token formula | latest call max(estimated, input+cacheRead) | input+cacheRead of latest step | Same idea; panel adds estimatedTokensUsed |
| Model limit | From server (`maxContextTokens`) | Built-in table + overrides | Panel's source is better; verify availability in transcript/db |
| Per-item Context Inventory tree | No | Sidebar tree by kind, `~est` | Full gap |
| Several Conversations | One (newest modified) | Active + 2 recent, timeout | Full gap |
| Active selection detection | No (newest modified) | annotations `last_user_view_time` | Gap |
| Titles | `summary` from RPC | real title else first prompt | Panel has titles |
| Compaction/truncation | Detects via checkpointIndex, `truncationReason` | Open question | Panel is a ready recipe |
| Update method | Polling RPC 10 s | Watch + poll for /mnt/c, few s | Different |
| Data access | Live RPC + process scan + CSRF | Files only, read-only | Different risk profile |
| WSL | Handled (NAT, /mnt scan) | Both brain roots, settings list | Comparable; ours is file based |
| View only | Has auto-accept (CDP), cache delete, commit gen | View only | Panel is far larger than needed |
| Licence | Apache-2.0 | Personal | Fork allowed with notice |

## Verdict

Neither meets the destination. Do not fork: the codebase is a large minified-bundle multi-feature product (quota, auto-accept via CDP, deletion, commit generator) whose only relevant part is ~60 lines. Build from scratch, take ideas:
1. RPC `GetCascadeTrajectoryGeneratorMetadata` exposes `maxContextTokens`, `estimatedTokensUsed`, `truncationReason`, `checkpointIndex`: candidate truth for the gauge and compaction detection (answers part of the "Compaction" open question). Treat as an optional "live" source with file fallback; needs process/CSRF discovery which is fragile (no_process issues).
2. WSL tricks: `/etc/wsl.conf` automount root, `/mnt/*/Users/*/.gemini` scan, NAT host IP from resolv.conf.
3. Skip second RPC when `stepCount` unchanged; compression notification on checkpoint change.
4. `ezoosk.claude-context-bar` for tooltip/threshold colouring only.

Confidence: high on installed-state and code facts; medium on poll interval (p=1e4 inferred) and issue content (titles only).
