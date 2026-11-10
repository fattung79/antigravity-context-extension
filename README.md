# Context Viewer

View-only Token Gauge and Context Inventory for Antigravity Conversations. Personal use; nothing is published. Spec: `docs/spec/context-viewer.md`.

## What it shows

- Status bar: tokens used vs Threshold for the Active Conversation (and Recent ones, up to `maxConversations`), coloured by band.
- Activity bar view "Context Inventory": per-Conversation breakdown (sections, chat messages, tools, rules, skills), Compaction markers, hovers with cut-off text.
- Data comes from this window's language server over loopback (`rpc`), falling back to the transcript and a copy of the SQLite db (`file`).

## Install

```
npm install
npm run build
npm run package        # writes context-viewer-0.1.0.vsix
```

Then in Antigravity / VS Code: Extensions -> `...` -> Install from VSIX, or `antigravity --install-extension context-viewer-0.1.0.vsix`. Needs VS Code engine 1.107+; runs on the workspace side (WSL) where the data roots live. Without a configured root on the host it activates quietly and shows an empty welcome.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `contextViewer.roots` | `["~/.gemini/antigravity/"]` | Data roots to scan |
| `contextViewer.maxConversations` | 3 | Tree roots cap (status bar: Active only) |
| `contextViewer.recentExpiryMinutes` | 3 | Minutes before a Recent Conversation drops |
| `contextViewer.threshold` | `{}` | Per-model Threshold, **in k** (`190` = 190,000) |
| `contextViewer.threshold.default` | 150 | Fallback Threshold, **in k** (`150` = 150,000) |
| `contextViewer.limits` | `{}` | Per-model Context window override, **in tokens** (`256000`) |
| `contextViewer.limits.default` | empty | Last-resort Context window, **in tokens** (`256000`) |
| `contextViewer.heavyItemPercent` | 5 | Highlight chat items above this % of the window |
| `contextViewer.hoverChars` | 2000 | Hover cut-off (head 75%, tail 25%) |
| `contextViewer.logLevel` | `error` | `off` / `error` / `info` / `debug` (applies immediately) |

## Safety

- Read-only: never writes under Antigravity data; SQLite is read from a copy only.
- RPC: loopback only, this window's server only, constant Get/List method allowlist; `GetUserStatus` is never called.
- CSRF token read from `/proc/<pid>/cmdline` (never `environ`), kept in memory, never logged, stored or shown.
- Logs redact the token, emails and account/plan fields; no headers, bodies or blobs are logged.
- Any rpc failure falls back to files; any file failure keeps the last good snapshot marked stale. No webviews, no telemetry.

## Known limits

- Per-rule/per-skill `GetTokenBase` children do not sum to their sections, so only section totals are shown.
- After a forced close, a leftover `language_server` can interleave step sequences in one transcript; the gauge stays right, running totals and tree may not. End leftover servers.
- v1 is Linux/WSL host only for server data; Windows-local windows and plain VS Code get no server data (Later: PowerShell lookup, push updates).
- The `node:sqlite` ExperimentalWarning is expected.
