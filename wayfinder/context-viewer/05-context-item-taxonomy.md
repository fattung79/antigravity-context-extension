---
id: 05-context-item-taxonomy
title: Which kinds of Context Item does the inventory show, and how are they grouped?
labels: [wayfinder:grilling]
parent: MAP
blocked_by: [03-transcript-format, 13-language-server-rpc, 14-data-source-strategy]
assignee: v-DominicLee
status: closed
---

## Question

Given the transcript format, decide which Context Item kinds exist (file, rule, workflow, memory, message, tool output, ...), how they're grouped in the tree, what counts as still loaded, and how each item is labelled.

## Resolution

- **Top level:** the server's three Context Groups with exact counts: **System Prompt** (named sections), **Tools** (one per tool), **Chat Messages** (one per step).
- **Chat Messages:** in time order by default; items over a threshold (5% of the window by default, adjustable) are highlighted; a title-bar toggle switches to largest-first. Each item's icon shows its kind (user message, model reply, file read, file edit, command output, web, agent coordination, error).
- **Items:** a tool call and its result are merged into one item with the two counts added. Label `#<step> <tool or kind> <target> · <tokens>`, e.g. `#42 view_file src/foo.ts · 3.1k`; user messages show their first ~40 characters. The hover shows the full text (cut short), and thinking appears only in the hover; thinking is not a separate item.
- **Rules and skills:** per-rule and per-skill children (from `GetTokenBase`) under the `user_rules` and `skills` sections, only if the build confirms they add up to the section total; otherwise show the section total only.
- **Still loaded:** exactly what the latest server breakdown lists (this covers rewinds and compaction). File mode: the kept steps after removing rewinds.
- **File fallback:** the same tree, using the `conversations/<id>.db` breakdown where present; otherwise transcript estimates marked `~est`, with System Prompt and Tools combined into one **Baseline** remainder.
