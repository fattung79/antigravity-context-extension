---
id: 08
title: Which brain root and data folder does the current IDE write to?
labels: [wayfinder:research]
parent: MAP
blocked_by: [02-state-db-index, 03-transcript-format]
assignee:
status: closed
---

## Question

Brain roots exist under both `.gemini/antigravity` and `.gemini/antigravity-ide`, on both the WSL and Windows sides, and the data folder is `%APPDATA%\Antigravity IDE\`. For a WSL workspace and for a Windows workspace, which root does the current Antigravity IDE write new transcripts to, and which `state.vscdb` is current? Are the other roots left over from older versions? Blocked so that the state.vscdb and transcript research, which may answer this along the way, finishes first.

## Resolution

Answered by the [.gemini data stores research](../../docs/research/gemini-data-stores.md): only `~/.gemini/antigravity/` (WSL) is live. The Windows-side and `antigravity-ide` stores are stale or left over. The data folder is `%APPDATA%\Antigravity IDE\`.
