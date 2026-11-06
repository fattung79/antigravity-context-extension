---
id: 03-transcript-format
title: What do transcripts contain, and how do they map to Context Items?
labels: [wayfinder:research]
parent: MAP
blocked_by: []
assignee:
status: closed
---

## Question

Map the full transcript format: every source/type value, how injected context (files, rules, workflows, memories, tool output) shows up in `content`, the difference between `transcript.jsonl` and `transcript_full.jsonl`, other files in the brain folder, how often and in what way the files are written (append-only?), and whether compaction or truncation leaves a trace. Confirm that latest-step `input_tokens + cache_read_tokens` is a sound measure of how full the window is.

## Resolution

Transcripts are append-only JSONL, one line per *completed* step (never updated; mtime lags `created_at` by ~5 s). `transcript_full.jsonl` is the one to read; `transcript.jsonl` truncates strings to ~4k chars and JSON-encodes tool args. Only PLANNER_RESPONSE steps carry tokens (oldest 6 conversations have none); `input_tokens` excludes cached tokens, so `input + cache_read` is the full prompt size and grows ~700/step (valid gauge; rewinds show as `step_index` going backwards, so use the last kept step). System prompt, rules, knowledge and memories are NOT in the transcript (4k-16k hidden baseline); only user turn tags, tool calls/results and file-read paths are. No compaction trace and no context limit found; the model name appears only as `Model Selection` change deltas.
Findings, schema, rewind rule, token evidence and proposed Context Item kinds: [docs/research/transcript-format.md](../../docs/research/transcript-format.md)
