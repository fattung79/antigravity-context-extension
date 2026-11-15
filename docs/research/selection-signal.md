# Selection signal: which Conversation is selected in the agent panel?

Ticket: [01-selection-signal](../../wayfinder/context-viewer/01-selection-signal.md). Researched 2026-11-05, read only. Sources are Antigravity's own files on this machine (install folder, state databases, `.gemini` folder). Database copies were taken to scratch space; no conversation content was read, only key names and structure.

## Answer

Yes. There are two usable signals, one per window and one global, plus a fallback.

1. **Per-window "last conversation" (best signal).** Each workspace's `workspaceStorage/<hash>/state.vscdb` has a row `google.google-antigravity` (JSON) containing `"lastConversationId": "<uuid>"`. It is the Conversation shown in the agent panel of the window for that workspace.
2. **Global "last viewed" timestamps.** `~/.gemini/antigravity/annotations/<uuid>.pbtxt` has `last_user_view_time:{seconds:N nanos:N}` per Conversation. Max over all files = most recently viewed Conversation (any window). Readable from the WSL side, so no `/mnt/c` access needed.
3. **Fallback.** Most recently modified `brain/<uuid>/.system_generated/logs/transcript.jsonl` (or `conversation_summaries.db` `last_modified_time`).

## Evidence

### 1. `lastConversationId` (workspace state)

- Written by the bundled extension: `Antigravity IDE/resources/app/extensions/agy/vscode/extension.js`. In `handleDidChangeUrl`, when the agent webview's URL path matches `/c/<id>`, it does `workspaceState.update("lastConversationId", id)` and fires an internal `onDidChangeConversation` event. Path `/` (new/empty conversation) clears it (`update(..., undefined)`). New-conversation RPC and no-folder windows also clear it. Startup sets it from `startupConversationId` / `globalState "antigravity.pendingConversationId"`.
- Observed on disk: workspace `82107e65...` (another WSL window) had `lastConversationId` = `24161983-...` in `state.vscdb.backup` (13:27) and `4fe3805a-...` in live `state.vscdb` (mtime 15:06:39), matching the Conversation created at 15:06:20 (brain folder mtime). Workspace `3d0e93a3...` holds `e23f1e23-...`, matching the last view time in `annotations/` (11:21) for that window.
- Storage location: for a WSL remote window the workspace storage still lives on the Windows side: `/mnt/c/Users/<user>/AppData/Roaming/Antigravity IDE/User/workspaceStorage/<hash>/state.vscdb`; `workspace.json` in the same folder gives the folder URI (`vscode-remote://wsl%2Bubuntu/home/...`) to map hash -> workspace.
- **Path correction:** on this machine the app is "Antigravity IDE", so the data dir is `Roaming/Antigravity IDE/`, not `Roaming/Antigravity/` (that folder does not exist). Install: `AppData/Local/Programs/Antigravity IDE/`.
- Caveat (latency): `workspaceState` is held in the extension host and flushed to sqlite by VS Code on its own schedule (observed ~19 s after the event; also at shutdown). Not live-grade. Whether a switch to an older Conversation flushes the same way was not tested (needs a manual click while a watcher runs); code says it should.
- Caveat (multi-window): one row per workspace, so with several windows open there are several "selected" Conversations. Rank by annotation view time, or by which window is focused (an extension in that window knows its own workspace hash via its own `workspaceState`/`storageUri`).

### 2. Annotations `last_user_view_time`

- Files: `~/.gemini/antigravity/annotations/<conversation-uuid>.pbtxt`, one line of text-format protobuf: `title:"..." last_user_view_time:{seconds:... nanos:...}` (+ `archived`, `archival_status_timestamp` when archived). Written by Antigravity's local server (Go/agent hub), not by the GUI.
- Observed: `4fe3805a` file mtime 15:15:09.119 equals its `last_user_view_time` 15:15:09.118, one minute after the last transcript write (15:14:26): so it records a user view, not agent activity. Previous view (`24161983`) 15:05:51. Seconds-level and file-system watchable, no db flush delay.
- Unknown: exact trigger (switch only, or each focus/open). Likely "Conversation opened/viewed in the panel"; confirm with a live click test.
- Title is also here (answers the "real title" question in map.md: `title:` field, also `conversation_summaries.title`).

### 3. Other state.vscdb keys (global `globalStorage/state.vscdb`, 507 rows)

Compared two copies ~1 min apart: only `n2ns.antigravity-panel` (third-party extension) and `editorOverrideService.cache` changed; no Antigravity-owned key changed. So the global db is not live.

- `google.google-antigravity` -> `antigravity-storage` object: `antigravity-multi-conversation-layout-v3-<uuid>` (per Conversation: `{rootNode:{type,id,cascadeId}, focusedPaneId}`; one entry per Conversation ever opened, no "current" pointer), `aux-pane-session` (`conversationPanes` keyed by uuid; holds one uuid, apparently the last aux pane, not selection), `new-convo-last-selected-project` (project, not Conversation), `projectsOrder`, `running-items-panel-expanded-<uuid>`.
- `antigravityUnifiedStateSync.trajectorySummaries` (base64 protobuf, one entry per Conversation: uuid, title, step count, timestamps for modified/created/last-step). Stale here (newest entry dated Oct 22 while Conversations exist through Nov 5), so not usable for recency.
- `antigravityUnifiedStateSync.sidebarWorkspaces`, `.agentPreferences`, `.artifactReview`, `antigravity.notification.agent-finished-<uuid>-<ms>` (one empty-ish row per agent finish; shows activity per Conversation, but accumulates and is not selection). No other key tracks the current Conversation.
- `chat.ChatSessionStore.index` is VS Code's built-in chat, empty (`entries:{}`).
- Workspace dbs also hold `antigravity.agentViewContainerId.state` (panel visibility only).

### 4. Commands, context keys, extension API

- Bundled extension `extensions/agy/package.json` (`google-antigravity`): commands include `antigravity.panel.focus`, `antigravity.resetConversationState`; runtime-registered `<prefix>.openConversation`, `.searchConversations`, `.resetConversation`, `.reconnect`. No command returns the current Conversation.
- Context keys set by the extension: `antigravity.agentRunning`, `antigravity.chatFocused`, `antigravity.stepPending`, `antigravity.hasActiveDiff`, `isJetskiSidebarHidden`, `isJetskiTerminalVisible`. None carry the id, and VS Code context keys are not readable from extension code anyway.
- `onDidChangeConversation` exists only as an internal event on the provider class; I found no consumer and no evidence it is exported to other extensions (not verified deeper; `main` is the wrapper `dist/extension.js`).
- `product.json` has no Antigravity-specific keys. Other bundled Antigravity extensions (`antigravity-remote-wsl`, `-remote-openssh`, `-dev-containers`, `-code-executor`) are unrelated.
- Conclusion: no supported API; reading files is the only route.

### 5. Brain / `.gemini` folder markers

- `~/.gemini/antigravity/presence/<uuid>.lock` (0 bytes, mode 0600): one per Conversation touched; mtime = creation of the lock (e.g. `4fe3805a.lock` 15:06:20 = creation time). Not updated on selection (the one being viewed at 15:15 still shows 15:06). Probably advisory locks held by the running server; not a selection marker. (I did not inspect which process holds them.)
- `antigravity_state.pbtxt`: `last_selected_agent_model` (model, not Conversation). Useful for model limit lookup, though.
- `daemon/hub_<pid>.json`, `cli.log`: server/hub bookkeeping; not examined for selection.
- Brain folder has no "active" marker file; mtimes of the `brain/<uuid>` directory itself only change on creation of children.
- `conversation_summaries.db` table `conversation_summaries`: `conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, source, ...`: good for recency/title and workspace mapping, not selection.

## Fallback quality (most recent transcript write)

Good in the common case of one agent running in the viewed Conversation: the transcript mtime updates as steps stream. Weak when: the user views an idle Conversation while another runs in the background (the running one wins), or when browsing old Conversations (no writes). The `annotations` view timestamp fixes both cases, so use: Active = max(`last_user_view_time`) cross-checked with `lastConversationId` of the focused window; fall back to max transcript mtime if annotations are absent. Recent Conversations = next 2 by the max of view time and transcript mtime.

## Confidence

High that the two signals exist and what they contain (read in files and in the extension source). Medium on update triggers/latency: only one natural before/after observed (creation of a Conversation); no scripted selection-switch test was possible read-only.

## Follow-up questions

- Confirm by a manual click test that switching to an older Conversation updates `annotations/<uuid>.pbtxt` immediately and `lastConversationId` within ~20 s.
- Format of `transcript.jsonl` / `transcript_full.jsonl` (token fields) is out of scope here, but both live under `brain/<uuid>/.system_generated/logs/`.
- Third-party extensions already in the user profile (`AGI-is-going-to-arrive.antigravity-context-monitor`, `n2ns.antigravity-panel`, folder `Roaming/Antigravity Context Monitor`) may be prior art for the same job.
