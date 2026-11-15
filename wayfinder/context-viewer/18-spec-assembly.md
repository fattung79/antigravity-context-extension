---
id: 18-spec-assembly
title: What shape does the handoff spec take, and what goes in it?
labels: [wayfinder:grilling]
parent: MAP
blocked_by: []
assignee: v-DominicLee
status: closed
---

## Question

Decide the form of the build-ready spec that ends this map: one document or several, where it lives (`docs/spec/`?), how it's split (data sources, store, poller, views, settings, safety rules), what it cites from closed tickets versus restates, what goes in a short "Later" section (decided: Push updates and server data from Windows-local windows, out of scope on the map but recorded here so the build doesn't design them out), and how a build session should slice it into implementation issues.

## Resolution

- **Form:** one file, `docs/spec/context-viewer.md`, ≤ ~700 lines.
- **Cite vs restate:** self-contained for the *what* (exact numbers, setting names, formats, module boundaries); each section ends with a `Why:` link to its ticket(s) and research file. Rationale is never copied.
- **Sections, in order:** 1 Goal, non-goals, glossary link · 2 Settings (every `contextViewer.*` key, its default and its effect) · 3 Discovery (roots, selection, Recent ranking/expiry) · 4 Sources: `rpc` (lookup, allowlist, recovery, stale guard) and `file` (transcript, sqlite copy) · 5 Limits · 6 Model/store + poller timings · 7 Views: status bar, tree, hover, empty state · 8 Compaction · 9 Safety rules (allowlist, token masking, read-only, no patching), in one place so it can be audited · 10 Logging · 11 Tests and fixtures · 12 Packaging (scaffold, esbuild, local `.vsix`) · 13 Build-time checks · 14 Later · 15 Suggested slices.
- **Build-time checks:** a checklist the first slice must clear, each item with its fallback: WAL merge on a copy opened read-write with a non-empty WAL; `node:sqlite` loads in the packaged extension; `truncationReason` is seen live.
- **Later:** push updates (`StreamCascadeReactiveUpdates`); server data for Windows-local windows; plain VS Code support. Plain VS Code gets only a no-op activation guard (stays quiet when no root exists).
- **Slices** (spec ends with these, each with its dependencies; each slice ends usable, with tests on its pure functions): 1 scaffold + build-time checks + file-mode gauge for the Active Conversation → 2 tree from file mode (`~est`, Baseline) → then in parallel 3 `rpc` source + recovery + stale guard, 4 limits + Threshold colours, 6 compaction display, 7 hover content; 5 Recent Conversations + expiry + multiple status bar items; 8 logging/redaction + packaging polish.
- **Implementation issues:** GitHub Issues on fattung79/antigravity-context-extension, labelled `ready-for-agent` (per `AGENTS.md`), filed by the **build** session from the slice list, not by spec assembly. The map stays local.
- **Commit the trail:** `wayfinder/`, `docs/research/` and `GLOSSARY.md` are committed with the spec so the `Why:` links resolve, after a redaction check (CSRF tokens, `GetUserStatus`/account fields); drop the `.log` and `__pycache__`.
- **ADRs:** `docs/adr/0001` language server RPC as the main source, files as fallback, hard Get/List allowlist; `docs/adr/0002` stat polling everywhere instead of `fs.watch`. The spec links them.
- **Writing it:** a new AFK task ticket, [Assemble the handoff spec](19-assemble-spec.md), for a fresh session.
