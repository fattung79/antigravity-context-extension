---
id: 19-assemble-spec
title: Assemble the handoff spec
labels: [wayfinder:task]
parent: MAP
blocked_by: [18-spec-assembly]
assignee: v-DominicLee
status: closed
---

## Question

Write the build-ready spec in the shape decided in [What shape does the handoff spec take, and what goes in it?](18-spec-assembly.md): `docs/spec/context-viewer.md` restating every closed ticket's decision (with `Why:` links), the two ADRs (`docs/adr/0001` RPC as the main source with a Get/List allowlist; `0002` stat polling instead of `fs.watch`), a redaction check of `docs/research/` (drop the `.log` and `__pycache__`), then commit spec, ADRs, `wayfinder/`, `docs/research/` and `GLOSSARY.md`. Don't file GitHub issues; the build session does that from the spec's slice list. Done when the spec is committed and nothing in it contradicts a closed ticket.

## Resolution

Done. [docs/spec/context-viewer.md](../../docs/spec/context-viewer.md) (354 lines, 15 sections, `Why:` links by ticket title), [ADR 0001](../../docs/adr/0001-rpc-primary-source.md) (RPC main source, Get/List allowlist) and [ADR 0002](../../docs/adr/0002-stat-polling.md) (stat polling).

- **Conflicts settled in favour of the later ticket:** the selection signal is `lastConversationId` and the annotation time is used for Recent only; stat polling everywhere; `node:sqlite` on a read-write copy (not sql.js, not a read-only copy); the estimate is not a fixed offset; the default root is `~/.gemini/antigravity/` only; the countdown shows minutes only (`drops in 3m`, not `2:41`).
- **Setting names chosen by the spec (no ticket named them):** `roots`, `recentExpiryMinutes`, `limits`, `limits.default`, `heavyItemPercent`. Dotted `*.default` keys come back nested inside their parent object, so the reader skips `default`.
- **RPC allowlist made concrete:** `GetCascadeTrajectoryGeneratorMetadata`, `GetAllCascadeTrajectories`, `GetTokenBase`.
- **Added to the build-time checks:** whether `GetTokenBase` children add up; whether one server can answer for other Conversations; whether `context.storageUri` gives the workspace hash.
- **Redaction check:** no token values or account data in `docs/research/` or `wayfinder/`, only key names; the UUIDs are Conversation ids. `compaction-watch.log` and `__pycache__/` are kept out of git by `.gitignore` (left on disk, not deleted).
