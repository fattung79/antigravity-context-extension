# Glossary

**Conversation**: one agent chat session in Antigravity, with its own context window.

**Context window**: the model's token limit for a Conversation.

**Context Inventory**: the list of everything currently loaded into a Conversation's context: files, rules, workflows, memories, earlier messages, tool output.

**Context Item**: one entry in the Context Inventory, with its kind and its token cost.

**Token Gauge**: how full the context window is: tokens used vs. the model's limit. "Used" means what the model actually processed on its latest call, not Antigravity's own estimate.

_Avoid_: "chat context" on its own (unclear whether it means the gauge, the inventory, or the transcript).

**Brain folder**: Antigravity's per-Conversation storage folder (`brain/<conversation-id>/`), which holds the transcript. There can be more than one root (WSL side and Windows side).

**Transcript**: the step-by-step log of a Conversation: one line per step, with source, type, content and token counts.

**Active Conversation**: the Conversation selected in this window's agent panel. Each window has its own. When nothing is selected, the last one stays shown but marked *not selected*. Always shown.

**Recent Conversations**: up to `maxConversations` − 1 (default 2) other Conversations from any workspace, ranked by when they were last seen or last written, each dropped 3 minutes later.

**Context Group**: a top-level division of the Context Inventory, matching how Antigravity counts it: System Prompt, Tools, Chat Messages.

**Step**: one numbered entry in a Conversation (a user message, a model reply, or a tool result). Chat Messages has one Context Item per Step, except that a tool call and its result are merged into one item.

**Threshold**: per model, the token count past which the user thinks the model gets noticeably worse ("the dumb zone"). Colours the Token Gauge by used ÷ Threshold. Falls back to a default (150k), then to the Context window.

**Compaction**: Antigravity replacing a Conversation's earlier Steps with a written summary, so the context fits again. Manual (the user sends `/compact`) or automatic (when the next call would reach the Context window). Steps before it no longer count toward the Token Gauge.

_Avoid_: "truncation" (Antigravity's own label for every Compaction, but it suggests cutting text off rather than summarising it).

**Baseline**: in file-only mode, the remainder that the transcript can't account for (system prompt, tools, rules), shown as one estimated item.
