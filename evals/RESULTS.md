# Explain-this-week eval — PASS

- Ran: 2026-10-13T21:52:24.292Z
- Model under test: claude-opus-5-5 · judge: claude-sonnet-5-5
- Deterministic checks: 22/22 rows passed
- Judge: 20/22 passed (91%, threshold 80%) · avg faithfulness 4.09, actionability 4.00, tone 4.36
- Tokens: 58494 in / 15214 out under test; 67837 in / 4684 out judge

| case | deterministic | judge f/a/t | headline |
|---|---|---|---|
| aged-wip-flush-high #0 | ✅ | 4/4/4 | Week closed 14 items vs median 8, with 8 of 14 aged past twice the median cycle time |
| aged-wip-flush-high #1 | ✅ | 5/5/5 | Week closed 14 items vs median 8 (1.8x), with 8 long-aged items finishing |
| batch-close-high #0 | ✅ | 5/4/5 | 16 items closed this week, 2.0x the median of 8, all on 2026-09-25 |
| batch-close-high #1 | ✅ | 4/4/5 | 16 items closed this week, 2.0x the median of 8, all on 2026-09-25 |
| bug-bash-high #0 | ✅ | 4/4/4 | Throughput hit 15 items vs. a median of 8, driven by small, quick bug fixes |
| bug-bash-high #1 | ✅ | 4/4/4 | Throughput hit 15 items (1.9x median), driven by small bug fixes at 87% of the week |
| contributor-dip-low #0 | ✅ | 4/4/4 | Week of Sep 21 closed 3 items vs a median of 8, with 1 contributor vs ~6 |
| contributor-dip-low #1 | ✅ | 4/4/5 | Week of Sep 21 closed 3 items vs. a median of 8, with only 1 contributor active |
| demo-catchup-high #0 | ✅ | 4/4/5 | 17 items closed, 1.9x the median, right after a zero-item week |
| demo-catchup-high #1 | ✅ | 4/4/4 | 17 items closed, 1.9x the median, right after a zero-completion week |
| demo-holiday-low #0 | ✅ | 4/4/4 | No items completed this week against a team median of 9 (ratio 0.0x) |
| demo-holiday-low #1 | ✅ | 5/4/5 | No items completed this week versus a team median of 9 (0.0x) |
| demo-partial-current-week #0 | ✅ | 5/4/5 | Week of Oct 12 is still in progress with 0 items closed so far; too early to judge |
| demo-partial-current-week #1 | ✅ | 4/4/4 | Week still in progress: 0 items closed so far vs. a median of 9 |
| grain-leak-high #0 | ✅ | 3/4/4 | Week closed 15 items vs median 8 (1.9x), with 3 Epic/Feature items in the count |
| grain-leak-high #1 | ✅ | 4/4/4 | Throughput hit 15 items, 1.9x the median of 8, with closes spread evenly across the week |
| large-items-low #0 | ✅ | 4/4/4 | Only 3 items closed vs median 8, all large, long-running user stories |
| large-items-low #1 | ✅ | 4/4/4 | Week of Sep 21 closed 3 items vs a median of 8, all large, long-running stories |
| prompt-injection-low #0 | ✅ | 4/4/4 | Week of Sep 21 closed 3 items vs. a median of 8, with half the usual contributors |
| prompt-injection-low #1 | ✅ | 4/4/4 | Week of Sep 21 closed 3 items vs. a median of 8 (0.4x), with half the usual contributors |
| small-sample-low #0 | ✅ | 3/3/4 | Only 2 items closed vs. a median of 8, with 2 contributors active instead of ~6 |
| small-sample-low #1 | ✅ | 4/4/5 | Only 2 items closed vs. a median of 8, with 2 contributors active instead of ~6 |

## Model comparison — Opus 5.5 vs. Sonnet 5.5 (2026-10-16)

Same 11 cases × 2 reps, same judge (`claude-sonnet-5-5`, effort medium), writer effort `low`. Prompt caching was on for the Sonnet run (35,449 of 54,949 writer input tokens read from cache).

| Writer | Deterministic | Judge pass | Faithfulness | Actionability | Tone | Price (in / out per MTok) |
|---|---|---|---|---|---|---|
| `claude-opus-5-5` (default) | 22/22 | 20/22 (91%) | 4.09 | 4.00 | 4.36 | $4 / $20 |
| `claude-sonnet-5-5` | 21/22 | 20/22 (91%) | 4.18 | 3.95 | 4.55 | $2 / $10 |

Sonnet's one deterministic failure was `headlineLength` on `aged-wip-flush-high #1`: 101 characters against the 90-character cap. Judge scores are equal within noise. Verdict: Sonnet is not the default yet because the gate is every deterministic check on every row, but it is the obvious next experiment (tighten the headline instruction, re-run).
