# ado-flow-metrics

**Flow metrics for Azure DevOps teams — WIP aging, PR aging, throughput, cycle time, and Monte Carlo delivery forecasting — in one small local app.** Your PAT never leaves the server process.

[![CI](https://github.com/jacobv25/ado-flow-metrics/actions/workflows/ci.yml/badge.svg)](https://github.com/jacobv25/ado-flow-metrics/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

| Work items | Pull requests | Forecast |
|---|---|---|
| ![WIP aging dashboard](docs/screenshots/index.png) | ![PR aging dashboard](docs/screenshots/prs.png) | ![Delivery forecast](docs/screenshots/forecast.png) |

*Screenshots are from demo mode — a fictional 8-person team with synthetic, seeded data.*

## Why this exists

Azure DevOps boards show you **status**. They don't show you **age** — how long a story has sat in "Active," how long a pull request has waited for a reviewer, or how many items the team actually finishes in a normal week. I built this for my own team (20 engineers, one ADO project, no flow visibility) to answer four questions during planning and stand-up:

1. **What's stuck?** Which work items have been in progress longer than our policy allows?
2. **What's waiting on review?** Which PRs are aging, stale, or sitting with reviewers who haven't voted?
3. **How fast do we really deliver?** Weekly throughput and cycle-time percentiles (p50 / p85 / p95), and *why* an unusual week was unusual.
4. **When will this batch be done?** A probabilistic forecast — "20 tickets: 85% confident by Nov 9" — from historical throughput, with no per-ticket estimation.

The WIP-aging and PR-aging policies this tool made visible are the ones my team adopted. The open-source version ships with a **demo mode** so you can run every view without an Azure DevOps account.

## Quick start (demo mode, no Azure DevOps needed)

```sh
git clone https://github.com/jacobv25/ado-flow-metrics.git
cd ado-flow-metrics
npm install
npm run demo          # DEMO_MODE=true — synthetic data, zero network calls
open http://localhost:3333
```

Demo mode swaps the Azure DevOps HTTP client for [`lib/demoAdo.js`](lib/demoAdo.js), a deterministic fake that answers the same three REST endpoints (`wit/wiql`, `wit/workitemsbatch`, `git/pullrequests`). **Every route in `server.js` runs unchanged** — only the transport differs — so what you see is what a live org would show.

## Connect to your organization

```sh
cp .env.example .env     # then fill in ADO_ORG, ADO_PROJECT, ADO_PAT
npm start
```

Your PAT needs **Work Items (Read)** and **Code (Read)** scopes. See [`.env.example`](.env.example) for on-prem Azure DevOps Server and corporate-CA options.

**Security model:** the browser only ever talks to `localhost`. The PAT is read once from the environment and used by a single `adoRequest()` helper; it is never sent to the page, logged, or written to disk. All query inputs (states, types, day windows) are validated against allowlists before they reach a WIQL query.

## What each view shows

**Work Items** — every item in a WIP state (configurable: `Active`, `In Progress`, `Committed`, …), its days-in-state, and an age band (On Track / Watch / At Risk / Critical with thresholds you set). Summary cards, an aging-distribution chart, filters by type and tag, search, sort, pagination. Thresholds and filters persist in `localStorage`.

**Pull Requests** — open PRs with age, derived review state (`awaiting`, `approved`, `changes`, `rejected`, `draft`, `none` — computed from reviewer votes and required-reviewer rules), merge-conflict flag, and reviewer avatars. Plus a time-to-merge distribution and average over the last 7 / 14 / 30 / 90 days.

**Forecast** — weekly throughput over a 28–180 day window with mean and IQR band, cycle-time percentiles, and two Monte Carlo questions: *how long for N items?* (p50 / p70 / p85 / p95 dates) and *how many by a date?* The **Outlier Insights** panel flags unusual weeks (Tukey IQR fence, MAD fallback for small samples) and explains each one from the items in that bucket: type mix, size mix, contributor count, batch-close clusters, aged-WIP flushes.

## "Explain with AI" — and the eval that keeps it honest

Every flagged week on the Forecast page has an **Explain with AI** button. The server assembles a data packet from the numbers already on the page (count vs. median, baseline, the rule engine's findings, the completed items) and asks Claude for a **schema-validated** explanation: a headline, a two-to-four-sentence narrative, up to three likely causes with the evidence for each, questions to ask the team, and caveats. The UI renders fields, never prose it has to parse.

Guardrails are in the design, not just the prompt:

- **Assignee names never leave the server.** The packet carries contributor *counts*, so the explanation talks about capacity, not people.
- **Ticket titles are treated as untrusted data.** They are fenced in the prompt and the system prompt says to ignore instructions inside them; the eval includes a prompt-injection case.
- **Only numbers from the packet may appear**, the week must be described in the right direction, certainty language is banned, and a partial week must be called out as such.
- **Without an API key** the button shows a deterministic sample in demo mode and is hidden in live mode. Set `ANTHROPIC_API_KEY` (and optionally `EXPLAIN_MODEL`, default `claude-opus-5-5`) to turn it on.

Token spend is bounded by design too:

- **Repeat clicks are free.** The server caches each answer for 24 hours under a hash of the exact payload and model ([`lib/explainCache.js`](lib/explainCache.js)), so the same outlier viewed again, by anyone, costs nothing. The button turns into **Regenerate**, which bypasses the cache on purpose.
- **The system prompt is a prompt-cache breakpoint.** It is identical on every call, so after the first call in five minutes it is read at 5% of the input price. Measured on a live click: 1,772 of 2,319 input tokens came from cache, cutting the per-explanation cost by about 30% (output tokens, which the schema already keeps short, are now most of the bill). The eval's judge caches its rubric the same way.
- **Output is capped at 1,500 tokens.** A normal explanation is about 650; the cap only bounds a runaway.
- **Model choice is measured, not assumed.** Sonnet 5.5 at half the price scored the same with the judge as Opus 5.5 (see below), so `EXPLAIN_MODEL=claude-sonnet-5-5` is a supported, tested option.

The feature ships with an **eval harness** in [`evals/`](evals/) rather than a vibe check:

```sh
npm run eval          # 11 golden cases × Claude under test, deterministic checks + LLM judge (needs ANTHROPIC_API_KEY; add --reps 2)
npm run eval:stub     # offline self-test of the harness on the deterministic stub (what CI runs without a key)
npm run eval:cases    # regenerate the golden cases
```

- **Golden cases** ([`evals/cases/`](evals/cases/)) — three straight from demo mode (holiday dip, catch-up spike, partial current week) plus eight hand-shaped buckets that each isolate one mechanism: batch close, contributor dip, aged-WIP flush, bug bash, oversized items, epic-level grain leak, a prompt-injection attempt, and a small-sample (MAD) week.
- **Deterministic graders** ([`evals/checks.js`](evals/checks.js)) — schema validity, headline length, direction consistency, no invented numbers, no person names, hedging, partial-week caveat, injection resistance, questions phrased as questions, and per-case must-mention terms. Each grader is unit-tested against a deliberately wrong answer so the eval can't pass garbage.
- **LLM judge** ([`evals/judge.js`](evals/judge.js)) — a different model (`claude-sonnet-5-5`) scores faithfulness, actionability, and tone independently, 1–5 with a rationale, as structured output. It is told not to reward length and sees the candidate as fenced data.
- **Pass criteria** — every deterministic check on every row, and a judge pass rate of at least 80% (all three scores ≥ 4). The runner recomputes the headline numbers from the per-case rows and writes `evals/results/latest.md`.

**Latest live result** ([`evals/RESULTS.md`](evals/RESULTS.md), 2026-10-13, 11 cases × 2 reps): deterministic 22/22, judge 20/22 (91%), mean faithfulness 4.09 / actionability 4.00 / tone 4.36.

**Opus vs. Sonnet** (2026-10-16, same 11 cases × 2 reps): Sonnet 5.5 scored judge 20/22 (91%), faithfulness 4.18 / actionability 3.95 / tone 4.55, indistinguishable from Opus, but failed one deterministic row with a 101-character headline against the 90-character cap, so it does not clear the gate as it stands. Opus stays the default; the comparison table is in `evals/RESULTS.md`. Half the price for the same judged quality is a strong case for tightening the headline instruction and re-running rather than paying for Opus.

**What the first live run taught me.** The very first run scored 3/11 on the deterministic checks and 64% with the judge, and almost none of it was the model's fault. The number grader rejected faithful roundings of packet averages, the sentence counter split on "vs.", and the direction check didn't know "zero items" means low. Fixing the graders exposed the next layer: the judge was unstable, swinging the same case between 3 and 4 on faithfulness depending on how its rubric was worded, and a subtractive rubric made it hunt for deductions ("half the usual contributors is loosely worded, though 3 vs 6 is right"). What finally held was (1) giving the writer and the judge the *same* written definition of what "high", "medium", and "low" confidence mean, (2) scoring faithfulness on facts only and moving calibration into tone, where overconfidence already lived, and (3) putting facts into the packet that the model had been guessing at: which value in the series is the current period, and a per-day tally of closes. Two reps per case, not one, so a single noisy judgement can't flip the gate. The commit history in `evals/` shows each step.

## How the forecast works

Instead of sizing tickets, the forecast samples the team's own history. Each trial draws random past weeks (with replacement) and accumulates completed items until the batch is done; thousands of trials give a distribution of finish weeks, read off at the 50/70/85/95th percentiles. The math lives in [`lib/montecarlo.js`](lib/montecarlo.js) — pure, dependency-free, seedable, and shared verbatim between Node and the browser. Assumptions are stated on the page itself (items are sized like past work, WIP stays disciplined, the window is representative).

Outlier detection and attribution are in [`lib/outliers.js`](lib/outliers.js), same shape: pure functions, UMD, tested. The labels are heuristics, not certainties — the tool says so, because it can't see holidays or PTO.

## Architecture

```
server.js              Express proxy. Env validation, input allowlists, 6 JSON routes.
lib/adoClient.js       The only place HTTPS calls happen. PAT stays here.
lib/demoAdo.js         Fake ADO for DEMO_MODE: seeded synthetic team, same endpoints.
lib/montecarlo.js      Forecasting (pure, UMD, seedable).
lib/outliers.js        Outlier detection + attribution (pure, UMD).
lib/explain.js         "Explain with AI": payload schema, prompt, Claude call (structured output), offline stub.
evals/                 Eval harness for the AI feature: golden cases, deterministic graders, LLM judge, runner.
public/                Three hand-written pages + shared common.js/styles.css. Chart.js via SRI-pinned CDN.
tests/unit/            Vitest unit tests for the analytics modules and the demo fake.
tests/e2e/             Playwright suite that boots demo mode and drives all three pages.
docs/plans/            The design docs each feature was built from (see below).
```

Runtime dependencies: `express`, `dotenv`, `@anthropic-ai/sdk`, `zod`.

## Design docs

Each feature beyond the original WIP view started as a written plan — options, trade-offs, a recommendation, and a phased roadmap — before any code:

- [`docs/plans/PR-AGING-PLAN.md`](docs/plans/PR-AGING-PLAN.md) — PR age, staleness, review wait, time-to-merge; mapping each to the Git REST API.
- [`docs/plans/FORECASTING-PLAN.md`](docs/plans/FORECASTING-PLAN.md) — why throughput sampling beats per-ticket estimates; Monte Carlo design; applying it to a 20-ticket batch.
- [`docs/plans/THROUGHPUT-OUTLIERS-PLAN.md`](docs/plans/THROUGHPUT-OUTLIERS-PLAN.md) — turning "this week was weird" into "here's probably why."

## Tests

```sh
npm test            # unit — Vitest
npm run test:e2e    # end-to-end — Playwright, boots demo mode itself
npm run test:all
```

**Unit (Vitest, `tests/unit/`)** — the pure analytics modules and the demo fake:

- `outliers.test.js` — IQR and MAD detection paths, degenerate inputs, baseline computation, bucket summaries, explanation narratives.
- `montecarlo.test.js` — the forecasting contract with an injected seeded RNG: degenerate samples give exact answers, percentiles are monotonic, same seed → same forecast, zero-throughput history returns the sentinel instead of looping, inverted `atLeastXX` percentiles order correctly.
- `demoAdo.test.js` — the fake honours the slice of the Azure DevOps REST contract `server.js` depends on: WIQL state/type/date filters and `$top`, batch field selection with `errorPolicy: Omit`, PR pagination and `minTime`.
- `explain.test.js` — the AI feature with a fake Anthropic client: payload validation, the prompt never contains assignee names, partial weeks are flagged, structured-output request shape, refusal / truncation / SDK-error paths.
- `evalChecks.test.js` — the eval's graders themselves: the stub passes every check on every case, and each deliberately wrong answer fails exactly the check meant to catch it.
- `explainCache.test.js` — the explanation cache: the key ignores object key order but not array order or the model name, entries expire on the TTL, and the oldest entry is evicted past the cap.

**End-to-end (Playwright, `tests/e2e/`)** — hermetic, against demo mode on a throwaway port:

- `api.spec.js` — every route's shape, plus input validation (`400` on malformed states, bad windows, unknown PR status). Includes a regression for the priority field that used to come back `null`.
- `work-items.spec.js` — summary cards agree with the table, most-aged-first ordering, search, type and tag filters, threshold settings persisting across a reload.
- `pull-requests.spec.js` — review-state filters, conflicts-only, cycle-time window switch, and a regression for the "undefined PRs merged" caption.
- `forecast.spec.js` — throughput cards are internally consistent, outlier panel flags the holiday dip low and the catch-up week high, "how long" yields four ordered dates, a deadline switches to "how many" mode, cycle-time percentiles are ordered, and "Explain with AI" renders a structured explanation (the demo stub, since the suite runs without a key).

CI runs the unit suite on Node 20 and 22, the Playwright suite on Chromium, and the eval. The eval runs live against Claude only when the `ANTHROPIC_API_KEY` secret is present *and* something that can change the model's output changed (`lib/explain.js`, `evals/`, the lockfile, or the workflow), or on a manual dispatch; every other push runs the free harness self-test on the stub, so a README edit costs nothing. Eval results are uploaded as an artifact on every run.

## Known limitations

- **PR staleness is approximate.** Stale days currently equal PR age; per-PR activity lookups (threads, pushes) are the next phase in the PR plan.
- **The current, partial week is included** in throughput stats. A sparse Monday can look like a slow week.
- **Azure DevOps only.** A GitHub provider behind the same `adoRequest()` seam is on the roadmap.

## Built with

Node 18+, Express, Chart.js, the Anthropic SDK with structured outputs, Vitest, Playwright, and an AI coding agent (Claude Code) in the loop — the plan documents above were the planning artifacts for each session.

## License

[MIT](LICENSE)
