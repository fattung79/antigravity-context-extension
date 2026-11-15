
## The cd5f84af drop

Conversation `7b4fe665-8570-4b6f-95f9-2feecd5f84af`. Verdict: **model switch, not context loss.** Billed totals are tokenizer-dependent.

Evidence (gen_metadata via WAL-aware copy, db had no -wal/-shm at copy time; plus live `GetCascadeTrajectoryGeneratorMetadata`):

| idx | step | model (`.1.21` / `chatModel.modelDisplayName`) | billed in+cache | est `.1.9.10.1` = `estimatedTokensUsed` | billed/est |
|---|---|---|---|---|---|
| 26 | 57 | Gemini 4 Argon (Medium) | 63,463 | 69,104 | 0.918 |
| 27 | 59 | Gemini 4 Argon (Medium) | 64,055 | 69,691 | 0.919 |
| 28 | 62 | Gemini 4 Argon (Medium) | 65,501 (cache 0) | 71,589 | 0.915 |
| 29 | 64 | **Gemini 3.8 Flash (Medium)** (`gemini-3.8-flash-n`) | 52,047 (cache 0) | 71,873 | **0.724** |
| 30 | 67 | Gemini 3.8 Flash (Medium) | 52,267 (cache 0) | 72,125 | 0.725 |

- The agent-side estimate (`estimatedTokensUsed`, breakdown total) never dropped: 71,589 to 71,873 (+284, grows normally). Only the provider-billed count fell (-13,454, -20.5%) when the model changed. The ratio billed/est is stable per model (0.915-0.919 Argon, 0.724-0.725 Flash), and the step-63 USER_INPUT carries `<USER_SETTINGS_CHANGE> ... changed setting Model Selection from Gemini 4 Argon (Medium) to Gemini 3.8 Flash (Medium)`. Different model = different tokenizer/accounting, so the same prompt is billed as a different token count.
- Cache 0 at step 62 and 64: step 61 SYSTEM_MESSAGE says "subagents and background tasks stopped due to server restart" (16:18, 20 min after step 59 at 15:57); cold cache. At step 64 the model changed, so a new cache was needed anyway; step 67 is also cache 0 (35 min idle). Both are expected, not compaction. Step 62 prompt is not smaller than before: 65,501 vs 64,055 at step 59 (+1,446).
- Group shrinkage (item 1): **not answerable per call.** Only the newest gen_metadata row (idx 30, and the live RPC's last entry) carries `tokenBreakdown`/`systemPrompt`/`tools`; rows 0-29 have `contextWindowMetadata` with only `estimatedTokensUsed` and `maxContextTokens`. idx 30: System Prompt 12,152, Tools 5,778, Chat Messages 54,195 (67 entries) = 72,125. Since the estimate grew +284 between idx 28 and 29, no group shrank by measurement; the 13.4k delta is outside the breakdown.
- Live LS (item 2): answered (all 11 windows' servers returned the same 31 entries; hub-port, no token printed). Calls around the drop: `truncationReason` absent in all; `checkpointIndex` -1 for all; `maxContextTokens` 256000; `estimatedTokensUsed` idx 26/27/28/29/30 = 69,104 / 69,691 / 71,589 / 71,873 / 72,125. No compaction/truncation.
- Transcript steps 57-67 (item 3): no large tool result dropped; steps 58-66 are user/system messages 158-996 chars, replies 62-591 chars, thinking 0-258 chars. Step 63 metadata block is small (617 chars, one open document). Nothing removed.
- Also seen: `.1.4.1` changes 1,418 (Argon, idx 27/28) to 1,319 (Flash, idx 29/30), the "constant 1319" in gemini-data-stores.md is the Flash value; it varies by model. `.1.4.5` (cache read) is absent, not 0, when cache is cold; the decoder must default to 0 (gauge-figure-check.py already does).

Implications for the gauge:
- Billed `input+cache` is **not comparable across a model change**; treat the drop as legitimate. Prefer `estimatedTokensUsed` (`.1.9.10.1`) as the monotonic fullness number, with `maxContextTokens` (`.1.9.10.4`) as the limit, when available; the latter ratio is consistent within a model.
- Show a "model changed" marker or normalise by the per-model billed/est ratio if billed is used.
- Not verified: whether the ratio is tokenizer vs. provider-side prompt rewriting (e.g. thinking history omitted for Flash); not determinable from the data. Only 2 models seen.

## Manual /compact in 8bdd6cb4

Conversation `8bdd6cb4-b3a1-4ed3-8335-b25a80cf1ce6`; step 24 USER_INPUT `/compact`, step 25 CHECKPOINT, step 27 first post-compaction call. Model Gemini 3.8 Flash throughout. Live RPC (12 candidate servers) + WAL-aware db copy (wal 0 bytes) agree.

**1. GetCascadeTrajectoryGeneratorMetadata: 13 calls (idx 0-12)**, max 256000, `checkpointIndex` -1 on idx 0-11.
| idx | stepIdx | est | usage in / cache | trunc | other |
|---|---|---|---|---|---|
| 0-9 | 1..19 | 18159 -> 31644 | 12747 -> 2879 (+cache from idx 5) | - | |
| 10 | 21,22 | 39199 | 7118 / 27325 | - | |
| 11 | 23 | 40028 | 3059 / 32396 | - | breakdown absent |
| 12 | 27 | **19568** | 14010 / (cache absent) | **TRUNCATION_REASON_MAX_TOKEN_LIMIT** | `startStepIndex`=25 instead of `checkpointIndex` |
- tokenBreakdown only on the last entry (idx 12): System Prompt 12141 (13 children), Tools 5796 (14), Chat Messages 1631 (2 children: `25: CHECKPOINT` 1503, `26: USER_INPUT` 128), total 19568. idx 11 had none in the live response (only last carries it, as before).
- Marker of compaction: idx 12 has `truncationReason` set (first ever observed), `checkpointIndex` absent (not -1), and new `chatStartMetadata.startStepIndex`=25 = the CHECKPOINT step: history before step 25 is replaced by the checkpoint summary. est fell 40028 -> 19568 (-20460), billed 35455 -> 14010, cache 0 (prefix changed).
- The **summarizing call (step 25, in 2642 + cache 35562 = 38204, out 1165) has no generator-metadata entry** (13 entries = 12 normal steps + step 27). The CHECKPOINT step's `sourceTrajectoryStepInfo.metadataIndex`=12 points at the post-compaction row. So summarizer cost is only visible in the transcript / step metadata, not in GM or the db.

**2. Why watcher showed calls=1 / est=18159:** 12 live servers; server index 0 returned a stale/partial view (1 entry = idx 0, est 18159), the other 11 returned all 13. `Rpc.latest()` took the first non-empty answer and then locked `self.cands` to it, so it never advanced. Not a cascade or caching issue. Fixed in compaction-watch.py (query all candidates, keep the one with most entries, no lock-in). Watcher run from step 20 on therefore never saw trunc/startStepIndex. Also not detected: the watcher only checks `checkpointIndex>=0`; add `startStepIndex`/truncationReason (trunc already flagged).

**3. db gen_metadata (13 rows; columns idx, data, size):**
- rows 0-11: `.1.9.10` has only fields 1 (est) and 4 (limit); `.1.9.2` = varint 2^64-1 (checkpointIndex -1); `.1.4.2`/`.1.4.5` give billed 12747..35455 matching RPC.
- row 12: `.1.9.1`=25 (startStepIndex), `.1.9.2` absent, `.1.9.10` has fields 1,2,3,4: **`.1.9.10.2`=2 (truncation reason enum, TRUNCATION_REASON_MAX_TOKEN_LIMIT)**, `.1.9.10.3` = breakdown (groups decode 12141/5796/1631), est 19568, billed 14010 (`.1.4.2` only). Extra top-level `.1` fields 1,2,8,10,16 (systemPrompt/tools/promptSections) present only on row 12; earlier rows lack them.
- Watcher gm_total absent for steps 25/27: it maps the n-th billed transcript step to gm row n. The CHECKPOINT step (billed, step 25) consumed gm index 12 and step 27 asked for index 13, which doesn't exist; at step 25 the row did not yet exist either. Misaligned by one because the summarizer call has no gm row. Fix idea (not applied): skip CHECKPOINT type when counting llm_n, or map via `stepIndices`.

**4. GetCascadeTrajectorySteps (28 steps):** CHECKPOINT step 25 carries `checkpoint{includedStepIndexEnd:25, sessionSummary (3775 chars), capturedUserRequests[4] (user texts incl. "/compact "), totalSubagentCount:0, renderLatestCheckpoint:true, summaryPromptContentId, summaryContentId}`, and `metadata.modelUsage` (in 2642, cache 35562, out 1165). Replaced range = steps 0..`includedStepIndexEnd` (25); matches `startStepIndex`=25 on gm row 12.

## Automatic compaction in 8bdd6cb4

Same conversation, later (84 GM rows via all-server query, 219 steps). Row = GetCascadeTrajectoryGeneratorMetadata index; `stepIndices` = steps that call produced. Model `gemini-3.8-flash-n` (MODEL_PLACEHOLDER_M319, "Gemini 3.8 Flash (Medium)") and maxContextTokens 256000 on all 84 rows. No threshold/compaction field anywhere: contextWindowMetadata only has estimatedTokensUsed, maxContextTokens, truncationReason, tokenBreakdown (only the last row); chatStartMetadata only checkpointIndex / startStepIndex; GetCascadeModelConfigData has only label/modelId/mime/tier/quota (GetCascadeModelConfigs returned empty).

**1. Rows (est / max / trunc / startStep / ckptIdx / billed=in+cache):**
| row | steps | est | trunc | start | ck | billed |
|---|---|---|---|---|---|---|
| 11 | 23 | 40028 | - | - | -1 | 35455 |
| 12 | 27 | 19568 | MAX_TOKEN_LIMIT | 25 | - | 14010 | (manual /compact)
| 13 | 29,30 | 20180 | - | 25 | - | 14723 |
| 26 | 64-69 | 174420 | - | 25 | - | 175403 |
| 27 | 70-74 | 228288 | - | 25 | - | 224507 | -> auto ckpt step 75 (not in GM)
| 28 | 76,77 | 20559 | MAX_TOKEN_LIMIT | 75 | 1 | 14993 |
| 29 | 78,79 | 36360 | - | 75 | 1 | 33425 |
| 56 | 132,133 | 234788 | - | 75 | 1 | 255266 |
| 57 | 134,135 | 235373 | - | 75 | 1 | 256201 | -> auto ckpt step 136
| 58 | 137-141 | 21069 | MAX_TOKEN_LIMIT | 136 | 2 | 15507 |
| 59 | 142-145 | 31585 | - | 136 | 2 | 26673 |
| 77 | 196-200 | 122309 | - | 136 | 2 | 127821 |
| 78 | 201-205 | 168297 | - | 136 | 2 | 205208 |
| 79 | 206-210 | 213215 | - | 136 | 2 | 281740 | -> auto ckpt step 211
| 80 | 212,213 | 21109 | MAX_TOKEN_LIMIT | 211 | 3 | 16055 |
| 81 | 214,215 | 21458 | - | 211 | 3 | 16444 |
Rest: est and billed grow monotonically between compactions (rows 14-25: 20.7k->128.9k est; 30-55: 51.9k->232.2k est). tokenBreakdown total only on row 83 (22552 = est). truncationReason is set only on the 4 first-after-compaction rows. Summarizing calls (step 75/136/211) again have no GM row. First-after startStepIndex = checkpoint step; checkpointIndex reappears (1,2,3) after auto ckpts but was absent after the manual one.

**2. Trigger numbers.** Summarizer call (step metadata modelUsage) = previous planner call's prompt + new tool results + summary prompt: 75: in 50808 + cache 224484 = 275292; 136: 6428 + 256190 = 262618; 211: 69155 + 281787 = 350942. Its cache ~= previous billed (224507 / 256201 / 281740).
| trigger | est(last call) | billed(last call) | billed/est | est+tool results of last call | billed of summarizer |
|---|---|---|---|---|---|
| 75 | 228288 | 224507 | 0.98 | n/a, real new input +50.8k -> ~275k | 275292 |
| 136 | 235373 | 256201 | 1.09 | ~+6.4k real -> ~242k est-scale | 262618 |
| 211 | 213215 | 281740 | 1.32 | ~+69k real | 350942 |
est never exceeded 256000 (max 235373) and is not the trigger (136 fired at est 235k while rows with est 234.8k did not). est undercounts billed by up to 25% (row 79: 213k vs 282k; row 78->79 est +44.9k vs billed +76.5k).
Highest non-triggering state: row 56 billed 255266 (0.997 of max). Row 57 billed 256201 (>256000) triggered next. Check on all rows 47-57, no-trigger case: prev billed + est delta of new content = 235.8k..255,851 (<256000 every time, max at row 57 = 255266+585); row 78->79: 205208+44918 = 250126 (<256000, no trigger, yet actual call was 281740).
**Best rule (medium confidence, ~70%):** before each model call, the projected prompt = previous call's real billed (input+cache) + estimated size of the newly added step results; if >= maxContextTokens (256000, ratio 1.0, not 0.8) the agent inserts a CHECKPOINT summarizing call instead. Consistent with all 3 triggers and ~50 non-triggers. 75's trigger cannot be fully verified (new tool-result est not stored). A pure `est>=0.8*max` (204.8k) is falsified (rows 45-56 est 199k-235k no trigger; compaction at est 228k/235k/213k only).
**Billed can exceed max without compaction: yes.** Row 79 was sent at 281740 (110% of 256000), row 57 at 256201, and summarizers at 262.6k/275.3k/350.9k. Cause: tool results added after a check are not counted at check time (est undercounts; one step batch added +76.5k billed in one go). Provider accepted >256k, so maxContextTokens is a soft client-side budget, not a hard API limit (at least up to 350.9k).

**3.** Model and 256000 constant across all rows (Flash "Medium", M319). No threshold field exposed via Get*/List* (checked chatStartMetadata keys, contextWindowMetadata keys, GetCascadeModelConfigData; GetAvailableCascadeModels HTTP error).

**4. CHECKPOINT steps 25 vs 75/136/211:** same type/source (CORTEX_STEP_SOURCE_SYSTEM), same fields. Differences are only `checkpointIndex` (absent at 25; 1/2/3 at 75/136/211), `includedStepIndexStart` (absent at 25; 25/75/136), `includedStepIndexEnd` (25/75/136/211), summary sizes (3775/6975/8501/8545 chars), capturedUserRequests (4/8/8/10). No auto-vs-manual flag or trigger reason; the only manual marker is the captured "/compact " USER_INPUT in capturedUserRequests and the preceding USER_INPUT step 24. Auto vs manual is inferable only by absence of a preceding /compact step.
