---
id: 06-model-limits
title: How is the model's context limit worked out when no source gives it?
labels: [wayfinder:grilling]
parent: MAP
blocked_by: [02-state-db-index, 03-transcript-format, 09-gemini-data-stores, 13-language-server-rpc, 14-data-source-strategy]
assignee: v-DominicLee
status: closed
---

## Question

Decide the model-detection source, the built-in model→limit table (the models Antigravity offers), the setting override and the default.

Narrowed after the data-source decision: the used figure is settled (billed input + cached), and the limit normally comes from the RPC's `maxContextTokens` or the database's `.1.9.10.4`. What's left: the fallback table's contents (only Gemini 3.8 Flash = 256000 verified), when it applies (old Conversations, failed reads), the override setting, and what the gauge shows with no model or limit.

## Resolution

- **Self-filling table:** every limit read from the server (`maxContextTokens`) or the database (`.1.9.10.4`) is remembered in the extension's global state, per model. The built-in table holds only confirmed values: Gemini 3.8 Flash = 256000 and Gemini 4 Argon = 256000 (Argon checked 2026-11-05 on the click-test Conversations). No guesses for Claude or GPT-OSS.
- **Model key:** the display name without the effort level in brackets ("Gemini 3.8 Flash"); each source is converted to it. The effort level didn't change the limit in what we've seen.
- **Which source wins, first match:** user override per model > live server > Conversation database > remembered limits > built-in table > default limit setting (starts empty). The tooltip names the source used.
- **No limit from anywhere:** show `ctx 124k / ?`, with no percentage.
- **Model switched mid-chat:** keep the last call's model and limit until the next turn (the database records the new model per call, confirmed); don't show the newly picked model in advance.
