---
id: 11
title: With several windows open, which Conversation is Active?
labels: [wayfinder:grilling]
parent: MAP
blocked_by: [10-selection-click-test]
assignee: v-DominicLee
status: closed
---

## Question

Each Antigravity window has its own `lastConversationId`, while the annotation view time is global. Decide the rule: the global latest view, this window's own Conversation, or per-window panels. Decide also what the Recent Conversations list draws from.

Also: each window runs its own language server. How is a Conversation mapped to the right server or trajectory when two windows share one?

Evidence from the click test: per-window `lastConversationId` is fast and reliable; annotation view times tie on switches. Open: what `lastConversationId` holds while a window views another workspace's Conversation.

## Resolution

- **Per window:** each window shows its own selected Conversation, read from its own `lastConversationId` (workspace `state.vscdb`, located from `context.storageUri`).
- **Nothing selected** (new empty chat, nothing opened, possibly viewing another workspace's chat): keep showing the last Active Conversation, **dimmed**: muted status-bar text colour (theme disabled foreground), a tooltip "Not selected: last viewed Conversation in this window", and a greyed tree icon with "not selected". On a fresh window: the Conversation for this window's folder written to most recently, also dimmed.
- **Recent Conversations:** from any workspace, ranked by the later of last seen (annotation view time) and last written; cap 2; each dropped 3 minutes later.
- **Server:** always ask this window's own language server (skipping orphans); if it can't return a Conversation's details, use the files for that Conversation. Whether one server can answer for others is checked at build time.
