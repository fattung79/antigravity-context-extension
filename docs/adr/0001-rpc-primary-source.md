# 1. Language server RPC as the main source, files as fallback, hard Get/List allowlist

Status: accepted (2026-11)

## Context

The Token Gauge and Context Inventory need the used tokens, the model's context limit and a breakdown of what is loaded. Two sources exist. The files under `~/.gemini/antigravity/` (the transcript `transcript_full.jsonl`, `conversations/<id>.db`) give billed tokens, the model, a limit and a System Prompt / Tools / Chat Messages breakdown, but nothing per rule or skill. The window's own language server (`~/.gemini/bin/agy`) answers Connect-RPC on loopback: `GetCascadeTrajectoryGeneratorMetadata` returns `maxContextTokens`, `estimatedTokensUsed`, the model, `truncationReason` and a breakdown that itemizes rules and skills, live, in ~30 ms. Reaching it means reading the port and CSRF token from `/proc/<pid>/cmdline`, and that token also authorizes write methods (sending messages, changing state). Finding the process is fragile in prior art (`no_process` bugs).

## Decision

- The main source is the RPC of **this window's** language server (the one whose parent process is our extension host). It is called only when a tracked file's mtime or size changes, never on a fixed timer.
- The client enforces a **hard allowlist in code**: only `Get*`/`List*` methods; anything else is refused before a request is built. The CSRF token lives in memory only, is never logged, and is masked wherever text is shown.
- The **files are the fallback**, used on lookup failure, 401/403, connection errors or a stale server, and for Windows-local windows in v1. Both sources produce the same snapshot type, and the gauge shows which one it used (`rpc` / `file`).
- The gauge figure is billed input + cached tokens from either source, so a source switch doesn't make it jump; Antigravity's own estimate goes in the tooltip only.

## Consequences

- Per-rule and per-skill counts and live compaction data are available when the server is reachable; the extension still works, with less detail, when it isn't.
- The extension holds a credential that could change agent state; the allowlist and redaction are safety rules to audit, not conveniences.
- Depends on undocumented internals; Antigravity updates may break it, and the file fallback limits the damage.

See [What can the language server's RPC tell us?](../../wayfinder/context-viewer/13-language-server-rpc.md), [Files only, or language-server RPC with files as fallback?](../../wayfinder/context-viewer/14-data-source-strategy.md), [research](../research/language-server-rpc.md), [spec](../spec/context-viewer.md).
