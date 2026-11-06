# Language server RPC: can the extension read context data from it? (ticket 13)

Researched and probed live 2026-11-05 (WSL2 aarch64, Antigravity IDE 2.6.0, Windows-on-ARM host, WSL networkingMode=Mirrored). Only Get-style calls were made. No token or conversation content is recorded here.

## Answer

Yes, for WSL windows, and it is far richer than the transcript. `GetCascadeTrajectoryGeneratorMetadata` returns, per LLM call, the model limit, the estimated tokens used, and a **token breakdown by group and item** (System Prompt sections, Tools, one entry per chat step). That fills the inventory's "hidden baseline". Reading is read-only and cheap (about 30 ms, localhost). The risk is discovery and undocumented, renamable RPCs, so keep file sources as fallback.

## (1) Discovery

- **Where it runs (verified, WSL window):** the language server is the Linux binary `~/.gemini/bin/agy` (229 MB), one process per open window, started with `agy --hub --hub-port=<N> --app_data_dir=antigravity --csrf_token=<token> --add-dir=<workspace>...`. Its parent is that window's extension host node process (`~/.antigravity-ide-server/bin/2.6.0-<hash>/node ... --type=extensionHost`). So it lives on the WSL side, as a sibling/child of the remote extension host. There are 11 such processes now, one per window.
- **Windows window (not live-verified, no Windows window open):** `powershell.exe Get-CimInstance Win32_Process` filtered on `csrf_token|language_server` found no Windows-side process while only WSL windows were open (confirms WSL windows do not spawn a Windows server). The panel's win32 strategy (source below) implies `agy.exe`/`language_server*.exe` on Windows, found with Get-CimInstance then `wmic` fallback, ports via `netstat -ano`. Unverified here.
- **Port and token:** both are on the command line. `--csrf_token=<uuid-like>` and `--hub-port=<N>` (older builds: `--extension_server_port`). Reading `/proc/<pid>/cmdline` (NUL separated) is enough; no environ needed. Each process listens on **two** loopback ports (checked with `ss -ltnp`): the `--hub-port` (plain HTTP) and a second ephemeral port (HTTPS, self-signed: plain HTTP returns "Client sent an HTTP request to an HTTPS server"). Both accepted the token and answered `GetUserStatus`; the hub port is the simplest (HTTP, known from the args).
- **Request format:** `POST http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/<Method>`, headers `Content-Type: application/json`, `Connect-Protocol-Version: 1`, `X-Codeium-Csrf-Token: <token>`, body JSON (`{}` or `{"cascadeId":"..."}`). Plain Connect-RPC unary JSON; no gRPC framing needed.
- **Which process = which window:** command lines carry `--add-dir=<folder>` (no `--workspace_id` in this build), parent PID = the window's extension host. Our extension should pick the `agy` whose PPID is its own host's PID or parent (the panel's "inheritance/sibling/ancestry" match) and fall back to matching `--add-dir` to `vscode.workspace.workspaceFolders`. A hub only returned trajectories for its own workspaces (the window for this repo returned 0; an osp-workspace window returned 2), so choosing the wrong process gives empty results, not errors.
- **How the panel does it** (`n2ns.antigravity-panel-2.8.2/dist/extension.js`): Linux/mac `ps`, Windows PowerShell `Get-CimInstance` (name filter, then keyword `csrf_token` scan, then `wmic`). Regex `--(?:extension_server_port|hub-port)[=\s]+(\d+)` and `--csrf_token`, requires `--app_data_dir` in {antigravity, antigravity-ide}. Matching order: workspace id, child of the extension host, sibling, ancestry (3 levels), then any remaining candidate. Ports via `ss`/`lsof`/`netstat` for the PID, handshake `GetUserStatus` on 127.0.0.1, retry on the `/etc/resolv.conf` host IP under WSL NAT. Failure reasons: `no_process`, `no_port`, `auth_failed`, `workspace_mismatch`.
- **Why `no_process` happens (inference, issues #214/#219/#220 not read):** its process list is name-filtered (`agy.exe`, language_server...) then keyword-scanned; Antigravity has renamed the binary before (agy added in 2.6.0) and changed flags (`--hub-port`). Panel 2.8.2 does include `hub-port`, so on this machine the matching regexes would succeed on Linux; failures are likely from renamed process names on a given platform, `ps` unavailable or truncating long command lines, or the process not yet started at activation. Our own scan of `/proc/*/cmdline` for `--csrf_token=` plus `--app_data_dir` avoids name dependence.
- **Mirrored networking:** WSL and Windows share 127.0.0.1, so a WSL extension could in principle reach a Windows-hosted server, but only if it can discover that process (needs powershell.exe); a Windows host extension sees WSL ports the same way. Untested.

## (2) Methods

370 service method names appear in `agy` strings. Trajectory/context-related read candidates (names from `strings`; probed ones marked):

| Method | Probed | Returns |
|---|---|---|
| `GetAllCascadeTrajectories` | yes | `trajectorySummaries` map by cascade id: `summary` (title), `stepCount`, `status`, `createdTime`, `lastModifiedTime`, `lastUserInputTime`, `lastUserInputStepIndex`, `workspaces`, `annotations`, `trajectoryMetadata`, `trajectoryType`, `latestExecutorTerminationReason` |
| `GetCascadeTrajectoryGeneratorMetadata {cascadeId}` | yes | `generatorMetadata[]`, one per LLM call (see below) |
| `GetCascadeTrajectoryExecutorMetadatas {cascadeId}` | yes | per execution: `terminationReason`, `numGeneratorInvocations`, `lastStepIdx`, `cascadeConfig` (includes `checkpointConfig`: `maxTokenLimit`, `maxOverheadRatio`, `strategy`), `loadedCustomizations.customizations[]` (type, name, path, scope, status) |
| `GetCascadeTrajectory {cascadeId}` | yes | whole trajectory: `steps[]`, `generatorMetadata[]`, `executorMetadatas[]`, `status`, `numTotalSteps`; about 690 KB for 73 steps |
| `GetTokenBase {}` | yes | `customizationTokenBase.groups` (TOKEN_TYPE_RULES, SKILLS, SUBAGENTS with per-item `numTokens` and `totalTokens`), `customizationBudget` 20000, `rulesBudget` 20000, remaining budgets |
| `GetAllRules {}` | yes | `memories[]` entries (e.g. user global AGENTS.md: id, source, scope, `absolutePath`, `discoveryCategory`) |
| `GetCascadeMemories`, `GetKnowledgeItems` | yes | **deprecated** (HTTP 500 "deprecated" / 501 unimplemented) |
| `GetConversationMetadata` | yes | needs a conversation id param (name unknown; 400 with cascadeId) |
| Not probed | | `GetCascadeTrajectorySteps`, `GetTrajectoryTurns`, `GetUserMemories`, `GetMatchingContextScopeItems`, `GetCascadeModelConfigs`, `ListContextProviders`, `GetUserTrajectory*`; streams `StreamCascadeReactiveUpdates`, `StreamCascadeSummariesReactiveUpdates` (push updates, not tried) |

### `GetCascadeTrajectoryGeneratorMetadata` response shape (one live Conversation, 35 to 40 entries)

Per entry: `stepIndices[]`, `executionId`, `plannerConfig`, `chatModel{...}`:
- `chatModel.model` = `MODEL_PLACEHOLDER_M319` (internal enum), `responseModel` = `gemini-3.8-flash-n` (real name), `modelDisplayName`.
- `chatModel.usage`: `inputTokens`, `outputTokens`, `thinkingOutputTokens`, `responseOutputTokens`, `cacheReadTokens` (int64 as strings; `cacheReadTokens` absent on cold calls), `apiProvider`, `responseId`, `messageId`.
- `chatModel.chatStartMetadata.checkpointIndex` = `-1` in all 3 conversations sampled (no compaction seen).
- `chatModel.chatStartMetadata.contextWindowMetadata`: `maxContextTokens` = 256000, `estimatedTokensUsed` (e.g. 37600 at step 69; grew monotonically 18730 to 37600), `tokenBreakdown{groups[], totalTokens}`. **`truncationReason` was absent in every call** (including a 300-step conversation up to about 130k): it appears only when truncation occurs; not observed.
- `tokenBreakdown.groups[]` = `{name, type, source, numTokens, children[{name,numTokens}]}`:
  - `System Prompt` (TOKEN_TYPE_SYSTEM_PROMPT, 12.6k): 13 named sections (identity, terminal_sandbox, artifacts, conversation_transcript, guidelines, communication_style, slash_commands, messaging, subagents, **user_rules**, **skills**, featured_plugins, user_information). Rules and skills are itemized only as whole sections here, not per rule or skill.
  - `Tools` (5.8k): 14 children, one per tool name.
  - `Chat Messages` (19k): one child per step, named `"<stepIndex>: <STEP_TYPE>"` (USER_INPUT, PLANNER_RESPONSE, GENERIC...), so messages and tool output are itemized per step, not per file.
- Also the full text: `chatModel.systemPrompt` (string), `promptSections[]` (`title`, `content`, `tokenType`, `tokenSource`, `metadata.sourceType`), and `tools[]` (name, description, JSON schema).
- Reconciliation: `estimatedTokensUsed` (37600) equals the breakdown total, which is larger than `inputTokens + cacheReadTokens` of the same call by small amounts (the latter is the billed, cached view; the panel's max() rule holds). Cold calls report whole prompt in `inputTokens`; warm calls report it mostly as `cacheReadTokens`.

### Rules, memories, knowledge
- Rules: user rules are in the System Prompt group as section `user_rules` (size) and individually via `GetAllRules` (paths) and `GetTokenBase` (`TOKEN_TYPE_RULES` group with per-rule tokens). Skills and subagents: `GetTokenBase` per item; `loadedCustomizations` lists 55 items with status/scope.
- Memories and knowledge: the old APIs are deprecated; no separate memory/knowledge group was seen in the breakdown (none were active here, so absence is not proof).
- Conclusion: baseline (system prompt, tools, rules, skills) is itemized at section level with exact tokens; it does not fill "files read" (those sit inside the Chat Messages entries per step).

## (3) Freshness and cost

- Live: the same conversation, called three times 20 s apart while the agent ran, returned 36, 39, 40 entries; `GetCascadeTrajectory` reported status `RUNNING`. A new entry appears as each LLM call starts (the last entry already has `usage` once it finishes).
- Cost: about 30 to 45 ms per call over loopback. Sizes: GeneratorMetadata 207 KB for 35 calls, 487 KB for 149 calls (the repeated systemPrompt/promptSections/tools make it about 6 KB per entry, so it grows linearly; polling every 5 to 10 s is fine but cap by skipping when `stepCount` from the cheap `GetAllCascadeTrajectories` is unchanged, as the panel does). `startIndex` in the request is ignored (no pagination found); `GetCascadeTrajectory` is heavier (690 KB).
- Push alternative: `StreamCascadeReactiveUpdates` / `StreamCascadeSummariesReactiveUpdates` exist (streaming; not tried).

## (4) Read-only?

Everything probed (all `Get*`) was read-only; nothing changed in state (status stayed whatever the agent was doing). The server is the live agent backend, though: the same service has write methods (send message, cancel, settings) behind the same token, so the extension must hard-allowlist method names (Get/List only), as done in the probe script. The CSRF token grants full control; never log it or persist it. `GetUserStatus` returns account name, email and plan, so avoid logging full responses.

## Risks and fallbacks

- Undocumented, renameable API and flags (`--hub-port` replaced `--extension_server_port`; some methods already deprecated). Gate on response shape, degrade to file sources.
- Windows-window path unverified; WSL path verified.
- `truncationReason` and non-negative `checkpointIndex` never observed (no compaction sampled); the compaction detection recipe is therefore from the panel's code only.
- Model identity: `responseModel` is readable; `model` is an internal placeholder enum.

## Sources
- Live probes of `~/.gemini/bin/agy` (this machine), `strings` of that binary for method names.
- `~/.antigravity-ide-server/extensions/n2ns.antigravity-panel-2.8.2-universal/dist/extension.js` (Apache-2.0, minified), see also docs/research/prior-art.md.
- docs/research/extension-host-wsl.md, `/proc/<pid>/cmdline`, `ss -ltnp`.
