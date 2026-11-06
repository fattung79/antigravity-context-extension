# Antigravity transcript format

Ticket: `wayfinder/context-viewer/03-transcript-format.md`. Researched 2026-11-05 against local files only (read-only; no Antigravity source or docs were consulted, so every claim below is **observed behaviour of this install**, not documented contract).

Sample: 32 conversations = 31 under `~/.gemini/antigravity/brain/` (plus a non-conversation `tempmediaStorage/` dir) and 1 under `/mnt/c/Users/czens/.gemini/antigravity/brain/`. 2,786 steps in each of the two transcript files. Spanning 2026-09-29 to 2026-11-05. Quotes below are structure/keys/tag names only.

## 1. Brain folder layout

```
brain/<uuid>/
  scratch/                          (usually empty; one had an agent-written .md)
  .user_uploaded/media_<ms>_<hex>.png   (only when user attached an image)
  .system_generated/
    logs/
      transcript.jsonl              truncated view
      transcript_full.jsonl         complete view
      chunks/transcript/00000000.jsonl ...        100 KiB byte-slices of transcript.jsonl
      chunks/transcript_full/00000000.jsonl ...   same for full
    steps/<step_index>/output.txt   raw tool stdout for some steps (766 files)
    messages/<uuid>.json            inter-agent / system messages; read.json; undelivered/
    subagents/<child-uuid>.json     parent->child link (parent side only)
    tasks/task-<N>.log              background command output
```

- Subagents are **separate conversations** with their own brain folder; the parent holds `subagents/<child-uuid>.json` with keys `conversationId, subagentDescriptor{typeName,role,...}, state (SUBAGENT_STATE_ALIVE), spawnStepIndex, workspaceUris`. `messages/*.json` keys: `id, recipient, sender, priority (MESSAGE_PRIORITY_HIGH|LOW), timestamp (ns precision), renderDetails, content, sourceMetadata, hideFromUser`. Child tokens are not in the parent's gauge.
- Chunks: concatenating `chunks/<name>/*.jsonl` in order is byte-identical to the monolithic file in all 32 conversations x 2 files. Chunks split at exactly 102400 bytes, mid-line, so a chunk can end with a partial JSON line. They carry no extra information; read the monolithic file.
- `steps/<N>/output.txt` = tool stdout with CRLF normalised to LF and without the `Created At / Completed At` header the transcript `content` has. Only tool-result steps (run_command etc.) get one. Not needed for the extension.
- Out of this ticket's scope but adjacent: `~/.gemini/antigravity/conversations/<uuid>.db` (165 files), `conversation_summaries.db`, `agyhub_summaries_proto.pb`, `antigravity_stats_cache.json` (top keys `sessions, last_sync`). Likely sources for titles / the model name; leave for the state.vscdb / titles tickets.

## 2. Step schema (JSONL, one object per line, UTF-8)

Keys seen across all steps: `step_index, source, type, status, created_at` (always); `content` (1623 str, else absent/null); `thinking` (335); `tool_calls` (1191); `input_tokens, cache_read_tokens, output_tokens` (804, always all three together); `error` (60, string); `media` (1: list of `{mime_type, uri}`); `truncated_fields` (transcript.jsonl only, 292).

`created_at`: ISO-8601 UTC with `Z`, whole seconds. (Text inside `content` such as `Created At:` uses local `-07:00`.)

### source / type / status counts (2,786 steps)

| source | type | status | count | notes |
|---|---|---|---|---|
| MODEL | PLANNER_RESPONSE | DONE | 1349 | one model inference. `content` (reply text), `thinking`, `tool_calls`, and tokens |
| MODEL | GENERIC | DONE | 1164 | a tool result (no tool name on the step) |
| MODEL | GENERIC | ERROR | 58 | tool failed; `error` string and content `Encountered error in step execution: ...` |
| MODEL | GENERIC | RUNNING | 21 | run_command moved to background; never updated (see 5) |
| MODEL | GENERIC | INVALID | 1 | |
| USER_EXPLICIT | USER_INPUT | DONE | 138 | user turn |
| SYSTEM | SYSTEM_MESSAGE | DONE | 54 | injected `<SYSTEM_MESSAGE>` (task finished, subagent notice, parent message) |
| SYSTEM | ERROR_MESSAGE | DONE | 1 | |

Only PLANNER_RESPONSE steps carry token counts. 545 of the 1349 have none: all of them are in the six oldest conversations (2026-09-29/30), which predate the token fields entirely (schema evolved ~Oct 27). Every PLANNER_RESPONSE in the other 26 conversations has all three counts. The gauge must degrade gracefully ("n/a") when no step has tokens.

### tool_calls

`[{name, args}]`, args is an object whose shape depends on the tool. Tools seen (calls): run_command 542, view_file 313, read_file 126, edit_file 90, replace_file_content 58, write_file 38, manage_task 22, send_message 18, search_web 15, write_to_file 13, invoke_subagent 9, manage_subagents 5, ask_question 1, read_url_content 1, schedule 1, list_plugin_accounts 1. Common arg keys: `CommandLine, Cwd, WaitMsBeforeAsync, toolSummary, toolAction` (run_command); `AbsolutePath|Path, StartLine, EndLine` (view/read); `Path|TargetFile, Content|CodeContent|ReplacementContent, Target(Content)` (edit/write); `Prompt, Model, Role, TypeName` (invoke_subagent; `Model` was always `"flash"`).

Pairing results to calls: a PLANNER_RESPONSE with k tool calls is followed by k GENERIC steps in order (1154 of 1154 single-call steps pair 1:1; multi-call steps pair in order, with a few where results are missing or arrive later). The GENERIC step carries no tool name; use the position.

### Result content shapes (GENERIC.content)

Always starts `Created At: <iso-local>\nCompleted At: <iso-local>\n`, then by tool:
- view_file: `File Path: \`file:///...\``, `Total Lines`, `Total Bytes`, `Showing lines A to B`, a line-numbered body (`N: text`), a trailing "The above content shows the entire..." note.
- read_file: `Showing lines A-B of N` or `Partial read (lines ... bytes ...)`.
- run_command: `Command exited with code N.\n\nCommand output:\n...`; or `The tool's output was truncated due to being too long...` (13); or `Tool is running as a background task with task id: ...` (RUNNING).
- edit/write: `Made N replacement in <path>`, `Created file.`, `The following changes were made by the replace_file_content ...` (contains `<original_line>`/`<line_number>` tags).
- send_message / manage_task / invoke_subagent: `Message sent to "<uuid>"`, `Task: <uuid>/task-N`, `Created the following subagent:`.
- error: `Encountered error in step execution: <reason>` (`file does not exist`, `declaring permissions: ...`, `permission check failed...`).

## 3. Injected context: what is and is not in the transcript

**The transcript holds no system prompt, no tool definitions, no rules, no workflows, no knowledge items/memories, no skill list.** Searches for `<user_rules>`, `KnowledgeItem`, memory/knowledge markers found only the user's own file contents. Those parts are invisible but billed: the first request of each conversation already totals **4.4k to 16.5k tokens** (input, cache 0) when visible text is under ~10k characters. That unattributed baseline must be shown as its own item (gauge minus sum of estimates).

What *is* visible, by tag/markers:

- **USER_INPUT.content** = `<USER_REQUEST>...</USER_REQUEST>` (138/138) + `<ADDITIONAL_METADATA>...</ADDITIONAL_METADATA>` (138/138) + optionally `<USER_SETTINGS_CHANGE>...</USER_SETTINGS_CHANGE>` (28). The metadata block has plain-text sections: `The current local time is: ...`, `The user's current state is as follows:`, `Active Document: <path> (LANGUAGE_...)`, `Cursor is on line: N`, `Other open documents:` followed by `- <path> (LANGUAGE_...)` lines (197 lines across 58 turns), and, when the user used an `@[...]` mention, `The user has mentioned some items in the form @[ITEM]` with `<path> is a [Slash Command]:` and a `<SKILL>The user requested you read and use the "<name>" skill...</SKILL>` block (7 turns). So open files, slash commands/workflows and skills the user invokes are visible **as paths and text inside the user turn**.
- **Model name**: only via `<USER_SETTINGS_CHANGE>The user changed setting \`Model Selection\` from <X|None> to <Y>...`. Values seen: `Gemini 3.8 Flash (Medium)`, `Gemini 4 Argon (Medium)`, `Gemini 4 Argon (Low)`. It is a delta: conversations with no such line (8 of 32) have no model name in the transcript. Current model = the last `to <Y>`. Elsewhere on disk, `antigravity_stats_cache.json` has `"model": "Gemini 3.8 Flash" | "Argon 4" | "Gemini 3.5 Flash" | "Gemini 3.7 Flash" | "Claude Opus 4.6"`. No context-window size or token limit appears anywhere (transcripts, stats cache, logs): the limit table must be built into the extension. Highest total seen: 181,544.
- **SYSTEM_MESSAGE.content** = fixed preamble `The following is a <SYSTEM_MESSAGE> not actually sent by the user...` then `<SYSTEM_MESSAGE>[Message] timestamp=... sender=<system|uuid|uuid/task-N> priority=MESSAGE_PRIORITY_<HIGH|LOW> content=...</SYSTEM_MESSAGE>`. Variants: background task finished/cancelled, "subagents stopped due to server restart", message from parent agent.
- **Files, rules, workflows, skills, AGENTS.md, knowledge artifacts the agent loads** appear only as `view_file`/`read_file` calls plus the paired result. Classify by path: `/.agents?/skills?/...` or `.../skills/<n>/SKILL.md` (10 reads), `/.agents?/workflows/`, `/.agents?/rules/`, `GEMINI.md`, `AGENTS.md`/`CLAUDE.md` (8 reads), `.gemini/antigravity/brain/` or `/knowledge/` (6 reads), else plain file (402). Counts are small; heuristic is path-regex only.
- **Media**: `media: [{mime_type, uri}]` on the step; the file is in `.user_uploaded/`. Token cost of an image is not derivable from text.

## 4. transcript.jsonl vs transcript_full.jsonl

Same number of lines and same `step_index`/`source`/`type`/`status`/`created_at`/token values in every conversation (both files written at the same instant; mtimes identical). Differences:
- `transcript.jsonl` truncates `content`, `thinking`, and `tool_calls` string values to about 4,000 characters (observed truncated lengths 4,016 to 4,121; no ellipsis marker, cut text is just shorter) and adds `"truncated_fields": ["content"|"thinking"|"tool_calls", ...]` (292 steps; content 225, tool_calls 54+, thinking 13+).
- In `transcript.jsonl` **every tool-call arg value is a JSON-encoded string** (e.g. a string value shows up as `"\"ls -la\""`, numbers as `"5000"`); in `transcript_full.jsonl` args are native JSON values.
- Consequence: `transcript_full.jsonl` is the one to read (accurate lengths for the estimator, native args). `transcript.jsonl` can be larger or smaller on disk than full (e.g. 4571 vs 4551 bytes) because of the encoding and `truncated_fields`.

## 5. Write pattern

- **Append-only, one line per completed step, never updated in place.** Evidence: RUNNING steps (21) are never followed by a later line with the same index; completion of a background task arrives later as a new SYSTEM_MESSAGE step. Stale lines stay (see rewinds).
- All of `transcript.jsonl`, `transcript_full.jsonl`, and the newest chunk files of both share one mtime (delta 0.0s), i.e. written together.
- File mtime trails the last step's `created_at` by 0 to 20 s (median ~5 s). A step is written when it finishes, so during a long tool call or a long generation the file does not change; the latest step lags reality. Consecutive step `created_at` gaps: median 2 s, p90 11 s, 37% within the same second (planner step and its tool result share a timestamp).
- Chunk files roll at 102400 bytes; a reader of the monolithic file sees the same bytes. A live read can catch a partial last line (observed in a chunk): tolerate an unterminated final line and only parse complete lines.
- No live-growth sampling was possible (no conversation was being written during the session); the above is inferred from timestamps, not observed.

## 6. Rewinds, compaction, truncation

- **Rewind / edit-and-resubmit exists and shows as `step_index` going backwards.** Conversation `24161983` (391 lines): line order goes step 300, then a USER_INPUT at step 210, then 211, 212... up to 299 again. The old steps 210..300 remain earlier in the file (superseded). Also 6 conversations have non-sorted index sequences and one has a duplicate index (315, USER_INPUT twice). Rule: reading in file order, when an entry's `step_index` <= the last kept one, drop all kept entries with index >= it and append. The gauge uses the last *kept* planner step; the observed total drops from 173,219 to 97,204 across the rewind.
- **No compaction or summarisation trace**: no step type, tag, marker, or token drop other than the rewind above. Searches for checkpoint/summary/compact markers matched only unrelated user content. The max observed context (181k) is not necessarily near any limit, so compaction behaviour at the limit is **unknown from this data**.
- **One unexplained drop**: `cd5f84af` total 65,501 (step 62) then 52,047 (step 64), with cache 0 both times, a 12-minute idle gap, and only small messages added. Not a rewind (index moved forward). Hypotheses: something dynamic (injected context) shrank, or hidden history trimming. Treat gauge values as "latest reported", not monotonic.
- **Truncation of tool output** is visible in content: `The tool's output was truncated due to being too long` (13) and view_file `Showing lines A to B` of `Total Lines` / "not shown" notes. Token estimates should use the text actually present in `content`, not the file size.

## 7. Is latest `input_tokens + cache_read_tokens` a sound fullness measure?

Verdict: **yes, with caveats.**

- Over 778 consecutive planner-step pairs (cache or no cache), the total grows by a median of **709 tokens** per step; only 2 of 778 decrease (the rewind and the unexplained one above).
- `input_tokens` **excludes** cached tokens: in 654 of 804 steps `cache_read_tokens` > `input_tokens` (e.g. in 4k / cache 162k), and the next step's `cache_read_tokens` is about the previous step's `input+cache` (median ratio 0.96; median difference -2,039; i.e. the cache covers the prior prompt minus a ~2k uncached tail). Minimum `input_tokens` is ~2,050 in every conversation that uses the cache. So the sum is the full prompt size sent for that request, which is the right "context used" number.
- Conversations/steps with `cache_read_tokens` = 0 (123 pairs: cache expired after idle, or conversation never cached) show `input_tokens` alone equal to the whole prompt; the sum remains valid.
- Growth is consistent with content added: chars of (prior tool_calls JSON + tool results + user text) divided by the total delta gives a median **~2.9 chars per token** (IQR 2.3 to 3.3, n=411). Use ~3 chars/token for `~est` of text; this is rougher for code/JSON-heavy text.
- `output_tokens` appears to include thinking (visible content+tool_calls is only ~1.7 chars/output-token; with thinking text, ~2.2). Whether the model re-sends thinking next turn is not determinable.
- Caveats: (a) the number is the prompt of the *last completed request*, so it excludes the reply and whatever tools returned since; the next request will be bigger by the last output + results; (b) a baseline of 4k to 16k hidden tokens is inside it; (c) steps without counts (user input, tool results, system messages, and everything in older conversations) have no number: use the last planner step that has one; (d) after a rewind use the last kept step; (e) the context limit is not in the data.

## 8. Proposed Context Item kinds and detection

Walk the kept (post-rewind) steps; each kind below has an estimated token count (`~chars/3`) except the hidden baseline, which is the remainder `gauge_total - sum(estimates)` (clamped at 0).

| Kind | How to detect | Text to size |
|---|---|---|
| User message | `source=USER_EXPLICIT type=USER_INPUT`; text between `<USER_REQUEST>` and `</USER_REQUEST>` | that text |
| Editor state | same step; `<ADDITIONAL_METADATA>` block (time, Active Document, cursor, `Other open documents:` list) | that block |
| Mention (workflow / skill) | inside metadata: `is a [Slash Command]` or `<SKILL>...</SKILL>`; name from the path or the skill attribute | that block |
| Settings change | `<USER_SETTINGS_CHANGE>`; also gives model name | that block |
| Model reply | `type=PLANNER_RESPONSE`, non-empty `content` | content |
| Thinking | `PLANNER_RESPONSE.thinking`; show but flag "may not be resent" and exclude from the sum by default | thinking |
| Tool call | `PLANNER_RESPONSE.tool_calls[]` (group by `name`) | JSON of name+args |
| File read | tool call `view_file` / `read_file`, paired GENERIC result (the `File Path:` line gives the path) | result content |
| Rule / Workflow / Skill / AGENTS.md / Knowledge-artifact (files) | a File read whose path matches the regexes in section 3 (sub-kind of File read; cannot detect auto-injected rules or KIs) | result content |
| File edit | `edit_file`, `replace_file_content`, `write_file`, `write_to_file` (args carry the new text; result is a short ack) | args + result |
| Command output | `run_command` + GENERIC (`Command exited with code`, truncated marker, or background-task marker) | result content |
| Web | `search_web`, `read_url_content` | result content |
| Agent coordination | `invoke_subagent`, `manage_subagents`, `send_message`, `manage_task`; `SYSTEM_MESSAGE` steps | args + result / message text |
| Tool error | `status=ERROR` or `error` key | content |
| Media | `media` key | not countable (show count) |
| Hidden baseline (system prompt, tool defs, rules, KIs, memories) | not in the transcript: remainder of the gauge | n/a |

Pair GENERIC results to planner tool calls positionally (section 2). Mark all counts `~est` except the gauge.

## 9. Open questions raised

1. Where is the active model, and its context-window limit, stored (e.g. `state.vscdb`, `conversations/*.db`, `conversation_summaries.db`)? The transcript only has model-change deltas and no limit.
2. What does Antigravity do near the limit (compaction)? Max seen is 181k; no trace either way.
3. Cause of the 65.5k to 52.0k drop in `cd5f84af` (hidden trimming?).
4. How are auto-injected rules/KIs/memories stored, and are they reconstructable for per-item inventory? Not present in the brain folder.
