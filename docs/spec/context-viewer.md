# Context Viewer: build spec

Handoff spec for a personal Antigravity (VS Code fork) extension. Terms (Token Gauge, Context Inventory, Context Item, Active Conversation, Recent Conversation, Threshold, Compaction, Baseline, ...) are used exactly as defined in [GLOSSARY.md](../../GLOSSARY.md).

Decisions: [ADR 0001: language server RPC primary source](../adr/0001-rpc-primary-source.md), [ADR 0002: stat polling](../adr/0002-stat-polling.md).

## 1. Goal, non-goals

**Goal.** View-only display, per window, of:
- a **Token Gauge** in the status bar (tokens used vs the model's Context window), and
- a **Context Inventory** tree in a sidebar view, for the **Active Conversation** plus up to `maxConversations` - 1 **Recent Conversations**.

Jobs: watch the budget, debug the agent. Live (a few seconds of lag is fine) plus a manual refresh.

**Platform.** Antigravity IDE 2.6.0 (VS Code base 1.107) with a WSL2 remote window; the extension host is Node 22.21.1 (WSL server). Undocumented internal state is read read-only; breakage on Antigravity updates is accepted. Personal use, installed from a local `.vsix`.

**Non-goals.**
- Editing or curating the context (view only).
- A full transcript viewer. (Opening ONE step, System Prompt section or tool as a read-only tab is allowed, section 7.4; a whole-transcript view is not.)
- Publishing to Open VSX.
- Patching, injecting into, or modifying Antigravity (see section 9).
- Push updates, server data for Windows-local windows, plain VS Code support (section 14).

Why: [Map](../../wayfinder/context-viewer/map.md), [What shape does the handoff spec take, and what goes in it?](../../wayfinder/context-viewer/18-spec-assembly.md).

## 2. Settings

All under `contextViewer.*`, declared in `package.json` `contributes.configuration`. Threshold and Context window settings are all entered in thousands of tokens (k); `config` converts Context window values to tokens.

| Key | Type | Default | Effect |
|---|---|---|---|
| `roots` | string[] | `["~/.gemini/antigravity/"]` | Data roots to scan (each has `brain/`, `conversations/`, `annotations/`, `conversation_summaries.db`). `~` expanded. Change => rescan Conversations. |
| `maxConversations` | number (>=1) | `3` | Caps tree roots, counting the Active Conversation (the status bar shows Active only). Recent = max - 1. Change => re-rank Recent. |
| `recentExpiryMinutes` | number | `3` | A Recent Conversation is dropped this many minutes after it entered the Recent list. |
| `threshold` | number or null (1–10000) | `150` | Threshold in **thousands** for models not in `thresholdPerModel`. Sets the colours from context actually used, independent of the Context window. Cleared (null) => the model's Context window is the Threshold. |
| `thresholdPerModel` | object `{ "<model key>": number }` | `{}` | Per-model Threshold in **thousands** (`190` = 190k). Model key as in section 5. |
| `contextWindow` | number or null (1–10000) | `null` | Last-resort Context window in **thousands** (`256` = 256k). The model's maximum: denominator of the figures and heavy-item %; never changes the colours. Empty => no limit known. |
| `contextWindowPerModel` | object `{ "<model key>": number }` | `{}` | Per-model Context window override in **thousands**. Highest priority in section 5. |
| `heavyItemPercent` | number | `5` | Chat Messages items above this % of the Context window are highlighted (error colour). |
| `hoverChars` | number | `2000` | Hover cut-off for chat item text: head = 75%, tail = 25%; thinking budget = 50%. |
| `logLevel` | `off`/`error`/`info`/`debug` | `error` | Output channel verbosity; applied immediately. `error`: failures; `info`: + data-source switches; `debug`: + each poll hit and RPC call timing. |

Each fallback and its per-model map are separate keys (no dotted `.default` keys: VS Code nests those inside the map, which showed a confusing `default` entry). Units are stated first in each setting's description; the min/max bounds make the Settings UI flag a value entered in the wrong unit.

Settings reactions: threshold/colour/`heavyItemPercent`/`hoverChars` => redraw only; `roots` => rescan; `maxConversations` => re-rank Recent; `logLevel` => apply now. No other settings (poll intervals are constants, section 6).

Why: [How should the status bar gauge and sidebar tree look and behave?](../../wayfinder/context-viewer/07-ui-prototype.md), [How do the data sources, watching, parsing and UI fit together?](../../wayfinder/context-viewer/15-architecture.md), [How much raw content does a hover show, and does it ever show tokens or account details?](../../wayfinder/context-viewer/17-hover-content.md), [How is the model's context limit worked out when no source gives it?](../../wayfinder/context-viewer/06-model-limits.md), [Which kinds of Context Item does the inventory show, and how are they grouped?](../../wayfinder/context-viewer/05-context-item-taxonomy.md).

## 3. Discovery

Module `discovery`. Pure functions where possible; filesystem injected.

### 3.1 Roots and Conversation list
- Roots: `contextViewer.roots`. Default only `~/.gemini/antigravity/` (WSL side; the only live root). Windows-side and `antigravity-ide` roots are stale or legacy and are not defaults.
- Layout under a root:
  - `brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl` (never `transcript.jsonl`: it truncates strings to ~4k chars).
  - `conversations/<conversation-id>.db` (+ `-wal`, `-shm`), SQLite WAL mode.
  - `annotations/<conversation-id>.pbtxt`: one-line text protobuf, `title:"..." last_user_view_time:{seconds:N nanos:N}`.
  - `conversation_summaries.db`, table `conversation_summaries(conversation_id, title, preview, step_count, last_modified_time, ...)`. Conversation ids = `conversations/<id>.db` names.
- Missing root => skipped; none exist => empty state (section 7.5).
- Ignore `source = CORTEX_TRAJECTORY_SOURCE_CLI` rows with no `conversations/<id>.db`.

### 3.2 Title
First non-empty of: `conversation_summaries.title` > `.preview` > first user prompt (text inside `<USER_REQUEST>`) cut to ~40 chars, plus last-activity time (`HH:mm`).

### 3.3 Active Conversation (selection)
- Per window. Source: `lastConversationId` in this window's workspace `state.vscdb`, table `ItemTable`, key `google.google-antigravity` (JSON value). The file is under `workspaceStorage/<hash>/state.vscdb` where `<hash>` is the folder name of `context.storageUri`'s parent; WSL windows keep it on the Windows side (`/mnt/c/Users/<user>/AppData/Roaming/Antigravity IDE/User/workspaceStorage/<hash>/state.vscdb`; the data dir is `Antigravity IDE`).
- Copy the file (plus `-wal`/`-shm` if present) before reading; a copy taken mid-write can be broken (`no such table: ItemTable`): retry on the next poll.
- Value is cleared on a new empty chat. Update lag ~0.1-1 s.
- `annotations/*.pbtxt` `last_user_view_time` is NOT the selection signal (every switch stamps old and new Conversation equally); it means "last seen" and is used for Recent ranking only.
- **Nothing selected** (cleared id, or viewing another workspace's chat): keep showing the last Active Conversation, state `notSelected` (section 7). On a fresh window with no prior Active: the Conversation whose `workspace_uris` matches this window's folder with the latest write, also `notSelected`.
- If the `state.vscdb` is unreadable: fall back to the Conversation with the newest transcript write.
- A Conversation that becomes Active takes the Active slot; if it was Recent, its expiry timer is cancelled.

### 3.4 Recent Conversations
- Candidates: any workspace. Rank key = later of (last seen = `annotations` `last_user_view_time`) and (last written = `conversation_summaries.last_modified_time`).
- Every 5 s: re-read only `annotations/*.pbtxt` whose mtime changed, plus `conversation_summaries.db` (titles, last-written).
- Take the top `maxConversations - 1`, excluding the Active one.
- Each Recent Conversation has a timer of `recentExpiryMinutes` held in the store, starting when it enters the list. Expiry removes its tree root. The status bar is unaffected: it shows only the Active Conversation.
- Countdown text: minutes only (`drops in 3m`, then `<1m`); redraws every 15 s; shown in the tree root description, and only in the tooltip on the status bar.

Why: [Can the extension detect which Conversation is selected?](../../wayfinder/context-viewer/01-selection-signal.md), [Does switching Conversations update the selection signals as expected?](../../wayfinder/context-viewer/10-selection-click-test.md), [With several windows open, which Conversation is Active?](../../wayfinder/context-viewer/11-multi-window-active.md), [Which .gemini data store is the best source for titles, model and tokens?](../../wayfinder/context-viewer/09-gemini-data-stores.md), [Which brain root and data folder does the current IDE write to?](../../wayfinder/context-viewer/08-active-brain-root.md); research: [selection-signal](../research/selection-signal.md), [selection-click-test](../research/selection-click-test.md), [gemini-data-stores](../research/gemini-data-stores.md).

## 4. Sources

Both sources produce the same `Snapshot` type (section 6). Source is shown as `rpc` or `file`. Preference: `rpc`, falling back to `file` per [ADR 0001](../adr/0001-rpc-primary-source.md).

### 4.1 `rpc` source (`sources/rpc`)

**Process lookup** (at activation, and on every recovery attempt):
1. Scan `/proc/<pid>/cmdline` (NUL-separated; never `environ`).
2. Candidates: processes whose args include `--csrf_token=` and `--hub-port=<N>` (older builds: `--extension_server_port`) and `--app_data_dir` in {`antigravity`, `antigravity-ide`}; binary `~/.gemini/bin/agy`.
3. Choose the candidate whose parent PID is this extension host's process (or its parent). Fallback match: `--add-dir=<folder>` equals one of `vscode.workspace.workspaceFolders`.
4. Skip orphans (`ppid = 1`): most servers on a machine are orphans. Never pick "the server with the most entries" (could be another window's view).
5. Keep port and token in memory only.

**Request.** `POST http://127.0.0.1:<hub-port>/exa.language_server_pb.LanguageServerService/<Method>`; headers `Content-Type: application/json`, `Connect-Protocol-Version: 1`, `X-Codeium-Csrf-Token: <token>`; body JSON (`{}` or `{"cascadeId":"<id>"}`). Plain HTTP on the hub port (the second ephemeral port is HTTPS self-signed; do not use). ~30-45 ms per call.

**Allowlist** (hard, in code, single call chokepoint; see section 9): only `GetCascadeTrajectoryGeneratorMetadata`, `GetAllCascadeTrajectories`, `GetTokenBase`. Anything else throws before sending. `GetUserStatus` is never called by the product code.

**`GetCascadeTrajectoryGeneratorMetadata {cascadeId}` => Snapshot.** Response `generatorMetadata[]`, one entry per LLM call; use the last entry:
- `chatModel.usage.inputTokens`, `.cacheReadTokens` (int64 as strings; `cacheReadTokens` absent on cold calls => 0), `.outputTokens`.
- **used** = `inputTokens + cacheReadTokens` (billed + cached; same figure as file source so switching sources never jumps the gauge).
- `chatModel.chatStartMetadata.contextWindowMetadata.maxContextTokens` (256000), `.estimatedTokensUsed` (Antigravity's estimate; tooltip only), `.tokenBreakdown.groups[]` = `{name, numTokens, children[{name,numTokens}]}` with groups `System Prompt`, `Tools`, `Chat Messages`; Chat Messages children are named `"<stepIndex>: <STEP_TYPE>"`.
- Model: `chatModel.modelDisplayName` (else `responseModel`); the internal `model` enum is not used.
- `chatStartMetadata.checkpointIndex`, `.startStepIndex`, `contextWindowMetadata.truncationReason` feed Compaction (section 8).
- Reply has no pagination and grows ~6 KB per call: keep only the latest breakdown + running totals (sum of usage over entries, compaction count, model-change points); discard the rest. Reply must be gated on shape; unexpected shape => treat as failure.
- Optional: `GetTokenBase` itemizes `TOKEN_TYPE_RULES` and `SKILLS` with per-item `numTokens`; show per-rule/per-skill children under `user_rules`/`skills` ONLY if the children sum to the section total (build-time confirm), else section total only.

**Pull on change, never on a fixed timer.** When a tracked transcript or `conversations/<id>.db` changes (stat, section 6), wait 500 ms for activity to settle, then call. At most one call in flight per Conversation, plus one follow-up if a change arrived during it. If a reply takes > 2 s, back off to one call per 10 s for that Conversation. Log reply size and fetch time at debug level.

**Recovery.** On connection failure or HTTP 401/403: switch every Conversation to `file` at once; retry the lookup after 5 s, 15 s, 30 s, then every 60 s; success switches back to `rpc`. Manual Refresh retries the lookup immediately. If the server cannot return a Conversation's details, use `file` for that Conversation only.

**Stale-server guard.** If the server's latest call trails the transcript's last planner step for 2 consecutive checks, treat it as stale: switch to `file` and look up the server again.

### 4.2 `file` source (`sources/file`)

**Transcript** (`transcript_full.jsonl`, UTF-8, append-only, one JSON object per completed step). Keys: `step_index, source, type, status, created_at`; optional `content`, `thinking`, `tool_calls[{name,args}]`, `input_tokens`, `cache_read_tokens`, `output_tokens` (always together), `error`.
- Incremental read: keep one byte position per file; read from there; read from the top if the file shrinks. Handle partial last line (do not advance past an unterminated line).
- Rewind rule: in file order, when an entry's `step_index` <= the last kept step's, drop all kept entries with index >= it, then append. Gauge uses the last kept planner step.
- **used** = `input_tokens + cache_read_tokens` of the last kept `source: MODEL, type: PLANNER_RESPONSE` step that has counts. No such step (older Conversations) => `n/a`.
- Only PLANNER_RESPONSE steps carry tokens. `CHECKPOINT` tokens never count (section 8).
- Context Items (all `~est`, ~3 chars per token): user message (text between `<USER_REQUEST>` tags), model reply (`content`), tool call + paired result merged (a PLANNER_RESPONSE with k tool calls is followed by k `GENERIC` steps in order; pair by position), `SYSTEM_MESSAGE`, errors (`status=ERROR` or `error`). Kind => icon: user message, model reply, file read (`view_file`, `read_file`), file edit (`edit_file`, `replace_file_content`, `write_file`, `write_to_file`), command output (`run_command`), web (`search_web`, `read_url_content`), agent coordination (`send_message`, `invoke_subagent`, `manage_subagents`, `manage_task`), error. Thinking is not an item (hover only).
- **Baseline** = `used` minus the sum of Chat Messages estimates, shown as one `~est` item replacing System Prompt + Tools (when the db breakdown is not available).

**SQLite** (`conversations/<id>.db`): model, limit, breakdown, when readable.
- Built-in `node:sqlite` (`DatabaseSync`). Copy `<id>.db`, `-wal`, `-shm` together into the extension storage folder; open the COPY read-write (so SQLite merges the WAL into the copy); never open the originals; re-copy only when the source `.db` or `-wal` mtime or size changed. Avoid opening anything in place over `/mnt/c`.
- Table `gen_metadata(idx PK, data BLOB, size)`, one row per model call; read the LAST row only for the fields below, but never log the last row's large blob (request snapshot); it is displayed only per explicit Open (7.4). Protobuf field paths inside `data`: `.1.4.2` input tokens, `.1.4.5` cache read (absent = 0), `.1.4.3` output tokens, `.1.21` display model name (e.g. `Gemini 3.8 Flash (Medium)`), `.1.9.10.4` model context limit, `.1.9.10.1` agent's estimate, `.1.9.10.3.1[]` breakdown `{1 name, 4 tokens, 5[] {1 name, 3 tokens}}`, `.1.9.1` startStepIndex (Compaction cross-check).
- Request snapshot paths used ONLY by the explicit "Open" action (section 7.4), found 2026-11-09: `.1.16[]` = System Prompt section `{1 name, 2 text}` (name = the `.1.9.10.3.1[]` System Prompt child name, e.g. `identity`, `user_rules`); `.1.8[]` = tool definition `{1 name, 2 description, 3 parameters schema (JSON text)}` (name = the Tools child name). `.1.1` is the same prompt concatenated and is not used. Mapping: exact name match, else case/punctuation-insensitive; first match wins; no match => one-line "Text unavailable" document. The `user_information` section (any spelling) is never read or shown.
- If `node:sqlite` is unavailable: file mode uses the transcript only (no model, limit, or breakdown; gauge `ctx 124k / ?~`).
- Model for a Conversation with no `gen_metadata` rows: `last_selected_agent_model` in `~/.gemini/antigravity/antigravity_state.pbtxt` (global).
- Do NOT use `antigravity_stats_cache.json` (stale, inconsistent) or the `trajectorySummaries` key in the global `state.vscdb` (stale protobuf index).

**Tree in file mode.** Same tree as `rpc`: System Prompt / Tools / Chat Messages with Antigravity's counts from the db breakdown if read (see section 7.2 on how they relate to the gauge); otherwise Baseline + Chat Messages, all `~est`. Trailing `~` on the status bar figure.

Why: [What can the language server's RPC tell us, and can we reach it reliably?](../../wayfinder/context-viewer/13-language-server-rpc.md), [Files only, or language-server RPC with files as fallback?](../../wayfinder/context-viewer/14-data-source-strategy.md), [How do the data sources, watching, parsing and UI fit together?](../../wayfinder/context-viewer/15-architecture.md), [What do transcripts contain, and how do they map to Context Items?](../../wayfinder/context-viewer/03-transcript-format.md), [Which .gemini data store is the best source for titles, model and tokens?](../../wayfinder/context-viewer/09-gemini-data-stores.md), [Which kinds of Context Item does the inventory show, and how are they grouped?](../../wayfinder/context-viewer/05-context-item-taxonomy.md), [What do the gauge and inventory show when Antigravity compacts or drops earlier context?](../../wayfinder/context-viewer/16-compaction.md); research: [language-server-rpc](../research/language-server-rpc.md), [transcript-format](../research/transcript-format.md), [gemini-data-stores](../research/gemini-data-stores.md), [gauge-figure-check](../research/gauge-figure-check.md).

## 5. Limits

Module `limits`. The Context window per model, first match wins:

1. `contextViewer.contextWindowPerModel["<model key>"]` (user override)
2. live server `maxContextTokens`
3. Conversation database `.1.9.10.4`
4. remembered limits (extension `globalState`, key per model; every limit seen from 2 or 3 is saved)
5. built-in table: `Gemini 3.8 Flash` = 256000, `Gemini 4 Argon` = 256000 (confirmed values only; no guesses for Claude or GPT-OSS)
6. `contextViewer.contextWindow` (empty by default)

- **Model key** = display name without the effort level in brackets: `Gemini 3.8 Flash (Medium)` => `Gemini 3.8 Flash`. Convert every source to it.
- No limit from anywhere: status bar `ctx 124k / ?`, no percentage; tooltip says limit unknown.
- Tooltip names the limit source (`override`/`server`/`database`/`remembered`/`built-in`/`default`).
- Model switch mid-chat: keep the last call's model and limit until the next turn (the new model appears per call in the data); never show the newly picked model in advance.
- The only persisted state in the extension is the remembered limits.

Why: [How is the model's context limit worked out when no source gives it?](../../wayfinder/context-viewer/06-model-limits.md), [Which .gemini data store is the best source for titles, model and tokens?](../../wayfinder/context-viewer/09-gemini-data-stores.md).

## 6. Model, store, poller

### 6.1 Modules
`config`, `discovery`, `sources/rpc`, `sources/file`, `limits`, `model`, `ui/statusBar`, `ui/tree`, `ui/decorations`. Views subscribe to `model` only and never touch a source. Dependency direction: sources -> model <- views; `discovery` feeds `model` the tracked set.

### 6.2 Snapshot (raw facts only, no colours)
```ts
interface Snapshot {
  conversationId: string; title: string;
  source: 'rpc' | 'file';
  used: number | null;           // input + cache read; null = n/a
  limit: number | null; limitSource: string;
  modelKey: string | null; modelDisplay: string | null;
  estimate: number | null;       // Antigravity's own estimate (tooltip)
  groups: Group[];               // System Prompt/Tools/Chat Messages, or Baseline + Chat Messages (~est)
  totals: { input: number; cacheRead: number; output: number; calls: number };
  compaction: { count: number; manual: number; lastStep?: number; was?: number } | null;
  modelChanges: { step: number; from: string; to: string }[];
  startStepIndex: number | null;
  notSelected: boolean; role: 'active' | 'recent'; expiresAt?: number;
}
```
Items hold only labels, step index, kind and counts, never text (hover reads text lazily, section 7.4). A pure `classify(used, threshold)` in `ui/` derives colour at render time, so settings changes only redraw.

### 6.3 Store
- One snapshot per tracked Conversation; emits change events; owns Recent expiry timers.
- In memory only; rebuilt within one poll after restart. Only remembered limits persist (`globalState`).
- **Refresh** (tree title button + command): find the server again, ignore the "only when a file changed" check, re-read every tracked Conversation from its best source. Does not reset expiry timers.

### 6.4 Stat poller (no `fs.watch`; see [ADR 0002](../adr/0002-stat-polling.md))
One poller comparing (mtime, size):

| Target | Interval | Unfocused window |
|---|---|---|
| Tracked Conversations' `transcript_full.jsonl` and `conversations/<id>.db` (+ `-wal`) | 1.5 s | 7.5 s |
| This window's `state.vscdb` (selection) | 1 s | 5 s |
| `annotations/` listing + `conversation_summaries.db` | 5 s | 25 s |

Unfocused = 5x slower, catches up at once on focus. Every poller and timer stops on deactivate. `fs.watch` is not used anywhere (it does not fire on `/mnt/c`).

### 6.5 Lifecycle
Activate on `onStartupFinished`. Deactivation disposes the poller, timers, and the status bar item.

Why: [How do the data sources, watching, parsing and UI fit together?](../../wayfinder/context-viewer/15-architecture.md), [Where does the extension run under WSL, and what can it reach?](../../wayfinder/context-viewer/04-extension-host-wsl.md); research: [extension-host-wsl](../research/extension-host-wsl.md).

## 7. Views

### 7.1 Status bar (`ui/statusBar`)
- Right-aligned (`StatusBarAlignment.Right`, priority 100). One item, always the Active Conversation; Recent Conversations show only in the tree. Label = level dot, title cut to ~18 chars at a word break with `…`, then the figures: `🟡 Fix WSL path… · 62% · 159k/256k`. No limit: `🟢 Fix WSL path… · 124k / ?`. File mode: trailing `~` (`… · 62% · 159k/256k~`). Used `n/a`: `⚪ Fix WSL path… · n/a`. `$(` in a title is escaped so it never renders as an icon.
- Percentage = used ÷ limit, rounded; may exceed 100% after Compaction (`110% · 282k/256k`).
- Click => reveal that Conversation's root in the tree (command focuses the view and reveals the item).
- Hover = the Active Conversation's tooltip (below).
- Empty: `◌ ctx —`, tooltip "No Conversation yet".
- Not selected: muted text colour (theme disabled foreground) unless an amber/red background applies, tooltip first line "Not selected: last viewed Conversation in this window".

**Tooltip** (trusted-off Markdown): title; model (display name, with effort level); `used / limit`; Antigravity's estimate (labelled `Antigravity estimate`); Threshold row `40% of 190,000 · thresholdPerModel["Gemini 3.8 Flash"]` (shows `default` when the default applies; omitted if no Threshold); limit source; data source (`rpc`/`file`); running totals (input, cache read, output, calls); Compaction lines (section 8).

**Colour** = `used ÷ Threshold` for the status bar item and per Conversation root icon, via pure `classify`:

| Ratio | Status bar | Tree icon |
|---|---|---|
| <= 50% | 🟢 dot | no tint |
| > 50% | 🟡 dot | yellow tint |
| > 80% | 🟠 dot + amber (`statusBarItem.warningBackground`) | amber tint |
| > 100% | 🔴 dot + red (`statusBarItem.errorBackground`) | red tint |
| no Threshold | ⚪ dot, no background | no tint |

The status bar text keeps the theme's foreground: coloured text on the status bar background was hard to read (QC, about 2.4:1 contrast for green on the default blue). The dot carries the level.

Threshold lookup: `thresholdPerModel["<model key>"]` > `threshold` (150) > the model's Context window if `threshold` is cleared > none. The `notSelected` dim applies when there is no background.

### 7.2 Tree (`ui/tree`)
- One view, **Context Inventory**, in its own activity-bar container. Each Conversation is a root: Active first, expanded; Recent after, collapsed; cap `maxConversations`.
- Root label = title; description `62% · 159k/256k · rpc`; Recent adds `· drops in 2m`; compacted adds `· compacted`; `notSelected` adds `· not selected` with a greyed (disabled foreground) icon.
- Children of a root: groups **System Prompt**, **Tools**, **Chat Messages** (Antigravity's own counts in `rpc`/db mode). File mode without db: **Baseline** (`~est`) + **Chat Messages** (`~est`).
- **Breakdown vs gauge.** The breakdown sums exactly to Antigravity's estimate (`estimatedTokensUsed` / `.1.9.10.1`), not to the billed gauge figure (checked on 6 Conversations, 2026-11-09: e.g. billed 14,086 vs breakdown 19,670; 89,700 vs 92,241). Groups are not rescaled. The root description adds `· breakdown 19.7k (Antigravity est.)` when the breakdown is shown, and the root tooltip explains the difference.
- System Prompt: one child per named section (identity, ..., `user_rules`, `skills`, `user_information`, ...). Tools: one child per tool. Per-rule/per-skill children only if confirmed to add up (section 4.1).
- Chat Messages: time (step) order by default, one item per Step, tool call + result merged (counts added). Label `#<step> <tool or kind> <target> · <tokens>`, e.g. `#42 view_file src/foo.ts · 3.1k`; user messages: `#<step> ` + first ~40 chars. Kind shown as an icon (section 4.2 kinds). In file mode counts carry `~`.
- Items > `heavyItemPercent` of the Context window: tinted in the error colour. Tinting goes through a `FileDecorationProvider` on a synthetic `resourceUri` (`ui/decorations`); native trees cannot colour labels otherwise. "Dimmed" = theme disabled foreground (no opacity).
- Title buttons: **largest first** (toggle, Chat Messages only), **refresh**, **collapse all**.
- Token display: `3.1k`, `159k`; no `~` where they come from Antigravity's breakdown (`rpc`/db), `~Nk` where estimated from text.

### 7.3 Item data for the tree in `rpc` mode
Chat Messages children come from the breakdown names `"<stepIndex>: <STEP_TYPE>"`; labels (tool name, target, first prompt chars) are joined from the transcript by step index (read once per change, labels only). Merge a tool call with its result by position.

### 7.4 Hover (tree items)
- Loaded lazily in `resolveTreeItem`, reading that step from the transcript by step index. Store holds no text.
- Cut-off (`hoverChars` = 2000): first 1500 chars, then `… N chars omitted …`, then last 500. Thinking: own section headed `Thinking` with its own `~Nk tok`, head only, up to 1000 chars (half of `hoverChars`).
- Non-chat items (System Prompt sections incl. `user_information`, Tools, rules, skills): name, token count, source (`rpc`/`file`/`~est`) only; their text is never fetched by hover.
- Masking: this window's live CSRF token (exact string) and the token-shape regex (the same one used by log redaction) are replaced with `‹csrf›`. Emails and paths are not masked. `GetUserStatus` data is never shown.
- Rendering: untrusted `MarkdownString` (`isTrusted: false`, `supportHtml: false`, no command links). User and model text as markdown; tool output in a fenced code block with backticks escaped.
- Step missing (compacted away or rewound): `text unavailable`, count still shown.

**Open (`contextViewer.openItem`).** Inline button and context menu on Chat Messages, System Prompt section and Tools items (`contextValue` `chat` / `section` / `tool`); also the click command of Chat Messages items. Opens a read-only virtual document (`TextDocumentContentProvider`, scheme `context-viewer`, language Markdown, `preview: true`); content is decoded lazily on open only and never cached by the extension.
- Chat Messages: ONE step per tab, full text with no cut-off, as Markdown sections: `User request`, `Thinking`, `Model reply`, `Tool call: <name> <target>` (args as JSON), `Tool result`. Masking: CSRF token and token shape (same as hover).
- System Prompt section / Tool: text from the request snapshot in the LAST `gen_metadata` row of the Conversation's db (section 4.2 paths), read from a private copy (`open-<id>.db`, existing copy mechanism). Masking: `maskSecrets` plus logger `redact` (tokens, emails, account fields). `user_information` is refused in the pure builder (normalised-name check before and after lookup; embedded `<user_information>` blocks stripped from other sections) and covered by tests.
- Failure (no db, no `node:sqlite`, parse error, name not found): one-line friendly document; no blob content is ever logged.
- Rules "Open file" (real rule file path via `GetTokenBase`) is not implemented: the reply's path field is unverified and not cheap to confirm.

### 7.5 Empty state
- Status bar `◌ ctx —`, tooltip "No Conversation yet".
- Tree `viewsWelcome`: "Open or start a Conversation in the agent panel." with a Refresh link.
- No configured root exists: welcome says so and links to the `contextViewer.roots` setting.

Why: [How should the status bar gauge and sidebar tree look and behave?](../../wayfinder/context-viewer/07-ui-prototype.md), [Which kinds of Context Item does the inventory show, and how are they grouped?](../../wayfinder/context-viewer/05-context-item-taxonomy.md), [How much raw content does a hover show, and does it ever show tokens or account details?](../../wayfinder/context-viewer/17-hover-content.md), [With several windows open, which Conversation is Active?](../../wayfinder/context-viewer/11-multi-window-active.md), [How do the data sources, watching, parsing and UI fit together?](../../wayfinder/context-viewer/15-architecture.md).

## 8. Compaction

Compaction (manual `/compact` or automatic) is not a distinct gauge state: the gauge shows the new figure, with no extra status bar text, and can pass 100% (red from Threshold colouring).

**Detection.**
- Transcript: a step `type: CHECKPOINT`, `source: SYSTEM`, content starting `# Resuming from a compaction`, followed by a summary; carries `checkpoint{includedStepIndexStart/End, sessionSummary, capturedUserRequests}`; automatic ones add `checkpointIndex` 1, 2, 3. Its token counts are the summarizing call's cost: never count toward the gauge.
- Server: the first call after Compaction has `chatStartMetadata.startStepIndex` = the CHECKPOINT step and `contextWindowMetadata.truncationReason = TRUNCATION_REASON_MAX_TOKEN_LIMIT` (also for manual). DB cross-check: `.1.9.1`.
- Manual vs automatic: manual iff the nearest earlier user message is `/compact` with no planner reply in between (real data has a SYSTEM_MESSAGE step between `/compact` and the CHECKPOINT, 2026-11-09).
- Model change (not Compaction): `modelChanges` from the per-call model; the billed drop is real and kept.

**Display.**
- Tooltip: `Compacted 4× (1 manual) · last at step 211 · was 281.7k` (`was` = the last planner figure before Compaction); `Compacts at ~256k (soft limit)` (uses the Context window; no forecast logic); after a model switch `Model changed at step 63: Gemini 4 Argon → Gemini 3.8 Flash`. Antigravity's estimate stays, labelled as such (it is NOT a fixed offset from billed: higher when small, up to 25% lower when large).
- Tree: Chat Messages lists only steps from `startStepIndex`; first item is `#25 Compaction summary · 1.5k` with its own icon; hover = summary text (cut per section 7.4). Dropped steps are not shown. Root label adds `· compacted`.
- File mode: a CHECKPOINT step drops all earlier steps from the tree (`~est`).
- Trigger (~70% confidence, informational only): last billed + estimated new tool results >= limit. Billed can exceed the limit.

Why: [What do the gauge and inventory show when Antigravity compacts or drops earlier context?](../../wayfinder/context-viewer/16-compaction.md); research: [compaction](../research/compaction.md).

## 9. Safety rules

All in one place so they can be audited. Cf. [ADR 0001](../adr/0001-rpc-primary-source.md).

1. **Method allowlist.** The CSRF token also authorises write methods (send message, cancel, settings). One function sends every RPC; it checks the method against a constant allowlist (section 4.1: `GetCascadeTrajectoryGeneratorMetadata`, `GetAllCascadeTrajectories`, `GetTokenBase`; Get/List names only) and throws otherwise. Allowlist is tested.
2. **Token handling.** CSRF token read from `/proc/<pid>/cmdline` only (never `environ`), held in memory, never written to disk, `globalState`, settings, logs, tooltips, or hovers. Logging redaction and hover masking drop the exact token plus a token-shape regex (UUID-like after `csrf_token=` / `X-Codeium-Csrf-Token`).
3. **`GetUserStatus` and account fields** (name, email, plan) are never called, logged, or shown.
4. **Read-only on Antigravity data.** Never write, rename, or delete under any root, `workspaceStorage`, or `globalStorage`. SQLite is read only from a copy (opened read-write on the copy only so SQLite can merge the WAL there); originals never opened; copies live in the extension storage folder.
5. **No patching or injection** into Antigravity, its bundled extensions, or the agent panel. Only public VS Code APIs plus file reads and loopback HTTP.
6. **Loopback only:** RPC to `127.0.0.1` hub port only.
7. **Webview-free:** no webviews; hovers are untrusted Markdown (section 7.4).
8. **Large blob guard:** the last `gen_metadata` row embeds a request snapshot; never log it. It is rendered only on an explicit "Open" of one System Prompt section or tool (section 7.4), masked, and NEVER the `user_information` section (refused in code, tested).
9. **Server choice:** only this window's server (parent = extension host); never pick another window's.
10. **Failure mode:** any rpc failure degrades to `file`; any file failure degrades to the last good snapshot, marked stale in the tooltip. Never throw to the VS Code host.

Why: [What can the language server's RPC tell us, and can we reach it reliably?](../../wayfinder/context-viewer/13-language-server-rpc.md), [Files only, or language-server RPC with files as fallback?](../../wayfinder/context-viewer/14-data-source-strategy.md), [How much raw content does a hover show, and does it ever show tokens or account details?](../../wayfinder/context-viewer/17-hover-content.md), [How do the data sources, watching, parsing and UI fit together?](../../wayfinder/context-viewer/15-architecture.md); research: [language-server-rpc](../research/language-server-rpc.md).

## 10. Logging

- Output channel `Context Viewer`; level `contextViewer.logLevel` (`off`/`error`/`info`/`debug`, default `error`).
- Logged: source switches (`rpc`<->`file`), failed server lookups, db copy/open failures, retries; at `debug`: RPC reply size and fetch time, poll hits.
- Redaction step on every line: drops the CSRF token (exact string + shape regex) and anything shaped like a `GetUserStatus` field (account name, email, plan). Never log request headers, bodies, or reply bodies.

Why: [How do the data sources, watching, parsing and UI fit together?](../../wayfinder/context-viewer/15-architecture.md).

## 11. Tests and fixtures

- **vitest** on pure functions; no tests driving the VS Code UI.
- Injected interfaces: clock, filesystem, process table (`/proc`), RPC transport.
- Pure units under test: transcript parser (incremental, partial line, rewind, CHECKPOINT, pairing), server reply -> Snapshot, `gen_metadata` -> Snapshot, `classify(used, threshold)` (boundaries 50/80/100%), Threshold and limit lookup (order in section 5), model-key normalisation, Recent ranking and expiry (injected clock), title fallback, status bar label cut (~10 chars at word break), compaction detection and tooltip text, hover cut-off (1500 + 500, thinking 1000), masking/redaction, RPC allowlist, `/proc` candidate selection (orphans, parent match), recovery backoff schedule (5/15/30/60 s), stale-server guard.
- Fixtures: small captured excerpts from `docs/research/` (transcripts incl. a rewind and a CHECKPOINT, a generator-metadata reply, a `gen_metadata` row) with CSRF tokens, emails and large blobs scrubbed; stored under `test/fixtures/`.
- Commands: `npm test` (`vitest run`), file-scoped `vitest run test/<file>.test.ts`.

Why: [How do the data sources, watching, parsing and UI fit together?](../../wayfinder/context-viewer/15-architecture.md); research: [transcript-format](../research/transcript-format.md), [compaction](../research/compaction.md).

## 12. Packaging

- TypeScript; bundled with esbuild (`platform: node`, `external: ['vscode']`, `node:sqlite` left as a runtime import, target Node 22); standard `yo code`-style scaffold (`src/`, `package.json`, `tsconfig.json`, `.vscodeignore`); `vsce package` => local `.vsix`, installed with `antigravity --install-extension` (or the VS Code extensions "Install from VSIX").
- `package.json`: `engines.vscode` matching the base (1.107); `extensionKind: ["workspace", "ui"]` (a WSL window runs the extension on the WSL side, where the roots, `/proc` and loopback hub live); `activationEvents: ["onStartupFinished"]`; contributes: configuration (section 2), a view container + view `Context Inventory`, commands (refresh, toggle largest first, collapse all, reveal Conversation), `viewsWelcome`.
- **No-op activation guard:** if no configured root exists on this host (plain VS Code, a Windows-local window), activate quietly: no status bar item, no errors, empty-state tree welcome only.
- The `node:sqlite` experimental warning is expected and ignored.
- Nothing is published; no telemetry.

Why: [Where does the extension run under WSL, and what can it reach?](../../wayfinder/context-viewer/04-extension-host-wsl.md), [How do the data sources, watching, parsing and UI fit together?](../../wayfinder/context-viewer/15-architecture.md), [What shape does the handoff spec take, and what goes in it?](../../wayfinder/context-viewer/18-spec-assembly.md); research: [extension-host-wsl](../research/extension-host-wsl.md).

## 13. Build-time checks

Checklist the first slice must clear; each with its fallback.

- [x] **WAL merge works on a read-write copy with a non-empty WAL.** Copy `<id>.db` + `-wal` + `-shm` while a turn is running (non-empty WAL), open the copy read-write with `node:sqlite`, confirm the last `gen_metadata` row equals the transcript's last PLANNER_RESPONSE tokens. Fallback: read the transcript only for tokens and take model/limit/breakdown from `rpc` only (no db in `file` mode).
  - Result (2026-11-09, slice 1): copy + read-write open works with a 10 MB WAL; last `gen_metadata` row (model, limit, estimate) and transcript agree (3/3 calls, 14,896 used). Antigravity had already checkpointed every `gen_metadata` row into the main file, so no WAL-only row was ever observed: the merge is a harmless safeguard, not yet proven necessary.
- [x] **`node:sqlite` loads in the packaged `.vsix` under Antigravity's extension host** (Node 22.21.1, SQLite 3.50.4; ExperimentalWarning expected). Fallback: file mode uses the transcript only (no model, limit, breakdown); `rpc` unaffected. (Do not swap in sql.js without WAL handling.)
  - Result (2026-11-09): passes; the installed `.vsix` shows the db-sourced 256k limit in Antigravity's WSL extension host.
- [x] **`truncationReason` seen live** after a real Compaction (manual `/compact` is enough). Fallback: detect Compaction from the CHECKPOINT transcript step and `startStepIndex` only.
  - Result (2026-11-09): after a manual `/compact`, the next call has `truncationReason = TRUNCATION_REASON_MAX_TOKEN_LIMIT` and `startStepIndex` = the CHECKPOINT step (9). The CHECKPOINT itself adds no gauge figure; the gauge moves on the next call.
- [ ] Also confirm: whether per-rule/per-skill children from `GetTokenBase` sum to their `user_rules`/`skills` section (else show section totals); whether one server can answer for other Conversations (else files for those); whether `context.storageUri` resolves to the window's workspace hash for finding `workspaceStorage/<hash>/state.vscdb` (else locate by `workspace.json`).
  - One server answering for other Conversations: **yes** (two live servers, from different windows, both returned the same Conversation's metadata). `GetTokenBase` sums: **no** (slice 3 live check: rules 1,560 vs `user_rules` 1,861; skills 1,470 vs `skills` 3,072), so section totals only and `GetTokenBase` is not called. `storageUri` hash: the installed gauge showed the selected Conversation in Antigravity; switching between chats follows within about a second (confirmed 2026-11-09).
  - Process lookup (slice 3): at least one live server process does not pass `--csrf_token=<value>` in that form (likely as a separate argument); accept both forms.
  - **Leftover servers after a forced close:** an orphaned server can keep running a turn while the restarted one takes the next message, so one transcript gets two interleaved step sequences (repeated and backwards `step_index`) and the rewind rule (section 4.2) drops valid steps. Seen once (`16c7dd2b`), not in a clean session. The gauge figure (last line) stays right; running totals and the tree do not. Advice: after a forced close, end leftover `language_server` processes.

Why: [What shape does the handoff spec take, and what goes in it?](../../wayfinder/context-viewer/18-spec-assembly.md), [How do the data sources, watching, parsing and UI fit together?](../../wayfinder/context-viewer/15-architecture.md), [What do the gauge and inventory show when Antigravity compacts or drops earlier context?](../../wayfinder/context-viewer/16-compaction.md), [With several windows open, which Conversation is Active?](../../wayfinder/context-viewer/11-multi-window-active.md), [Which kinds of Context Item does the inventory show, and how are they grouped?](../../wayfinder/context-viewer/05-context-item-taxonomy.md); research: [gemini-data-stores](../research/gemini-data-stores.md), [compaction](../research/compaction.md).

## 14. Later

Out of v1, recorded so the build does not design them out.
- **Push updates:** `StreamCascadeReactiveUpdates` (and `StreamCascadeSummariesReactiveUpdates`) instead of pull-on-change. Keep the source interface able to emit snapshots from a stream. Would need adding both to the allowlist.
- **Server data for Windows-local windows:** needs to find the server without `/proc` (PowerShell `Get-CimInstance Win32_Process`, then `netstat -ano`); unverified. v1: files only there, read over `\\wsl$`.
- **Plain VS Code support:** v1 only has the no-op activation guard (section 12).

Why: [How do the data sources, watching, parsing and UI fit together?](../../wayfinder/context-viewer/15-architecture.md), [What can the language server's RPC tell us, and can we reach it reliably?](../../wayfinder/context-viewer/13-language-server-rpc.md), [What shape does the handoff spec take, and what goes in it?](../../wayfinder/context-viewer/18-spec-assembly.md).

## 15. Suggested slices

The build session files these as GitHub issues on `fattung79/antigravity-context-extension`, label `ready-for-agent`. Each slice ends usable, with vitest tests on its pure functions.

| # | Slice | Depends on |
|---|---|---|
| 1 | Scaffold + build-time checks (section 13) + file-mode Token Gauge for the Active Conversation (roots, selection, transcript parser, store, poller, status bar, empty state, no-op guard) | none |
| 2 | Context Inventory tree from file mode (`~est`, Baseline, merged tool items, heavy highlight, largest-first, refresh) | 1 |
| 3 | `rpc` source: `/proc` lookup, allowlist, reply -> Snapshot, recovery, stale-server guard, exact System Prompt / Tools / Chat Messages | 2 |
| 4 | Limits (section 5) + Threshold colours (`classify`, status bar and tree tint, settings) | 2 |
| 5 | Recent Conversations + expiry + multiple status bar items + countdown | 2 (uses 4's colours if present) |
| 6 | Compaction display (section 8) | 2 (full detail with 3) |
| 7 | Hover content (section 7.4) | 2 |
| 8 | Logging + redaction + packaging polish | 3 |

Slices 3, 4, 6, 7 are independent after 2 and can run in parallel; 5 can run parallel with them but should follow 4 for colours.

Why: [What shape does the handoff spec take, and what goes in it?](../../wayfinder/context-viewer/18-spec-assembly.md).
