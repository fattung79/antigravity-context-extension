---
id: 01-selection-signal
title: Can the extension detect which Conversation is selected?
labels: [wayfinder:research]
parent: MAP
blocked_by: []
assignee:
status: closed
---

## Question

Is there any readable signal for which Conversation the user has selected or focused in Antigravity's agent panel? Candidates: `state.vscdb` keys (global and per workspace) and whether they change on selection, Antigravity-specific commands or context keys, extension API surface, files in the brain folders. If none exists, how good is the fallback (most recent transcript write)?

## Resolution

Yes. Best signal: per-workspace `lastConversationId` in `workspaceStorage/<hash>/state.vscdb` (key `google.google-antigravity`, JSON; written by the bundled agy extension when the panel URL becomes `/c/<id>`; flushed with ~20 s lag). Global signal: `~/.gemini/antigravity/annotations/<uuid>.pbtxt` `last_user_view_time` (max = most recently viewed; WSL-side, no lag, also holds the real title). Fallback (latest transcript mtime) is fine for a single running agent but wrong when viewing an idle Conversation. No command/context-key/API exposes it. Data dir here is `Roaming/Antigravity IDE/`.
Details: [docs/research/selection-signal.md](../../docs/research/selection-signal.md)
