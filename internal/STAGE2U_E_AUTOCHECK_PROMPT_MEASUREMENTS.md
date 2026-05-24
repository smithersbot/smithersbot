# Stage 2U-E Autocheck Prompt Measurements

Source: `buildAutocheckPrompt` measured after the Stage 2U-E autocheck change, with
the pre-change shape reconstructed by moving `REVIEW_INSTRUCTION` from the suffix
back to the end of the same prompt body. The fresh-fallback fixture also
reconstructs the old uncompact prior-feedback list.

| Fixture | Before chars | After chars | Stable prefix chars | Result |
| --- | ---: | ---: | ---: | --- |
| Round 1 fresh review | 6,977 | 6,977 | 5,372 | Same size; static review rubric is now cache-friendly prefix |
| Round 2 resume review | 7,049 | 7,049 | 5,372 | Same size; static review rubric is now cache-friendly prefix |
| Fresh fallback with 4 prior feedback entries | 7,243 | 7,238 | 5,372 | Older repeated feedback compacted |

Expected effect: normal autocheck rounds preserve reviewer context and semantics
while making the highest-stability rubric content the prompt prefix. Providers
with prefix caching should be able to reuse the 5,372-character review instruction
across goals, rounds, and resume/fresh modes. Token capture and per-round history
events remain covered by `src/goal/plan-autocheck.test.ts`.
