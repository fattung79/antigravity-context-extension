# state.vscdb as a Conversation index: verification

Ticket: wayfinder/context-viewer/02-state-db-index.md. Checked 2026-11-05 on the user's own machine (WSL2 + Windows host). Method: copied files to scratch, opened read-only with sqlite3 and python3 -I. No titles or contents are reproduced here beyond one redacted example.

## Verdict

The claim is **partly true and mostly unusable**. One ItemTable row does map Conversation ids to a title, step count and timestamps, but:

1. It is **not JSON**: it is base64 of a protobuf (with a second layer of base64 inside each entry).
2. It holds **no model** per Conversation (no model string or `MODEL_*` enum found in it).
3. It is **stale**: 24 entries, newest timestamp 2026-10-22, while the Conversations folder has 63 Conversations and the db was written on 2026-11-05.
4. Its ids match `conversations/<id>.db` file names, **not brain folders**: 0 of 24 ids have a brain folder (brain holds only 32 of 63).

Better sources of "id -> title / step count / model" exist outside state.vscdb (see "Where Conversation data actually lives").

## Location (correction)

The user was told `%APPDATA%\Antigravity\User\globalStorage\state.vscdb`. On this machine `%APPDATA%\Antigravity` has no `User` folder. The VS Code user data dir is **`%APPDATA%\Antigravity IDE\User\`** (WSL: `/mnt/c/Users/<user>/AppData/Roaming/Antigravity IDE/User/`):

- `globalStorage/state.vscdb` (+ `state.vscdb.backup`, `storage.json`, extension folders). About 1 MB, 507 ItemTable rows.
- `workspaceStorage/<hash>/state.vscdb` (+ `.backup`): 27 folders; sampled one (71 rows). Holds only VS Code view state and `chat.ChatSessionStore.index` (`{"version":1,"entries":{}}`, empty); no Conversation index.
- There is also `%APPDATA%\Antigravity\` (Chromium cache, `wsl_state.json`, `app_storage.json`; no vscdb) and `%APPDATA%\Antigravity Context Monitor\state-v1.json` (not examined).

Not to be confused: `antigravity.notification.*` keys (~330 rows, 4-byte values) embed conversation ids in the key name (`antigravity.notification.agent-finished-<uuid>-<epoch ms>`); an agent-finished event log, no titles.

## Schema

```
CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
```
Only table (no `cursorDiskKV`). Standard VS Code storage schema; source: microsoft/vscode `src/vs/base/parts/storage/node/storage.ts` (`SELECT * FROM ItemTable`, `INSERT ... ON CONFLICT`, `.backup` copy).

## Relevant keys (grep of all 507 keys for chat, session, conversation, agent, cascade, jetski, model, trajectory, antigravity)

| Key | Size | Format | Meaning |
|---|---|---|---|
| `antigravityUnifiedStateSync.trajectorySummaries` | ~31 KB | base64 protobuf | The Conversation index (below) |
| `antigravityUnifiedStateSync.modelPreferences` | 68 B | base64 protobuf | One global entry `last_selected_agent_model_sentinel_key`; not per Conversation |
| `antigravityUnifiedStateSync.modelCredits`, `.agentPreferences`, `.artifactReview`, `.sidebarWorkspaces`, `.userStatus`, `.theme`, `.browserPreferences`, `.overrideStore`, `.seenNuxIds`, `.oauthToken` | various | base64 protobuf | Settings/state. `oauthToken` is a secret: do not read it |
| `google.google-antigravity` | 5.8 KB | JSON | Has `antigravity-storage` with `projectsOrder`, `jetski.onboarding.*`, `antigravity-multi-conversation-layout-v3-<conversation-uuid>` (118-char layout string per open Conversation), `antigravity-multi-conversation-layout-v3-index`, `new-convo-last-selected-project`. Possible hint of which Conversations are open in the UI; contents not decoded |
| `chat.ChatSessionStore.index` | 26 B | JSON | Empty (`entries: {}`) - VS Code's own chat, unused |
| `n2ns.antigravity-panel` | 196 KB | JSON | Third-party extension's private cache (quota history, snapshots). Changes every few minutes. Not a Conversation index |
| `AGI-is-going-to-arrive.antigravity-context-monitor` | 17 KB | JSON (not inspected) | Another extension's state |

No key with `cascade` or `jetski` other than the above `jetski.onboarding.*` entries inside `google.google-antigravity`.

## trajectorySummaries shape

Decoded with a hand-written protobuf wire parser (no .proto available; field numbers are observed, meanings inferred).

```
value = base64( Message{ repeated #1: Entry } )              // 24 entries
Entry   = { #1: string conversation_id (uuid),
            #2: Msg{ #1: string = base64( Summary ) } }     // second base64 layer
Summary = { #1: string  title            // e.g. "<REDACTED: first-prompt-like text>"
            #2: varint  step count       // observed 5, 16, 121, 553, 630 ...
            #3: Timestamp{#1 secs,#2 nanos}   // latest: last-modified (inferred)
            #4: string  uuid             // another id (not the conversation id; unidentified)
            #5: varint  (=1)
            #7: Timestamp                // earliest: created (inferred)
            #9: Msg{ workspace uri x2, repo{name,url}, branch }  // workspace info
            #10: Timestamp               // middle: maybe last user input (inferred)
            #15 str, #16 varint, #17 Msg{workspace.., ts, uuid, bytes}, #21, #22 varint }
```
Field-presence counts across 24 entries: #1,#2,#3,#4,#5,#7,#9,#10,#15,#16,#17,#22 on all, #21 on one. Searched decoded bytes for gemini/claude/gpt/model/opus/sonnet strings: **none**. So no model.

Id match: 24/24 ids exist as `~/.gemini/antigravity/conversations/<id>.db` (or the Windows copy); 0/24 exist as brain folders.
Staleness: newest entry 2026-10-22 17:53 UTC; Conversations created up to 2026-11-05 are missing. Two copies taken ~2 minutes apart showed the key unchanged. Whether the IDE refreshes it at some trigger (exit?) was not determined. This looks like a legacy per-IDE summary cache, superseded by `conversation_summaries.db`.

## Locking, WAL, change behaviour

- `PRAGMA journal_mode` = **delete** (rollback journal, 4096-byte pages) for both global and a sampled workspace db. No `-wal`/`-shm`/`-journal` files exist next to any state.vscdb. VS Code's storage.ts has no WAL pragma (grep for journal/PRAGMA found only `quick_check`/`integrity_check`, a busy timeout and `.backup`).
- `state.vscdb.backup` is a full file copy VS Code makes at close/clean states (storage.ts `backup()`: `Promises.copy`); it lagged the main db by ~20 minutes (mtime 14:54 vs 15:17). Not a live fallback.
- Writes are small batched upserts (`INSERT ... ON CONFLICT DO UPDATE ... WHERE value != excluded.value`). In ~2 minutes, only `n2ns.antigravity-panel` changed, but the file mtime moved (15:17:42 to 15:19:39), so the file is rewritten every few minutes.
- Safety: reading while Antigravity runs worked (plain `cp` and read-only open of the copy, 1 MB). Risks: a torn read if a write is mid-flight (a copy could be inconsistent; retry on `SQLITE_CORRUPT`/malformed, or read twice and compare). Opening in place from WSL over the 9p/drvfs mount is the less safe option (POSIX locks are unreliable there); copy to a temp file, or read the bytes with `fs.readFileSync` and open them in memory. Never write.

## Best way to read from a Node/TypeScript extension

Ranking for this use:

1. **sql.js (SQLite compiled to wasm, pure JS)**: read the file with `fs.readFileSync`, `new SQL.Database(buffer)`, `SELECT value FROM ItemTable WHERE key = ?`. No native module, no file locks, works in any Node/Electron version, 1 MB file is trivial. Bundle the `.wasm` with esbuild (copy as asset).
2. `node:sqlite` (built into Node >= 22.5, no flag from 22.13): zero dependencies, supports read-only open. Only usable if Antigravity's extension host runs a new enough Node; **not verified** for this app. Run `process.versions.node` inside the extension host to check. Must open a copy or use immutable URI over drvfs.
3. `sqlite3` CLI: present in this WSL, but not guaranteed on the Windows side. Avoid.
4. Native modules (better-sqlite3, sqlite3): avoid (Electron ABI rebuilds).

Decoding the protobuf needs a small hand parser (about 30 lines) or `protobufjs` reflection with ad hoc field numbers; the layout is undocumented and may change on updates.

## Where Conversation data actually lives (for related tickets)

All under `~/.gemini/antigravity/` (WSL) and `/mnt/c/Users/<user>/.gemini/antigravity/` (Windows); both roots exist and both are populated. Only discovered by listing; contents deliberately not read except schema/shape.

- **`conversations/<id>.db`**: one SQLite file per Conversation (63 in WSL), journal mode **wal** (with `-wal`/`-shm` while live; WAL means copy all three files together, or open read-only). Tables: `trajectory_meta` (trajectory_id, cascade_id, source), `steps` (idx, step_type, status, metadata, step_payload ...), `gen_metadata` (idx, data blob, size), `executor_metadata`, `parent_references`, `trajectory_metadata_blob`, `battle_mode_infos`. Largest sample: 1294 steps, 623 gen_metadata rows. The last `gen_metadata` blob contains model strings (`Gemini 3.8 Flash`, `gemini-3.8-flash-medium`, `MODEL_PLACEHOLDER_M319`), so **per-Conversation model and likely token usage come from here**, not state.vscdb. Protobuf blobs; not decoded further (belongs to the transcript/token tickets).
- **`conversation_summaries.db`** (WAL): table `conversation_summaries(conversation_id PK, title, preview, step_count, last_modified_time, workspace_uris, status e.g. CASCADE_RUN_STATUS_IDLE, source e.g. CORTEX_TRAJECTORY_SOURCE_CLI, project_id, agent_name, parent_conversation_id, nesting_depth, last_user_input_time, last_user_input_step_index, raw_summary blob, ...)` plus FTS5 tables (`conversations_fts`). 66 rows, 22 with non-empty title, newest modified 2026-11-05 22:14 UTC (live). 31 of 66 ids have a brain folder. This is the **current, live Conversation index** (title, step count, last-modified, status); no model column (no model strings in `raw_summary` of the newest row).
- **`agyhub_summaries_proto.pb`** (47 KB WSL, 1.4 KB Windows): protobuf summaries, not decoded.
- **`antigravity_state.pbtxt`**: text proto; has `last_selected_agent_model: MODEL_PLACEHOLDER_M319` (global last-selected model, not per Conversation).
- **`antigravity_stats_cache.json`** (WSL only): JSON `{"sessions": {<convo_id>: {convo_id, mtime, surface ("Core"|"CLI"), created_at, date, duration_sec, model, project, workspace_path, title, turn_count, input_tokens, cached_tokens, output_tokens, thinking_tokens, total_tokens, tool_counts, tool_errors}}, "last_sync": epoch}`. 66 sessions; models seen: Gemini 3.8 Flash (51), Gemini 3.5 Flash (5), Argon 4 (5), Claude Opus 4.6 (3), Gemini 3.7 Flash (2). **This is the only place found with model per Conversation in a plain JSON file**, plus cumulative token counts. Who writes it was not established (file name has no vendor prefix; may be Antigravity CLI or a tool/extension), so treat as optional and possibly stale (mtime 14:52, last_sync is a future-looking epoch 1793915529).
- `brain/<id>/`: artifacts/transcripts for 32 Conversations only; not every Conversation has one.
- Other dirs seen: `annotations/`, `knowledge/`, `plugin_data/`, `presence/`, `daemon/`, `log/` (`cli.log` symlink), `scratch/`, `bin/`, `lib/`, `crashes/`, `cache/`, `builtin/`. Not examined.

## Confidence and gaps

- High: location correction, schema, journal mode, key list, trajectorySummaries shape and staleness, id mapping, no model in the state.vscdb index.
- Medium: field meanings (#3/#7/#10 timestamps, #2 step count) are inferred from values, not documented.
- Not verified: whether Antigravity ever refreshes trajectorySummaries; Antigravity's embedded Node version (node:sqlite eligibility); who writes antigravity_stats_cache.json; whether the Windows-side GUI (as opposed to this WSL-remote setup) behaves the same; multi-conversation-layout keys' exact use.
- Primary sources: VS Code `storage.ts` (fetched from microsoft/vscode main); everything else is first-hand inspection of local files. No Antigravity source or docs were available.

## New questions raised

1. Which store does the IDE agent panel read for the Active Conversation selection (candidate: `antigravity-multi-conversation-layout-v3-*` keys, or `presence/`)?
2. Can token usage and model be decoded from `conversations/<id>.db` `gen_metadata` (versus the stats cache)?
3. Should the Recent/Title lookup use `conversation_summaries.db` (WAL, live) instead of state.vscdb?
