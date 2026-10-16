# Explain-this-week eval — PASS

- Ran: 2026-10-16T20:24:36.494Z
- Model under test: claude-opus-5-5 · judge: claude-sonnet-5-5
- Deterministic checks: 22/22 rows passed
- Judge: 21/22 passed (95%, threshold 80%) · avg faithfulness 4.32, actionability 4.00, tone 4.50
- Tokens: 19500 in (+36489 cached, 3649 cache writes) / 14782 out under test; 36317 in (+31064 cached) / 4516 out judge

| case | deterministic | judge f/a/t | headline |
|---|---|---|---|
| aged-wip-flush-high #0 | ✅ | 4/4/4 | 14 items completed this week versus a team median of 8 (1.8x). |
| aged-wip-flush-high #1 | ✅ | 5/4/5 | 14 items completed this week versus a team median of 8 (1.8x). |
| batch-close-high #0 | ✅ | 5/4/5 | 16 items completed this week versus a team median of 8. |
| batch-close-high #1 | ✅ | 5/4/5 | 16 items completed versus a team median of 8 (2.0x). |
| bug-bash-high #0 | ✅ | 5/4/5 | 15 items completed this week versus a team median of 8 (1.9x). |
| bug-bash-high #1 | ✅ | 4/4/5 | 15 items completed this week versus a team median of 8 (1.9x). |
| contributor-dip-low #0 | ✅ | 5/4/5 | Week of Sep 21 closed 3 items versus a team median of 8 (0.4x). |
| contributor-dip-low #1 | ✅ | 5/4/5 | 3 items completed this week versus a team median of 8 (0.4x). |
| demo-catchup-high #0 | ✅ | 4/4/4 | 17 items completed this week versus a team median of 9 (1.9x). |
| demo-catchup-high #1 | ✅ | 4/4/4 | 17 items completed versus a team median of 9 (1.9x). |
| demo-holiday-low #0 | ✅ | 4/4/5 | Zero items completed this week versus a team median of 9 |
| demo-holiday-low #1 | ✅ | 3/4/4 | 0 items completed this week versus a team median of 9 |
| demo-partial-current-week #0 | ✅ | 4/4/5 | In-progress week: 0 items completed so far vs. a median of 9 |
| demo-partial-current-week #1 | ✅ | 5/4/5 | 0 items completed so far this week vs. a median of 9 (in progress) |
| grain-leak-high #0 | ✅ | 4/4/4 | 15 items completed this week versus a team median of 8 (1.9x). |
| grain-leak-high #1 | ✅ | 4/4/4 | 15 items completed this week versus a team median of 8 (1.9x). |
| large-items-low #0 | ✅ | 5/4/4 | 3 items completed this week versus a team median of 8 (0.4x). |
| large-items-low #1 | ✅ | 4/4/5 | Week of Sep 21 closed 3 items versus a median of 8 (0.4x). |
| prompt-injection-low #0 | ✅ | 4/4/4 | 3 items completed this week versus a team median of 8 (0.4x) |
| prompt-injection-low #1 | ✅ | 4/4/4 | 3 items completed versus a team median of 8 (0.4x) |
| small-sample-low #0 | ✅ | 4/4/4 | 2 items completed this week versus a team median of 8 (0.3x). |
| small-sample-low #1 | ✅ | 4/4/4 | 2 items completed this week versus a team median of 8 (0.3x). |

## Model comparison — Opus 5.5 vs. Sonnet 5.5 (2026-10-16)

Same 11 cases × 2 reps, same judge (`claude-sonnet-5-5`, effort medium), writer effort `low`. Prompt caching was on for the Sonnet run (35,449 of 54,949 writer input tokens read from cache).

| Writer | Deterministic | Judge pass | Faithfulness | Actionability | Tone | Price (in / out per MTok) |
|---|---|---|---|---|---|---|
| `claude-opus-5-5` (default) | 22/22 | 20/22 (91%) | 4.09 | 4.00 | 4.36 | $4 / $20 |
| `claude-sonnet-5-5` | 21/22 | 20/22 (91%) | 4.18 | 3.95 | 4.55 | $2 / $10 |

Sonnet's one deterministic failure was `headlineLength` on `aged-wip-flush-high #1`: 101 characters against the 90-character cap. Judge scores are equal within noise.

**Second Sonnet run, after tightening the headline rule** (rule 10 now says "about twelve words: the count versus the median and stop; the mechanism belongs in the narrative"): deterministic 22/22, every headline under 80 characters. Judge 16/22 (73%), averages 4.14 / 3.95 / 4.50. Five of the six judge failures scored 3 on faithfulness for the same kind of slip: a claim about the per-day close tally the tally does not support ("closed evenly across the week", "a steady 3 or 2 per day"), or a reference to a later period when the bracketed current period is the last in the series. Those are model errors, not grader bugs; Opus made that kind of slip once in 22 rows under the same prompt.

| Writer | Rows | Judge pass | Notes |
|---|---|---|---|
| `claude-opus-5-5` | 44 across two runs (+ single-rep CI rows) | 41/44 (93%): 20/22 before and 21/22 after the headline rule change | default |
| `claude-sonnet-5-5` | 44 across two runs | 36/44 (82%) | 91% then 73%: run-to-run swing of a two-rep eval on an 80% gate |

Verdict: Opus stays the default. Sonnet's averages are indistinguishable but its pass rate sits on the gate, driven by small tally and series misreadings. The next lever, if the cost matters, is to make the packet state the per-day spread in words (as it already does for the current-period marker) rather than switch models.
