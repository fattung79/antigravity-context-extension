# Antigravity Context Viewer

View-only Token Gauge and Context Inventory for Antigravity Conversations.

## What it shows

- **Status bar Token Gauge**: tokens used vs context limit for the Active Conversation, coloured by traffic-light Threshold band (`🟢` ≤ 50%, `🟡` > 50%, `🟠` > 80%, `🔴` > 100%). Click to reveal the Active Conversation in the sidebar.
- **Activity bar view "Context Inventory"**: per-Conversation breakdown for the Active Conversation and Recent Conversations (up to `maxConversations`) — System Prompt sections, rule files (`Memory`), Tools, Chat Messages, Compaction checkpoints, and hover previews with cut-off text.
- **Inspect & Sort**: open any chat message, System Prompt section, or Tool in a read-only viewer (or open rule files directly on disk), and toggle Chat Messages between **Step Order** and **Largest First**.
- **Dual data source**: queries this window's language server over loopback (`rpc`), falling back automatically to the transcript and a read-only copy of the SQLite db (`file`).

## Install

### From the Extensions Marketplace

Search for **Antigravity Context Viewer** (`fattung79.antigravity-context-viewer`) in the Extensions view in Antigravity or VS Code, or install from the CLI:

```sh
# Antigravity
antigravity --install-extension fattung79.antigravity-context-viewer

# VS Code
code --install-extension fattung79.antigravity-context-viewer
```

### From VSIX / Source

```sh
npm install
npm run build
npm run package        # writes antigravity-context-viewer-0.1.0.vsix
```

Then in Antigravity / VS Code: **Extensions** → `...` → **Install from VSIX...**, or run:

```sh
antigravity --install-extension antigravity-context-viewer-0.1.0.vsix
```

Requires VS Code engine 1.107+; runs on the workspace side (WSL/Linux) where the data roots live. Without a configured root on the host it activates quietly and shows an empty welcome.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `contextViewer.roots` | `["~/.gemini/antigravity/"]` | Data roots to scan |
| `contextViewer.maxConversations` | 3 | Tree roots cap (status bar: Active only) |
| `contextViewer.recentExpiryMinutes` | 3 | Minutes before a Recent Conversation drops |
| `contextViewer.threshold` | 150 | Threshold, **in k** (`150` = 150,000): sets the traffic-light colour from context used, independent of the Context window. Cleared: the model's Context window |
| `contextViewer.thresholdPerModel` | `{}` | Per-model Threshold, **in k** (`{ "Gemini 3.8 Flash": 190 }`) |
| `contextViewer.contextWindow` | empty | Last-resort Context window, **in k** (`256`): the model's maximum, the denominator of `62% · 159k/256k` |
| `contextViewer.contextWindowPerModel` | `{}` | Per-model Context window override, **in k** (`{ "Gemini 3.8 Flash": 256 }`) |
| `contextViewer.heavyItemPercent` | 5 | Highlight chat items above this % of the window |
| `contextViewer.hoverChars` | 2000 | Hover cut-off (head 75%, tail 25%) |
| `contextViewer.logLevel` | `error` | Output panel verbosity: `error` failures; `info` + data-source switches; `debug` + each poll and RPC call. Display unaffected |

## Safety

- Read-only: never writes under Antigravity data; SQLite is read from a copy only.
- RPC: loopback only, this window's server only, constant Get/List method allowlist; `GetUserStatus` is never called.
- CSRF token read from `/proc/<pid>/cmdline` (never `environ`), kept in memory, never logged, stored or shown.
- Logs redact the token, emails and account/plan fields; no headers, bodies or blobs are logged.
- Any `rpc` failure falls back to files; any file failure keeps the last good snapshot marked stale. No webviews, no telemetry.

## Known limits

- Per-rule/per-skill `GetTokenBase` children do not sum to their sections, so only section totals are shown.
- After a forced close, a leftover `language_server` can interleave step sequences in one transcript; the gauge stays right, running totals and tree may not. End leftover servers.
- Currently Linux/WSL host only for language-server RPC discovery; Windows-local windows and plain VS Code use file fallback only.
- The `node:sqlite` ExperimentalWarning is expected.
