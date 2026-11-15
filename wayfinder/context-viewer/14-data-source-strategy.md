---
id: 14
title: Files only, or language-server RPC with files as fallback?
labels: [wayfinder:grilling]
parent: MAP
blocked_by: [13-language-server-rpc, 09-gemini-data-stores]
assignee:
status: closed
---

## Question

Decide the data-source strategy: files only (robust, no exact limit, no rules or memories), RPC as primary with files as fallback, or RPC only for limits and compaction. Consider fragility, the 'read only, no injection' rule, and complexity.

Inputs: docs/research/gemini-data-stores.md (the files give model, limit and a breakdown) and docs/research/language-server-rpc.md (the RPC also itemizes rules and skills and is live; it needs the process, the token and a write-safe allowlist; Windows windows unverified). Also decide which brain or data roots to watch: research found only `~/.gemini/antigravity/` (WSL) is live, while the earlier decision was both roots.

## Resolution

- **Main source:** the language server's RPC, the server whose parent process is our extension host.
- **Read only:** a hard Get/List-only allowlist in code; never log the CSRF token or `GetUserStatus` output.
- **When to call it:** only when the transcript's or `conversations/<id>.db`'s mtime or size changes, never on a fixed timer.
- **Fallback:** the files (transcript tokens; model, limit and breakdown from `conversations/<id>.db`, read from a WAL-aware copy). The gauge marks its source (`rpc` / `file`).
- **Roots:** `~/.gemini/antigravity/` is the only default; the setting stays an editable list. This replaces the earlier "watch both roots".
- **Gauge figure:** billed input + cached from either source, so switching sources doesn't make the gauge jump; Antigravity's estimate goes in the tooltip. Evidence: [gauge figure check](../../docs/research/gauge-figure-check.md). The estimate runs a roughly fixed 3.3k-5.5k above billed (2 Conversations, 1 model).

**Correction** (from [the compaction decision](16-compaction.md)): Antigravity's estimate is not a fixed 3.3k-5.5k above billed; it is higher when the context is small and up to 25% lower when it is large. The gauge stays on billed.
