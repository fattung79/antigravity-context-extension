---
id: 17-hover-content
title: How much raw content does a hover show, and does it ever show tokens or account details?
labels: [wayfinder:grilling]
parent: MAP
blocked_by: []
assignee: v-DominicLee
status: closed
---

## Question

Decide the hover's cut-off length (the prototype used 2,000 characters), whether thinking is cut separately, and whether anything sensitive (the CSRF token, account or email fields, file paths outside the workspace) is ever shown or must be masked.

## Resolution

- **Cut-off:** head + tail. The first 1,500 characters, then `… N chars omitted …`, then the last 500 (≈2,000 total).
- **Thinking:** its own budget of up to 1,000 characters (head only), shown under the main text with a `Thinking` heading and its own `~Nk tok`.
- **Setting:** one, `contextViewer.hoverChars` (default 2000). The thinking budget is half of it, the tail a quarter.
- **Non-chat items** (System Prompt sections incl. `user_information`, Tools, rules, skills): the hover shows the name, token count and source (`rpc`/`file`/`~est`) only, never the section text. That text is never fetched.
- **Masking:** chat item text is shown as-is except that this window's live CSRF token (exact string) becomes `‹csrf›`, plus the same token-shape regex the logging redaction uses. Emails and paths outside the workspace are not masked (personal tool; the text is already on disk and on screen). `GetUserStatus` data is never shown anywhere.
- **Rendering:** an untrusted `MarkdownString` (`isTrusted: false`, `supportHtml: false`, no command links). User and model text render as markdown; tool output goes in a fenced code block with backticks escaped.
- **Source:** loaded lazily in `resolveTreeItem`, reading that step from the transcript by step index. The store holds only labels and counts, in both rpc and file mode. If the step is missing (compacted away, or a rewind): `text unavailable`, and the count still shows.
