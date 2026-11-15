---
id: 13
title: What can the language server's RPC tell us, and can we reach it reliably?
labels: [wayfinder:research]
parent: MAP
blocked_by: []
assignee:
status: closed
---

## Question

`n2ns.antigravity-panel` queries Antigravity's language server over Connect-RPC (see docs/research/prior-art.md). From our setup (WSL extension host, Windows GUI, ARM): how is the process found and authenticated (CSRF token, port), on which side does it run, and how often does discovery fail? List the methods that matter: per Conversation, does it give `maxContextTokens`, `estimatedTokensUsed`, `truncationReason` and `checkpointIndex`, and does any method expose the full context (system prompt, rules, memories, knowledge), which would fill the inventory's hidden baseline? Is calling it strictly read-only? Probe live, read-only calls only.

## Resolution

Yes, from a WSL window: `agy` (language server) runs on the WSL side, one per window, token and `--hub-port` in `/proc/<pid>/cmdline`, plain HTTP Connect-RPC with `X-Codeium-Csrf-Token`. `GetCascadeTrajectoryGeneratorMetadata` gives `maxContextTokens` (256000), `estimatedTokensUsed`, `checkpointIndex` (-1 seen), model, usage, plus a per-section token breakdown (system prompt sections, tools, one entry per chat step); `truncationReason` never appeared. Fresh within one LLM call, about 30 ms. Read-only for Get calls; the token grants write power. Windows-window discovery is unverified.
Details: [docs/research/language-server-rpc.md](../../docs/research/language-server-rpc.md)
