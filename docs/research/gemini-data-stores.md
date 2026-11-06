# Gemini data stores: titles, model, token usage

Ticket: wayfinder/context-viewer/09-gemini-data-stores.md. Checked 2026-11-05 on this machine (WSL2 aarch64, Windows-on-ARM host). Method: copied files to scratch, opened read-only with sqlite3 and `python3 -I`, decoded protobuf with a ~30-line wire-format parser (no .proto available; field numbers are observed, meanings inferred and marked). Titles and contents are not reproduced. No live turn was running (see Freshness).

## Verdict

- **`conversations/<id>.db` `gen_metadata` is the source for model and per-call token usage, and also for the model's own context limit and a per-section context breakdown.** Decoded values match the transcript exactly (25 of 25 model calls: input, cache read, output).
- **`conversation_summaries.db` is the source for the Conversation list and title** (live, indexed, no model).
- **`antigravity_stats_cache.json` is unreliable** (30 min stale, missing the newest Conversation, disagrees with gen_metadata on model and tokens). Do not use.

## Environment

Real data roots (all under the user's home):

| Root | State |
|---|---|
| `~/.gemini/antigravity/` | **Live.** 63 `conversations/*.db`, `conversation_summaries.db` (66 rows), `brain/` (32 folders), stats cache. Written by the `agy` hub processes (`~/.gemini/bin/agy --hub ... --app_data_dir=antigravity`, a 230 MB aarch64 ELF; many are running). |
| `/mnt/c/Users/czens/.gemini/antigravity/` | Stale. `conversation_summaries.db` has 3 rows, newest 2026-10-29; `conversations/` empty; no stats cache. |
| `~/.gemini/antigravity-ide/`, `/mnt/c/.../antigravity-ide/` | Legacy. `.ide_migration` marker (2026-10-27); conversations dir last touched 2026-11-03; no `conversation_summaries.db`. |
| `~/.gemini/antigravity-cli/` | Separate CLI profile; own `conversation_summaries.db` (20 KB, 2026-11-03). Not examined further. |

Three rows in the live summaries db have `source = CORTEX_TRAJECTORY_SOURCE_CLI` and no `conversations/<id>.db`; these are CLI Conversations.

## 1. conversation_summaries.db

Schema (single table plus FTS5 search index `conversations_fts*`, `search_schema_version`):

```
conversation_summaries(
  conversation_id TEXT PK, title TEXT, preview TEXT, step_count INT, last_modified_time DATETIME,
  workspace_uris TEXT (JSON array of file:// uris), status TEXT, source TEXT, project_id, agent_name,
  parent_conversation_id, nesting_depth, battle_id, winning_conversation_id, not_fully_idle, killed,
  last_user_input_time DATETIME, last_user_input_step_index INT, app_data_dir TEXT, raw_summary BLOB, group_id)
indexes on last_modified_time and last_user_input_time
```

- Journal mode WAL. Timestamps are RFC3339 with nanoseconds and `+00:00`.
- `status`: only `CASCADE_RUN_STATUS_IDLE` seen (66 of 66, but nothing was running).
- **Ids**: `conversation_id` = `conversations/<id>.db` file name (63 of 63 dbs present as rows) = `trajectory_meta.cascade_id` inside the db. 31 of 66 ids have a brain folder; 1 brain folder has no row. `trajectory_meta.trajectory_id` is a different uuid (also in `raw_summary` #4; = `trajectory_id` kv in gen_metadata).
- **Title**: 44 of 66 rows have `title = ''`; of those 35 have a non-empty `preview`, 9 have neither. Where the title is set, `preview` usually equals it (21 of 22). So title is an LLM- or system-generated short name, not the first prompt; the fallback for empty is `preview`, then first prompt from the transcript.
- `raw_summary` (protobuf, same data plus more): #1 title, #2 step count, #3 Timestamp (last modified), #4 trajectory uuid, #7 created, #9 workspace/repo/branch, #10 last user input, #15 nested copy with another timestamp, #17 workspace + ids + project, #22/#28 small ints. No model and no token fields.
- **Ordering**: `ORDER BY last_modified_time DESC` (index exists) gives the Recent list; `last_user_input_time` is a better "user touched it" signal.

## 2. conversations/<id>.db

Schema:

```
trajectory_meta(trajectory_id PK, cascade_id, trajectory_type, source)      -- 1 row
steps(idx PK, step_type, status, has_subtrajectory, metadata, error_details, permissions,
      task_details, render_info, step_payload, step_format)                  -- 1 row per step (idx = transcript step_index)
gen_metadata(idx PK, data BLOB, size)                                        -- 1 row per model call
executor_metadata(idx, data), parent_references(idx, data), battle_mode_infos(idx, data),
trajectory_metadata_blob(id DEFAULT 'main', data)
```

Journal mode WAL. Sample (50 steps): `steps` has step_type 14 (2), 15 (25), 132 (23); `gen_metadata` has 25 rows, i.e. one per planner response; planner step index = 2*idx+1 in this sample (the interleaved steps are tool results). Do not assume the 2k+1 rule; join through the transcript's step order or count PLANNER rows.

### gen_metadata row decoding (verified against transcript_full.jsonl)

Rows 0..N-2 are small (~1.2 KB); the **last row is large** (167 KB in a 50-step sample): it additionally carries a request-config block (#3) and what looks like a snapshot of the request messages (#1.1, #1.2). Never log or display it. Paths below are protobuf field paths inside `data` (`.1.4.2` = field 1, then 4, then 2).

| Path | Meaning | Evidence |
|---|---|---|
| `.1.4.2` | **input_tokens** (uncached prompt tokens) | equals transcript `input_tokens` for 25 of 25 calls |
| `.1.4.3` | **output_tokens** | equals transcript `output_tokens` 25 of 25 |
| `.1.4.5` | **cache_read_tokens**; field absent when 0 (first 8 calls) | equals transcript `cache_read_tokens` 25 of 25 |
| `.1.4.7` | response id (`bot-<uuid>`) | |
| `.1.4.1`, `.1.4.6`, `.1.4.9`, `.1.4.10`, `.1.4.11`, `.1.11`, `.1.12` | not identified (ints/short strings; `.1.4.1` constant 1319 across rows; some look like timings) | |
| `.1.19` | short model id, e.g. `gemini-3.8-flash-n` (looks truncated to 18 chars) | |
| `.1.21` | **display model name**, e.g. `Gemini 3.8 Flash (Medium)` | same name style as the UI |
| `.1.20` | repeated {key, value} strings: `cascade_id`, `root_cascade_id`, `trajectory_id`, `request_id`, `model_enum` (e.g. `MODEL_PLACEHOLDER_M319`), `used_claude`, `used_non_gemini_model`, `last_step_index` | |
| `.1.9.10.1` | total context tokens as counted by the agent (34421 in the sample) | equals sum of `.1.9.10.3.1[].4` and `.1.9.10.3.2` |
| `.1.9.10.4` | **model context limit** (256000 for Gemini 3.8 Flash) | constant across rows |
| `.1.9.10.3.1[]` | breakdown entries: {1 name, 4 tokens, 5[] sub-entries {1 name, 3 tokens}}. Names seen: `System Prompt` (12609; subsections identity, terminal_sandbox, artifacts, conversation_transcript, guidelines, communication_style, slash_commands, messaging, subagents, user_rules, skills, featured_plugins, user_information...), `Tools` (5796), `Chat Messages` (16016) | **Exact per-category token counts from the model side; a free upgrade over `~est` for the Context Inventory top level** |
| `.3.28` (last row only) | full model id, e.g. `gemini-3.8-flash-medium` | |
| `.3.32.*`, `.3.58/.59`, `.3.43` | config ints (e.g. 200000, 20000) and feature flags; meaning not established | |

Note that `.1.9.10.1` (34421) is **not** `input + cache_read` (30403 for the last call) nor plus output (31214); it is the agent's own estimate (a few percent to ~30 percent higher, larger relative gap on cache-less early calls: 18730 vs 13303 at call 0). The ticket's decided gauge (`input + cache_read` of the latest call) is directly available; `.1.9.10.1` is a candidate alternative or cross-check, to be decided.

Model is per call (a Conversation can switch model mid-way); use the latest row's `.1.21`. For a Conversation with no `gen_metadata` rows yet, fall back to `antigravity_state.pbtxt` `last_selected_agent_model` (global, not per Conversation).

## 3. antigravity_stats_cache.json

Shape: `{"sessions": {<convo_id>: {convo_id, mtime (epoch float), surface ("Core" 63 | "CLI" 3), created_at, date, duration_sec, model, project, workspace_path, title, turn_count, input_tokens, cached_tokens, output_tokens, thinking_tokens, total_tokens, tool_counts, tool_errors}}, "last_sync": epoch}` (66 sessions). Only the WSL root has one.

- **Not fresh**: file mtime 14:52:09.208 equals `last_sync` (14:52:09); the newest Conversation (4fe3805a, active at 15:13-15:14) is absent; unchanged across two samples ~1 minute apart and through later activity (15:14-15:15).
- **Not consistent with the dbs**: for b050cc8b the cache says model `Gemini 3.5 Flash`, input 12694, cached 0; gen_metadata says `Gemini 3.8 Flash (Medium)`, input 13702. Token fields are cumulative sums, not the latest call, so they cannot give the gauge anyway.
- **Writer**: not established. The string `antigravity_stats_cache` is absent from the `agy` binary (grep -a, 0 hits), the IDE server extensions, `~/.gemini/antigravity/{bin,builtin,lib,cache}` and the Claude settings/hooks. The cache write at 14:52:09 coincides to within 30 ms with `-shm` mtimes on all 51 conversation dbs, consistent with a one-shot aggregator that opened every Conversation db, but who ran it is unknown (cache vocabulary `surface`, `tool_counts` suggests a usage-statistics tool; may be third-party). Treat as someone else's derived artifact.

## 4. Freshness during a live turn

No turn was running during the session (all status IDLE, all `-wal` files 0 bytes, last agent activity 15:14:26). I could not generate one (read-only rule; the agent that would write is a separate app). What was measurable from the last turn, newest Conversation 4fe3805a:

- transcript_full.jsonl last write 15:14:26.667 local = 22:14:26.667 UTC; `conversation_summaries.last_modified_time` = 22:14:26.665952949. **Equal to ~1 ms**, so the summaries row is updated at the same moment the transcript is, with the same `step_count` (50 = transcript lines).
- `conversations/<id>.db` mtime 15:14:56 (30 s later: checkpoint/final write); `conversation_summaries.db` mtime 15:15:39 (73 s after the transcript). `raw_summary` carries a nested timestamp (15:15:09) later than the row's `last_modified_time`, so late bookkeeping writes follow the last step.
- gen_metadata had the final call's tokens (row 24: 2273 / 28130 / 811) matching the last transcript PLANNER_RESPONSE line; i.e. at rest it equals the transcript.
- Not measured: whether the gen_metadata row for an in-flight call appears before the transcript line, and the WAL size during a turn. **Follow-up: re-sample during a real turn** (2 samples, 60 s apart, stat of the db + `-wal`, `max(idx)` of gen_metadata vs transcript line count).

## 5. Reading safely while Antigravity writes

- WAL mode on every db (`summaries`, `conversations/*`). Readers do not block writers, but the **main db file alone is not the whole database**: committed pages live in `-wal` until a checkpoint. At the moment checked all WALs were 0 bytes (checkpointed), so a bare copy would have been correct then; do not rely on it.
- Demonstrated in scratch (own synthetic db): a WAL db with 100 uncheckpointed rows; copying only `x.db` gave `no such table` (everything missed, including schema if the first commits are still in WAL); copying `x.db`, `x.db-wal`, `x.db-shm` together and opening read-only returned all 100 rows.
- Recommended read path: copy `db`, `-wal` and `-shm` (if present) into a temp dir, then open the copy read-only. `node:sqlite` `DatabaseSync(copy, {readOnly:true})` replays the WAL natively; Node 22.21.1 (WSL server) and 22.20 (Windows UI host) per ticket 04 have it, but **it was not exercised inside the extension host**. **sql.js** opens a single in-memory buffer and (untested here) does not see a `-wal` file, so with sql.js a bare buffer misses uncheckpointed commits; it would need the WAL merged first (e.g. mount all three files in its Emscripten FS, untested). Because of that, prefer reading tokens from the transcript and use the db only for model, title and the `.1.9.10` breakdown. Avoid opening in place over /mnt/c (9p, unreliable POSIX locks).
- Torn-copy risk: the three files are not copied atomically; if the writer checkpoints mid-copy the copy can be inconsistent (rare). Retry on `SQLITE_CORRUPT`/`malformed`/`not a database`, or copy, compare file sizes+mtimes before/after, and re-copy on change.
- Cost: summaries db is 2 MB; a conversation db is ~1 MB for a 50-step Conversation (the largest earlier seen has 1294 steps). Avoid copying the whole db every 2 s. Cheaper: poll `stat` of `<id>.db` and `-wal` (mtime/size) and re-copy only on change; or just read the transcript (cheap tail) for token counts and use the db only for the model and `.1.9.10`.
- Never write: `PRAGMA query_only=1`; no `immutable=1` on the live file (would ignore the WAL).
- Over /mnt/c the Windows side is stale (see Environment), so cross-9p reads matter little for these stores.

## Recommendations

| Need | Source | Notes |
|---|---|---|
| Conversation list | `conversation_summaries.db` (`ORDER BY last_modified_time DESC`) | Live, indexed, 1 row per Conversation, ids = brain folder names. Cross-check with brain folders (only 31 of 66 ids have one; the transcript lives in brain). Poll the db `stat` (~5 s) and requery. |
| Title | `conversation_summaries.title`, fallback `preview`, fallback first prompt (transcript) ~40 chars + last-activity time | 44 of 66 rows have empty title. |
| Model | latest `gen_metadata` row `.1.21` (display) / `.1.20` `model_enum` | Per call, so can change. Stats cache: do not use. |
| Latest window usage | Primary: transcript's last PLANNER_RESPONSE (`input_tokens + cache_read_tokens`), already the decided source. Cross-check/alternative: latest `gen_metadata` `.1.4.2 + .1.4.5`. | Equal in all 25 samples; db path needs a WAL-aware copy, transcript is cheaper. |
| Model context limit | `gen_metadata` `.1.9.10.4` (256000 for Gemini 3.8 Flash) | Beats a hard-coded table; keep the table as fallback and settings override, as decided. Only one model verified. |
| Inventory (top-level kinds) | `gen_metadata` `.1.9.10.3.1` (System Prompt / Tools / Chat Messages and system-prompt subsections with token counts) | New finding: exact counts for the system prompt categories. Per-file/rule items remain `~est`. |

## Confidence and gaps

- High: schemas, id mapping, token decode (25 of 25 match), model name location, WAL copy behavior (demonstrated on synthetic data), stats cache staleness and inconsistency.
- Medium: meaning of `.1.9.10.1` vs input+cache; field meanings other than the verified ones; "last row is a request snapshot".
- Not verified: freshness during a live turn (nothing was running); whether the stats cache refreshes at another trigger; the stats cache writer; the 256000 limit for other models (Claude, 3.5 Flash); what `.1.4.1` (=1319 constant), `.3.32.3` (200000) mean; behavior of compaction/truncation in gen_metadata; whether `node:sqlite` works in the extension host; sql.js behavior on a WAL set (untested).
- Primary sources: first-hand inspection of local files only (no Antigravity source or docs). SQLite WAL semantics from the demo above.

## New questions

1. Re-sample during a real live turn: when does the new gen_metadata row and `-wal` growth appear relative to the transcript line, and how long are summaries/`status` (RUNNING?) lagging?
2. Does `.1.9.10.4` change per model (Claude, Gemini 3.5 Flash), and does `.1.9.10.1` drop after compaction?
3. Which file/key identifies the Active Conversation (still open from ticket 02)?
