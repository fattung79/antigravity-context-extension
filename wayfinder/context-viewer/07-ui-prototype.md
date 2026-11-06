---
id: 07-ui-prototype
title: How should the status bar gauge and sidebar tree look and behave?
labels: [wayfinder:prototype]
parent: MAP
blocked_by: [05-context-item-taxonomy, 01-selection-signal, 11-multi-window-active]
assignee: v-DominicLee
status: closed
---

## Question

Rough prototype of the status bar text and tooltip and of the tree (Active and Recent Conversations, groups, ~est markers, expiry), to react to before the spec.

## Resolution

Prototype: [prototype/context-viewer-ui/index.html](../../prototype/context-viewer-ui/index.html) on the throwaway branch `prototype/context-viewer-ui` (not merged). Of three variants, **A (Conversations as roots)** won.

- **Tree:** one view, "Context Inventory". Each Conversation is a root: Active first and expanded (dimmed with "not selected" when nothing is selected), then Recent ones collapsed. Root description: `62% · 159k/256k · rpc`, and on Recent ones also `drops in 2:41`. Under each root: the System Prompt / Tools / Chat Messages groups from the Context Item kinds decision (Baseline + Chat Messages in file mode, `~est`). Title buttons: largest first, refresh, collapse all.
- **`contextViewer.maxConversations`** (default 3, counting the Active one) caps both the tree and the status bar; Recent Conversations = max − 1.
- **Status bar:** with only the Active Conversation, one item: `◔ ctx 62% · 159k/256k` (`159k / ?` with no limit, trailing `~` in file mode). With Recent ones showing, one item per Conversation with the title cut to ~10 characters at a word break: `◔ Fix WSL… 62% · 159k/256k` `◷ Refactor… 41%` `◷ Can you… 16%`. The Active one keeps the numbers; hover = that Conversation's tooltip; click = reveal it in the tree.
- **Tooltip:** title, model, used (billed input + cache read) / limit, Antigravity's estimate, **threshold row** (`40% of 190,000 · threshold["Gemini 3.8 Flash"]`), limit source, data source, running totals.
- **Threshold colouring** (each status bar item, plus the Conversation's root icon in the tree): ratio = used ÷ threshold. ≤50% green text (healthy), >50% yellow text (`StatusBarItem.color`), >80% amber (`statusBarItem.warningBackground`), >100% red (`statusBarItem.errorBackground`). The tree tints via a ThemeIcon colour (yellow and up only; healthy = no tint). The dimmed "not selected" colour overrides green.
- **Threshold** = the token count where the user thinks the model "dives into the dumb zone". Settings are entered **in thousands** (`150` = 150k). First match: `contextViewer.threshold["<model key>"]` (model key as in the limits decision) > `contextViewer.threshold.default` (**default 150**) > the model's limit if the default is cleared > none (no colour, not even green).
- **Other colours:** heavy Chat Messages items (>5% of the window, adjustable) tinted in the error colour; the dimmed "not selected" state uses the theme's disabled foreground. A native tree can't colour labels directly, so label tints go through a FileDecorationProvider on a synthetic `resourceUri`; there is no opacity, so "dimmed" = disabled grey.
- **Not settled here:** where the hover text gets cut off (the prototype used 2,000 characters), so that part of the "privacy and display of raw content" fog stays open.
