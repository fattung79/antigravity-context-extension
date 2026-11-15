# Gauge figure: Antigravity estimate vs billed tokens

Checked 2026-11-05 against 2 Conversations (30 model calls, Gemini 3.8 Flash), using `conversations/<id>.db` `gen_metadata` copies. Script: [gauge-figure-check.py](gauge-figure-check.py).

- Estimate = `.1.9.10.1` (the same figure as the RPC's `estimatedTokensUsed`). Billed = `.1.4.2 + .1.4.5` (input + cache read).
- "The estimate predicts the next call's billed figure": **rejected**. The ratio of the estimate to the next call's billed figure stays between 1.11 and 1.41.
- The gap is a roughly **fixed overcount of 3.3k-5.5k tokens** (4fe3805a: 5427 down to 3335, ending at 4018; b050cc8b: 5459 to 5404), not a percentage. In relative terms it's 41% at about 13k used, 13% at 30k, and an extrapolated 2-3% at 200k.
- Likely cause (inferred): Antigravity estimates the fixed system prompt and tools (about 18k) with an approximation, while billed counts come from the model API's tokenizer.
- Not checked: other models; behaviour near the limit or at compaction.
