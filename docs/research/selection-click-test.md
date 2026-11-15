# Selection click test (live)

Run 2026-11-05 in the agy-b window (workspace `17e4c009`, D365-Workspace, WSL), watched every 1s with [selection-click-test-watch.py](selection-click-test-watch.py). Run 1 contributed only the first new-chat timings (the other window's actions were in Claude Code).

| Time | User action | Signals seen |
|---|---|---|
| 16:00:41 | (run 1) new chat "hi" | annotation created 16:00:41; `lastConversationId` set 16:00:41.9; RUNNING 16:00:42, transcript + gen row 16:00:45 |
| 16:11:49 | click "General Greeting" (7a1d9b1f) | annotation 7a1d9b1f view=16:11:49 (≤1s). `lastConversationId` change missed (see read error) |
| 16:12:06 | switch to old chat 4fe3805a (other workspace) | **both** 4fe3805a and 7a1d9b1f annotations view=16:12:06 (tie); workspace db copy failed (`no such table`, caught mid-write); 4fe3805a annotation again 16:12:39 |
| ~16:12:41 | new chat | `lastConversationId` = None (new/empty panel clears it) |
| 16:12:50 | ask "how many files in docs" | annotation 24da2248 created; `lastConversationId`=24da2248 within 0.1s; RUNNING; transcript and gen row together at 16:12:56, 16:13:20; IDLE 16:13:21 |
| ~16:14:00 | model changed to Flash 3.8 Medium, "thanks" | annotation view 16:13:56; turn 16:14:00-02; no separate signal for the model change |
| 16:15:20-22 | back to General Greeting | 24da2248 view=16:15:20, then **both** 24da2248 and 7a1d9b1f view=16:15:22 (tie); `lastConversationId`=7a1d9b1f at 16:15:23 (~1s) |
| 16:16:25 | "bye" | transcript user line 16:16:25, reply + gen row 16:16:29 |

## Findings

1. **`last_user_view_time` updates within 1s on click, but a switch stamps BOTH the old and the new Conversation with the same time** (2 of 2 switches). It means "last seen", not "selected"; max() over it is ambiguous on every switch.
2. **`lastConversationId` (the window's workspace `state.vscdb`) updates within ~0.1-1s** of selecting or creating a Conversation in that window, not the ~19s the earlier research expected, and is cleared to None on a new, empty chat. It is the reliable "selected" signal for a window. Not seen: its value while viewing a Conversation from another workspace (the read failed then).
3. **Copying `state.vscdb` while it's being written can give a broken copy** (`no such table: ItemTable`); the reader must retry.
4. **The transcript line and `gen_metadata` row land together** (same ~1-5 ms poll) on every turn; summaries `status` goes RUNNING then IDLE around each turn.
5. A model change has no signal of its own until the next turn.
6. Noise: another window's workspace rewrites `lastConversationId=None` about once a minute while its panel shows nothing.
