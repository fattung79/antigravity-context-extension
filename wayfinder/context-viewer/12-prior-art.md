---
id: 12
title: Do the installed context-monitor extensions already meet the destination?
labels: [wayfinder:research]
parent: MAP
blocked_by: []
assignee:
status: closed
---

## Question

`antigravity-context-monitor` and `n2ns.antigravity-panel` are already installed. What does each show (gauge, inventory, multiple Conversations), what data source and method does each use, how well does each work under WSL, and what is the licence? Would forking or extending one beat building from scratch, or does one already meet the destination?

## Resolution

Neither installed extension meets the destination; build from scratch, take ideas. `antigravity-context-monitor` is not installed; `n2ns.antigravity-panel` (Apache-2.0) shows only a webview Context card for one Conversation (newest modified), no status bar gauge, no inventory. It reads live data from the language server over Connect-RPC (process scan + CSRF), including `maxContextTokens`, `estimatedTokensUsed`, `truncationReason`, `checkpointIndex`. Handles WSL (NAT host IP, `/mnt` scan). Fragile: open `no_process` reports. Details: [docs/research/prior-art.md](../../docs/research/prior-art.md).
