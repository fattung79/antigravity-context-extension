---
id: 02-state-db-index
title: What does state.vscdb hold for Conversations (titles, timestamps, model)?
labels: [wayfinder:research]
parent: MAP
blocked_by: []
assignee:
status: closed
---

## Question

Check the claim that `%APPDATA%\\Antigravity\\User\\globalStorage\\state.vscdb` (and the per-workspace copies) map Conversation ids to titles, timestamps and model. Find the exact keys and JSON shape, whether the ids match the brain-folder ids, whether the database can be read safely while Antigravity runs (locking, WAL), and how a Node extension would read it (no native module if possible).

## Resolution

The claim is mostly false. `antigravityUnifiedStateSync.trajectorySummaries` in `%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb` (note: "Antigravity IDE", not "Antigravity") is base64 protobuf, not JSON. It maps conversation ids to title, step count and timestamps, but has no model, is stale (24 entries, newest 2026-10-22) and its ids match `conversations/<id>.db`, not brain folders.
The db uses rollback-journal mode (no WAL), is safe to copy and read while the IDE runs; best reader is sql.js on the file bytes (node:sqlite only if the host Node is >= 22.5).
Better sources: `conversation_summaries.db` (live, titles, step counts), `conversations/<id>.db` (`gen_metadata` has model names), `antigravity_stats_cache.json` (model and tokens per Conversation).
Findings: [docs/research/state-db-index.md](../../docs/research/state-db-index.md)
