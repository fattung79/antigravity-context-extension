---
id: 16-compaction
title: What do the gauge and inventory show when Antigravity compacts or drops earlier context?
labels: [wayfinder:task]
parent: MAP
blocked_by: []
assignee: v-DominicLee
status: closed
---

## Question

Push one Conversation past compaction (no trace so far; the highest seen is 181k) and record what changes: `truncationReason` from the server, whether the `gen_metadata` total (`.1.9.10.1`) drops, and what the transcript shows. Also explain the drop from 65.5k to 52.0k without a rewind in `cd5f84af`. Then decide how the gauge and tree show it (a marker, dropped items, a tooltip line).

## Resolution

Evidence: [compaction.md](../../docs/research/compaction.md) (the `cd5f84af` drop; manual `/compact` and 3 automatic compactions in `8bdd6cb4`, Gemini 3.8 Flash, limit 256000); watcher: [compaction-watch.py](../../docs/research/compaction-watch.py) with its log.

**Facts**
- The `cd5f84af` drop (65.5k → 52.0k) was a **model switch** (Gemini 4 Argon → Gemini 3.8 Flash at step 63), not compaction. Billed ÷ Antigravity's estimate is stable per model (~0.92 Argon, ~0.72 Flash): the models count the same context differently.
- Compaction, manual (`/compact`, shown in the panel as a small "compact" chip) or automatic, writes a transcript step `type: CHECKPOINT`, `source: SYSTEM`, content starting `# Resuming from a compaction`, followed by a summary. Its token counts are the **summarizing call's** cost (262k-351k seen) and have no generator-metadata row.
- The first call after compaction carries `truncationReason = TRUNCATION_REASON_MAX_TOKEN_LIMIT` (manual too) and `chatStartMetadata.startStepIndex` = the CHECKPOINT step (db `.1.9.1`). The step itself carries `checkpoint{includedStepIndexStart/End, sessionSummary, capturedUserRequests}`; automatic ones add `checkpointIndex` 1, 2, 3. The only sign of a manual one is the `/compact` user message just before it.
- After compaction, Chat Messages = the CHECKPOINT item (~1.5k) + new steps; the next call bills ~14-16k with a cold cache.
- **Trigger (~70% confidence):** before a call, last billed + estimated new tool results ≥ the limit (256000) → compact. No threshold field is exposed. Billed can exceed the limit (281.7k = 110%), since results added in that turn are counted only on the next call.
- Antigravity's estimate is **not** a fixed offset above billed: higher when the context is small, up to 25% lower when it is large (est peak 235k, billed 282k). This corrects the data-source decision.
- Of 12 live language servers, one returned a stale single-call view.

**Decisions**
- **Gauge:** shows the new figure after compaction; no extra status bar text. Can exceed 100% (`110% · 282k/256k`, red from the threshold colouring).
- **Tooltip:** `Compacted 4× (1 manual) · last at step 211 · was 281.7k` (`was` = the last planner figure before compaction; manual = the step before it is a `/compact` user message). `Compacts at ~256k (soft limit)`; no separate forecast logic. `Model changed at step 63: Gemini 4 Argon → Gemini 3.8 Flash` after a model switch (billed is kept; the drop is real). Antigravity's estimate stays, labelled as such.
- **Tree:** Chat Messages lists only steps from `startStepIndex`; the first item is `#25 Compaction summary · 1.5k` with its own icon, hover = the summary text (cut-off per the hover decision). Dropped steps are not shown. The root label adds `· compacted`.
- **File mode:** a CHECKPOINT step drops all earlier steps from the tree (`~est`); its own tokens never count toward the gauge (planner steps only); the db's `.1.9.1` is the cross-check. Rewinds are handled separately as already decided.
- **Stale-server guard** (amends the architecture decision): keep "the server whose parent is our extension host"; if its latest call trails the transcript's last planner step for 2 consecutive checks, treat it as stale → files + look for the server again. Never pick "the server with the most entries" (could show another window's view).
- **Unverified:** the exact trigger rule; other models' limits and triggers.
