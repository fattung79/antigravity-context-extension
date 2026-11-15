---
id: 10
title: Does switching Conversations update the selection signals as expected?
labels: [wayfinder:task]
parent: MAP
blocked_by: []
assignee: v-DominicLee
status: closed
---

## Question

HITL checklist: with the agent watching `annotations/*.pbtxt` mtimes and `last_user_view_time`, plus the workspace state.vscdb `lastConversationId`, the user switches to an older idle Conversation, then to one in another window, then to a new one. Record the latency of each signal and any case where it doesn't update. See docs/research/selection-signal.md.

Also, during a live turn: when does the new `gen_metadata` row in `conversations/<id>.db` appear compared with the transcript line, and what does `conversation_summaries.db` `status` show? (from docs/research/gemini-data-stores.md)

## Progress (2026-11-05, run 1; not resolved)

Watcher script and log: scratchpad `t10/watch.py` (to be copied to docs/research on resolution).
- **agy-b window (D365-Workspace), new chat:** the annotation was created, `lastConversationId` was set within ~1s of sending (not ~19s), the summaries status went RUNNING then IDLE, and the transcript line and `gen_metadata` row arrived together, ~4s after the send.
- **Original window (`antigravity-context-extension`, WSL):** steps 1 and 5-7 turned out to be in Claude Code, not Antigravity, so no data was expected (no anomaly). Its workspace `lastConversationId` was rewritten 6 times, always to empty: Antigravity rewrites the key even while its panel shows no Conversation.
- All 12 WSL language servers use `--app_data_dir=antigravity`. 10 are orphaned (ppid=1), so "the server whose parent is our extension host" needs revisiting. 2 extension hosts are live.
- Still unanswered: does clicking an existing Conversation update `last_user_view_time`?

## Resolution

Done (run 2, agy-b window). See [selection click test](../../docs/research/selection-click-test.md).
- The annotation `last_user_view_time` updates within 1s, but every switch stamps the old and new Conversation with the same time, so it means "last seen", not "selected". Use it for the Recent list, not to pick the Active Conversation.
- The window's `lastConversationId` updates within ~0.1-1s and is cleared on a new, empty chat. It is the reliable per-window selection signal. Its value while viewing another workspace's Conversation is unknown.
- `state.vscdb` copies can be broken mid-write, so retry. The transcript and `gen_metadata` update together; summaries status goes RUNNING then IDLE per turn; a model change has no signal until the next turn.
- From run 1: 10 of 12 WSL language servers are orphans (ppid=1), so server discovery must skip them.
