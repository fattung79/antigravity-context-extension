---
id: 09
title: Which .gemini data store is the best source for titles, model and tokens?
labels: [wayfinder:research]
parent: MAP
blocked_by: []
assignee:
status: closed
---

## Question

The state.vscdb research pointed to three live stores under `.gemini/antigravity/`: `conversation_summaries.db` (the index: title, step count, last-modified, status), `conversations/<id>.db` (WAL sqlite per Conversation; `gen_metadata` names the model) and `antigravity_stats_cache.json` (model and token counts per Conversation; writer unknown). For each one: its schema, how fresh it is during a live turn, whether per-step token usage and the model can be decoded, whether its ids match the brain folders, and whether it can be read safely while Antigravity writes (WAL over /mnt/c). Recommend the source for each of: title, model, latest window usage, and the Conversation list.

## Resolution

- Conversation list and title: `conversation_summaries.db` (live, WAL, ids = `conversations/<id>.db` names; 44 of 66 titles empty, fall back to `preview`). Model: latest `conversations/<id>.db` `gen_metadata` row (display name, field `.1.21`).
- Per-call input / cache read / output tokens decode from `gen_metadata` (`.1.4.2/.5/.3`) and match the transcript 25 of 25; the row also holds the model's context limit (`.1.9.10.4` = 256000) and an exact System Prompt / Tools / Chat Messages token breakdown (`.1.9.10.3`).
- `antigravity_stats_cache.json` is stale (30 min, newest Conversation missing), disagrees with the dbs, and its writer is unknown: do not use.
- Read dbs by copying db + `-wal` + `-shm` together and opening the copy read-only (a no-wal copy misses all uncheckpointed commits); live-turn freshness was not measured (nothing running).
- Details: [docs/research/gemini-data-stores.md](../../docs/research/gemini-data-stores.md)
