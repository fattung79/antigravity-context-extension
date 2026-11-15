# Changelog

## 0.1.1

- Replace the stock activity bar icon with a monochrome SVG matching the extension icon.

## 0.1.0

- Token Gauge status bar item (Active Conversation) and Context Inventory tree (Active and Recent Conversations).
- Language-server `rpc` source (this window's server only, read-only method allowlist) with `file` fallback (transcript + SQLite copy) and stale-snapshot marking.
- Read-only item inspection (`Open item content` for chat steps, System Prompt sections, and tools; `Open rule file` for `Memory` rule files) and Largest First / Step Order sorting.
- Per-model Threshold and Context window chain, colour bands, Compaction markers, and hovers.
- Output channel `Context Viewer` with levels `off`/`error`/`info`/`debug`; CSRF token, emails, and account/plan fields redacted on every line. No webviews, no telemetry.
