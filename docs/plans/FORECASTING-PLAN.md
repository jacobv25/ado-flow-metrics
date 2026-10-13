# Forecasting — Extension Plan for the WIP Aging Tracker

**Status:** Proposal · **Date:** 2026-05-23 · **Scope:** Add probabilistic
delivery forecasting (Monte Carlo over flow metrics) alongside the existing
Work-Item (WIP) and Pull-Request aging views.

This document is a *plan only* — no code has been changed. It lays out how to
estimate a batch of tickets from historical flow data instead of sizing each
one by hand, the Azure DevOps data involved, several solution options at each
design decision (with trade-offs), a recommended path, and a phased roadmap.

The immediate motivation: ~20 tickets have just become urgent and need an
estimate fast. Section 14 applies the proposed feature directly to that batch.

---

## 1. Goal

The app today answers two *backward-looking* questions — "which work items
have sat in a WIP state too long?" and "which PRs are aging?" It has no
*forward-looking* answer. We want it to also answer:

1. **How long?** — "Given how this team actually delivers, when will all
   *N* tickets realistically be done?" — as a range with confidence levels,
   not a single date.
2. **How many?** — "Given a fixed deadline, how many of the *N* tickets can we
   realistically expect to finish by then?" — so scope can be cut deliberately.

Both questions are answered the same way: **empirical forecasting**. Instead of
estimating each ticket (story points, hours, t-shirt sizes), we forecast the
whole batch from the team's historical **throughput** — the rate at which work
items actually reach a done state. This needs no per-ticket estimation, which
is exactly what's wanted when 20 items go urgent at once and there is no time
to size them individually.

The feature surfaces three signals:

1. **Throughput** — work items completed per week (or per day) over a trailing
   window. This is the engine of every forecast below.
2. **Forecast distribution** — a Monte Carlo simulation that turns historical
   throughput into a probability curve over completion dates and over
   item-counts-by-a-date.
3. **Cycle time** — elapsed time from "started" to "done" for completed items,
   used as a sanity check that the new tickets are sized like historical ones.

---

## 2. Current architecture (recap)

A deliberately small app — one Express proxy plus static pages:

| File | Role |
| --- | --- |
| `server.js` | Express proxy. Holds the PAT server-side, validates env, exposes `/api/config`, `/api/wip-aging`, `/api/pr-aging`, `/api/pr-cycle-time`. Input helpers (`parseStates`, `parseMax`, `parseCycleDays`, `wiqlString`) sanitize every query. |
| `lib/adoClient.js` | The single `adoRequest()` HTTP helper — Basic-auth with the PAT, TLS agent options, timeout, error objects carrying `adoStatus`. All ADO traffic goes through it. |
| `public/index.html` | Work-Items (WIP) aging page. |
| `public/prs.html` | Pull-Request aging page. |
| `public/common.js` | Shared helpers: `esc`, `apiFetch`, `ageBand`, `setLoading`, `loadServerConfig`, pagination, avatar/date utils. |
| `public/styles.css` | Shared styling. |

Patterns worth reusing rather than reinventing:

- **`/api/pr-cycle-time` is a working precedent.** It already queries
  *completed* items over a time window, computes a distribution (avg, median),
  and the page renders a histogram client-side from the returned `items[]`.
  The forecasting feature follows the same shape for work items.
- **WIQL + `workitemsbatch`.** `/api/wip-aging` already runs a WIQL query for
  IDs, then batch-fetches fields in chunks of 200 with `errorPolicy: Omit`.
  Throughput and cycle-time reuse this two-step pattern exactly.
- **Input whitelisting.** `parseMax` clamps, `parseCycleDays` whitelists a
  fixed set of day values, `wiqlString` escapes quotes. New inputs follow suit.
- **Config-driven states.** WIP states are a configurable, comma-separated
  list. "Done states" must be configurable the same way.

Strengths to preserve: the PAT never reaches the browser; one guarded
`adoRequest()`; sanitized inputs; SRI-pinned CDN script; clean
error-to-message mapping. The forecast feature reuses all of it.

---

## 3. What "flow-metrics forecasting" means — mapping to ADO data

### 3.1 Throughput — the engine

Throughput is just a count: **how many work items reached a done state in each
time bucket.** To get it from Azure DevOps:

```
POST {ADO_ORG}/{project}/_apis/wit/wiql?api-version=7.1
{ "query":
  "SELECT [System.Id] FROM WorkItems
   WHERE [System.TeamProject] = '<project>'
     AND [System.WorkItemType] IN ('User Story','Bug')
     AND [System.State] IN ('Closed','Done','Resolved')
     AND [Microsoft.VSTS.Common.ClosedDate] >= @today - 84
   ORDER BY [Microsoft.VSTS.Common.ClosedDate] ASC" }
```

Then batch-fetch `Microsoft.VSTS.Common.ClosedDate` for those IDs via
`workitemsbatch` (same call `/api/wip-aging` already makes) and **bucket the
close dates by ISO week** (or by day). Each bucket's count is one throughput
sample. Twelve weeks of history → twelve samples.

| ADO field | Used for |
| --- | --- |
| `System.Id`, `System.Title`, `System.WorkItemType` | Identity / display / grain filtering |
| `Microsoft.VSTS.Common.ClosedDate` | The bucket key for **throughput** |
| `Microsoft.VSTS.Common.ActivatedDate` | Approx. **cycle-time start** (see 3.2) |
| `System.State` | Confirm the item is in a done state |

### 3.2 Cycle time — and the one important constraint

Cycle time = `ClosedDate − (date the item first entered an in-progress
state)`. **Azure DevOps has no single reliable "work started" field.** The
options:

- **`Microsoft.VSTS.Common.ActivatedDate`** — set the first time an item
  becomes Active/In-Progress. It rides along free in the `workitemsbatch`
  call. Good enough for a size sanity-check, but absent on imported/older
  items and not updated if an item bounces back and forth.
- **Work-item updates API** — `…/wit/workItems/{id}/updates` returns every
  field change with a timestamp, so the exact first transition into any
  configured in-progress state can be found. This is an **N+1 query pattern**
  (one call per completed item) — the same trade-off the PR plan faced with
  staleness, and it is handled the same way (Section 6).

The key point: **throughput is cheap** (one WIQL call + batch) and is all the
Monte Carlo forecast needs. **Cycle time is a secondary, slightly more
expensive signal** used only to check item-size similarity. The forecast does
not depend on solving the cycle-time-start problem perfectly.

### 3.3 What the forecast cannot get from data alone

Two things are assumptions, not measurements, and the UI must say so:

- **Item-size similarity** — the forecast assumes the 20 new tickets are
  roughly the same size as historical items. Data can *display* the cycle-time
  distribution so the user can judge this, but cannot verify it.
- **Stable delivery regime** — it assumes the team will keep delivering at its
  historical rate. An urgent crunch (context-switching, overtime, people
  pulled off other work) can change that.

---

## 4. Best practices that apply throughout

These hold regardless of which options are chosen:

- **Reuse, don't fork.** Route all new traffic through `adoRequest()`, reuse
  `wiqlString`/`parseMax`, and reuse the error-to-message mapping.
- **No new PAT scope.** Throughput and cycle time only read **Work Items**,
  which the PAT already has for `/api/wip-aging`. Unlike the PR feature, this
  extension needs *no* PAT change — call this out as a low-friction win. (The
  only exception is the optional Analytics data source, D3 in Section 6.)
- **Validate & whitelist new inputs.** Whitelist the history window
  (`days`) and `interval` (`day`|`week`); clamp the batch size (`items`) and
  trial count (`trials`); reject deadlines in the past.
- **Forecast at one grain.** Mixing Epics/Features with Stories/Bugs corrupts
  throughput. Default the throughput query to **`User Story` + `Bug`** and
  make the type set configurable. The *N* items being forecast must be counted
  at that same grain.
- **Configurable "done states".** Done states differ by process template
  (Agile `Closed`, Scrum `Done`, CMMI `Closed`, plus custom states). Expose a
  comma-separated list exactly like the WIP-states setting, with a sensible
  default.
- **Show ranges, never false precision.** Every forecast figure is reported
  with a confidence level (50 / 70 / 85 / 95%). No single-number answers.
- **Degrade gracefully.** Too little history → a clear "not enough completed
  items to forecast reliably" message, not a `NaN` or a confident-looking
  wrong number.
- **Don't regress.** `/api/wip-aging`, `/api/pr-aging`, `/api/pr-cycle-time`
  and both existing pages must be byte-for-byte unaffected.
- **Keep the no-secrets-in-page principle** and SRI-pin any new CDN asset
  (Chart.js is already pinned and can be reused as-is).

---

## 5. Solution options — Forecasting method

How do we turn historical throughput into an estimate? Four options:

### Option M1 — Throughput Monte Carlo (recommended)
Take the set of historical throughput samples (e.g. 12 weekly counts). To
answer **"how long for N items"**: repeatedly draw random samples from that set
and accumulate until the total reaches *N*, recording how many intervals it
took; run ~10,000 trials → a distribution of completion dates. To answer
**"how many by date D"**: fix the number of intervals between now and D, draw
that many samples per trial, record the total; 10,000 trials → a distribution
of item counts.

- **Pros:** Answers *both* questions from one model; needs no per-ticket
  estimation; output is an honest probability curve; uses the team's real
  variability rather than hiding it.
- **Cons:** Needs a meaningful history (ideally 8–12+ buckets); assumes future
  ≈ past.

### Option M2 — Cycle-time percentile + Little's Law
Use the 85th-percentile cycle time and planned WIP: with Little's Law
(`CycleTime ≈ WIP ÷ Throughput`), estimate batch duration.

- **Pros:** Simple; a useful independent cross-check of M1.
- **Cons:** Sensitive to the assumed WIP level; doesn't naturally produce
  "how many by date D"; weaker with a long-tailed cycle-time distribution.

### Option M3 — Velocity average
`N ÷ mean weekly throughput` → one number.

- **Pros:** Trivial; familiar; fine as a baseline label.
- **Cons:** Single-point answer hides all variability — the classic source of
  missed estimates. Not acceptable as the *primary* output.

### Option M4 — Per-item estimation assist
Help the user size each of the 20 tickets (story points / t-shirt).

- **Pros:** Granular.
- **Cons:** Not a flow metric; slow — the opposite of what's needed for 20
  urgent items; estimation accuracy is notoriously poor. Out of scope.

**Recommendation:** **M1** as the engine. Display **M3's mean** as a small
"naive baseline" label so users see how much M1's range differs from a flat
average. Offer **M2** as an optional cross-check panel. Skip **M4**.

---

## 6. Solution options — Historical-data source

All options below feed the same Monte Carlo. They differ in *how* throughput
and cycle-time history are obtained. This is the key trade-off, mirroring the
"staleness" decision in the PR plan.

### Option D1 — WIQL + `ClosedDate`, cycle-start via `ActivatedDate` (recommended)
One WIQL query for done items in the window, one `workitemsbatch` fetch for
`ClosedDate` + `ActivatedDate`. Bucket `ClosedDate` for throughput; use
`ClosedDate − ActivatedDate` for an approximate cycle time.

- **Pros:** Reuses the exact pattern `/api/wip-aging` already runs; no new PAT
  scope; throughput is exact; one round-trip class.
- **Cons:** Cycle time is approximate where `ActivatedDate` is missing.
- **Cost:** 1 WIQL + ⌈ids/200⌉ batch calls.

### Option D2 — D1 + work-item updates API for exact cycle-start
Add a `…/wit/workItems/{id}/updates` call per completed item to find the exact
first transition into an in-progress state.

- **Pros:** Accurate cycle time, including items with no `ActivatedDate`.
- **Cons:** N+1 calls — needs a concurrency limiter (6–8 in flight) and a
  short-TTL cache, exactly as the PR plan's S2 prescribed.
- **Cost:** D1 + N requests.

### Option D3 — Azure DevOps Analytics (OData)
Query the Analytics service (`analytics.dev.azure.com/{org}`), whose
`WorkItems` entity exposes `CycleTimeDays`, `LeadTimeDays` and `CompletedDate`
directly, with server-side aggregation.

- **Pros:** Cycle time and throughput pre-computed; less client math; scales
  to large projects.
- **Cons:** Different host/endpoint; **requires the Analytics PAT scope**
  (a real new-scope cost, unlike D1/D2); Analytics must be enabled for the
  org; a second data path to maintain.
- **Cost:** 1–2 OData requests.

**Recommendation:** Ship **D1** as the MVP — throughput is exact and that is
what the forecast needs, and there is no PAT change. Treat the cycle-time
column as "approximate" until **D2** is added behind a flag (same concurrency
limiter + TTL cache the PR plan already specified for S2). Keep **D3** as a
future option for teams on very large projects who already have Analytics on.

---

## 7. Solution options — Frontend & backend structure

### Frontend placement

- **F-A — New `public/forecast.html` page (recommended).** A third page linked
  from the top-bar nav, reusing `common.js` / `styles.css` / Chart.js. This is
  the **F2 pattern the PR plan already chose and shipped** (`prs.html`), so it
  is consistent and low-risk.
- **F-B — Tab inside an existing page.** Smaller nav, but crams a third
  unrelated data model into one script scope. Rejected for the same reasons
  the PR plan rejected F1.

### Where the simulation runs

- **X-A — Client-side over `/api/throughput` (recommended).** The server
  returns throughput buckets once; the page runs the 10,000-trial Monte Carlo
  in JavaScript. The user can drag the "items" and "deadline" inputs and see
  the forecast update instantly with no round-trip. This mirrors how
  `prs.html` builds the cycle-time histogram client-side from
  `/api/pr-cycle-time` data.
- **X-B — Server-side `/api/forecast`.** Consistent with the proxy model and
  easy to unit-test, but a round-trip on every input change.
- **X-C — Hybrid (recommended companion to X-A).** Client runs the interactive
  simulation; the server *also* exposes a `/api/forecast` reference
  implementation of the same algorithm so the math has one authoritative,
  unit-tested version. Phase 3, optional.

### Backend structure

- **B-A — Sibling routes in `server.js` (recommended now).** Add
  `/api/throughput` and `/api/wi-cycle-time` next to the existing routes.
  Routes currently still live in `server.js` (the PR plan's `routes/` split
  was not done), so a sibling route is the smallest diff and matches reality.
- **B-B — Extract `routes/` modules.** Cleaner long-term, but a broader
  refactor than this feature needs today.

Regardless of B-A vs B-B, **put the Monte Carlo math in a new
`lib/montecarlo.js`** — a pure, dependency-free module so it can be unit-tested
in isolation and shared by the client (bundled/copied) and an optional
server `/api/forecast`.

**Recommendation:** **F-A** + **X-A** (with **X-C** later) + **B-A**, with
`lib/montecarlo.js` for the algorithm.

---

## 8. Proposed API surface

Two new endpoints now, one optional later — all mirroring the existing
`{ items, total, … }` contract, sanitized fields, no secrets.

### `GET /api/throughput`
Query params: `days` (whitelisted, e.g. 28/56/84/180), `interval`
(`week` default | `day`), `states` (done-states, comma-separated, reuse the
`parseStates` validator), `types` (default `User Story,Bug`).

```jsonc
{
  "interval": "week",
  "buckets": [
    { "start": "2026-03-02", "end": "2026-03-08", "count": 6 },
    { "start": "2026-03-09", "end": "2026-03-15", "count": 4 }
    // … one per interval in the window
  ],
  "totalCompleted": 71,
  "perInterval": { "mean": 5.9, "min": 2, "max": 11 },
  "days": 84
}
```

### `GET /api/wi-cycle-time`
Query param: `days` (whitelisted). Work-item analogue of `/api/pr-cycle-time`,
adding percentiles.

```jsonc
{
  "items": [
    { "id": 4310, "type": "User Story", "cycleDays": 4.2, "closedDate": "2026-05-18T…" }
  ],
  "total": 71,
  "avgDays": 5.1, "p50": 4.0, "p85": 9.0, "p95": 14.0,
  "startField": "ActivatedDate",   // or "updates" once D2 ships
  "days": 84
}
```

### `GET /api/forecast` (optional — Phase 3, the X-C reference implementation)
Query params: `items` (clamped ≥ 1), `deadline` (ISO date, must be future),
`days`, `trials` (clamped, default 10000).

```jsonc
{
  "items": 20,
  "howLong": {
    "percentiles": {
      "p50": "2026-06-10", "p70": "2026-06-15",
      "p85": "2026-06-22", "p95": "2026-07-01"
    }
  },
  "howMany": {
    "deadline": "2026-06-15",
    "percentiles": { "p50": 18, "p70": 16, "p85": 13, "p95": 10 }
  },
  "naiveBaseline": { "weeks": 3.4, "method": "mean throughput" }
}
```

Work-item web link reuses the existing format `…/_workitems/edit/{id}`.

---

## 9. Proposed UI (`public/forecast.html`, Option F-A)

Reuses the WIP/PR layout vocabulary so all three pages feel like one product.

- **Inputs panel:** number of tickets to forecast (default **20**), start date
  (default today), target **deadline** (date picker — drives the "how many"
  mode), history window (last 8 / 12 / 26 weeks), interval (week / day).
- **Throughput chart:** bar chart of items completed per interval — the actual
  historical sample — with the mean drawn as a reference line.
- **"How long?" output:** a histogram/curve of simulated completion dates with
  50 / 70 / 85 / 95% markers, plus summary cards — *"50/50 by `<date>`"*,
  *"85% confident by `<date>`"*, *"95% safe by `<date>`"*. The 85% date is the
  one to commit externally.
- **"How many by `<deadline>`?" output:** a distribution of items completed by
  the deadline, plus a card — *"85% confident of finishing at least X of 20 by
  `<deadline>`"*. That **X is the recommended cut line**: rank the 20 by
  urgency / cost of delay, commit to the top X, treat the rest as explicit
  stretch.
- **Cycle-time panel:** histogram of historical work-item cycle time with
  p50/p85 marked — the **size sanity-check**. A long tail is flagged with a
  "consider slicing large items" hint.
- **Assumptions banner:** a persistent notice (like `prs.html`'s staleness
  notice) — *forecast assumes the 20 are sized like past items, that the team
  keeps WIP disciplined, and that history is representative.*
- **Settings:** done-states list, work-item types, trial count — stored under
  separate `localStorage` keys (`fc_*`) so they never collide with `wip_*` /
  `pr_*` settings.

---

## 10. Phased roadmap

| Phase | Deliverable | Notes |
| --- | --- | --- |
| **0. Prep** | Confirm the project's done-states and that `ClosedDate` / `ActivatedDate` are populated. Add a `forecast.html` nav link stub. | No PAT change needed — Work Items (Read) already covers it. |
| **1. Backend MVP** | `/api/throughput` + `/api/wi-cycle-time` (D1); `lib/montecarlo.js` with `forecastHowLong()` / `forecastHowMany()`. | Throughput exact; cycle time approximate (`ActivatedDate`). |
| **2. Frontend MVP** | `public/forecast.html`: inputs, throughput chart, both forecast modes, cycle-time sanity panel, assumptions banner. | First fully usable forecast — shippable on its own. |
| **3. Accuracy** | D2 (updates API + concurrency limiter + TTL cache) for exact cycle time; optional `/api/forecast` reference (X-C); outlier trimming; per-type throughput. | Upgrades cycle time from approximate to accurate. |
| **4. Polish** | Scope-growth modeling (the 20 may spawn more); save/share a forecast snapshot; D3 Analytics source; auto-refresh. | Nice-to-haves. |

Phases 1–2 are a complete, shippable increment; Phase 3 is the accuracy
upgrade; Phase 4 is optional.

---

## 11. Testing & verification strategy

- **Monte Carlo correctness:** feed a degenerate throughput set (always
  exactly 5/week) and assert the "how long for 20" result is deterministically
  4 intervals; feed a known distribution and assert percentiles converge as
  trials increase; use a seeded RNG so tests are reproducible.
- **Bucketing:** unit-test ISO-week assignment across week boundaries, items
  closed at midnight, and timezone edges; assert daily and weekly buckets sum
  to the same total.
- **Percentile math:** test p50/p85/p95 against fixed arrays, including
  even/odd lengths and single-element inputs.
- **Input validation:** `days` / `interval` / `items` / `deadline` / `trials`
  whitelisted or clamped; past deadline and `items < 1` rejected with a clear
  400.
- **Empty / low history:** zero completed items → friendly "not enough
  history" response, never `NaN`; fewer than ~6 buckets → forecast returned
  but flagged low-confidence.
- **Smoke test:** run against the real project; eyeball the throughput chart
  against Azure DevOps' built-in velocity widget for the same window.
- **Regression:** confirm `/api/wip-aging`, `/api/pr-aging`,
  `/api/pr-cycle-time` and both existing pages are unaffected.

---

## 12. Risks & open questions

- **Not enough completed history.** A new team/project may lack the ~8–12
  buckets Monte Carlo wants. Mitigation: warn explicitly, allow a wider
  window, fall back to M3's mean clearly labelled "rough".
- **Item-size mismatch.** The 20 urgent items may be larger or smaller than
  historical items, which silently biases the forecast. Mitigation: show the
  cycle-time distribution so the user can judge; recommend slicing long-tail
  items.
- **Throughput regime change.** The urgent crunch itself — context switching,
  overtime, people pulled off other work — can change the delivery rate, so
  past throughput may not predict the disrupted future. Mitigation: state this
  in the assumptions banner; allow the user to manually scale the sample.
- **WIP inflation.** Pulling all 20 into progress at once raises cycle time
  (Little's Law) and slows everything. Mitigation: the UI should surface a
  "limit WIP — feed items in by priority" reminder; the forecast assumes WIP
  discipline.
- **"Done state" definition.** Varies by process template and custom states;
  resolved-but-not-closed items are ambiguous. Mitigation: configurable
  done-states list with a sensible default.
- **`ActivatedDate` gaps.** Older/imported items may lack it, shrinking the
  cycle-time sample (throughput is unaffected). D2 resolves it.
- **Counting granularity.** Mixing Epics/Features with Stories/Bugs skews
  throughput. Decision: forecast at the Story/Bug grain by default — confirm
  the 20 tickets are counted at that grain.
- **Scope growth.** The 20 may spawn follow-on items; basic Monte Carlo
  assumes fixed scope. Phase 4 split-rate modeling addresses it.
- **Working days vs calendar days.** Weekly buckets already absorb weekends; a
  *daily* interval should skip non-working days or it will understate the
  rate.

---

## 13. Recommendation summary

| Decision | Recommended | Why |
| --- | --- | --- |
| Forecasting method | **M1** Throughput Monte Carlo (M3 mean shown as a baseline label) | No per-ticket estimation; answers both questions; honest probability range. |
| Historical-data source | **D1** WIQL + `ClosedDate`, cycle-start via `ActivatedDate` → **D2** behind a flag | Throughput exact and cheap; **no PAT change**; accuracy upgrade without a rewrite. |
| Simulation placement | **X-A** client-side over `/api/throughput` (+ optional **X-C** server reference) | Instant, interactive; mirrors the existing cycle-time chart pattern. |
| Frontend | **F-A** new `forecast.html` | Consistent with the `prs.html` precedent; each page stays small. |
| Backend | **B-A** sibling routes + `lib/montecarlo.js` | Smallest diff; simulation logic isolated and unit-testable. |

Net: two new read-only endpoints (`/api/throughput`, `/api/wi-cycle-time`), a
pure `lib/montecarlo.js`, and a new `forecast.html` sharing the existing CSS/JS
— delivering both forecast modes, requiring no PAT change, and leaving the WIP
and PR features untouched.

---

## 14. Applying this to the current 20-ticket batch

Once Phases 1–2 ship, the 20 urgent tickets are estimated like this — and
because *both* a delivery date and a scope cut matter here, both modes are
used:

1. **Confirm the grain.** Check the 20 are `User Story` / `Bug`-level items
   (not Epics). Items much larger than the cycle-time histogram's p85 should
   be sliced first.
2. **"How long?"** Open `forecast.html`, set items = 20, start = today. The
   **85%-confidence date** is what to commit externally — e.g. *"85% confident
   all 20 are done by `<date>`."* The p50 date is the optimistic case; the gap
   between p50 and p95 shows how much the team's variability is in play.
3. **"How many?"** Enter the hard deadline. The output — *"85% confident of
   finishing at least X of 20 by `<deadline>`"* — is the **cut line**. Rank
   the 20 by urgency / cost of delay, formally commit to the top **X**, and
   label the remainder as stretch rather than letting them slip silently.
4. **Protect the forecast.** Don't start all 20 at once — that inflates WIP and
   the forecast degrades in reality even though the model doesn't see it. Feed
   them in by priority and keep WIP at the team's normal level.

This gives a defensible answer to *both* "when will it be done" and "what fits
before the deadline" without sizing a single ticket by hand — exactly the
position to be in when 20 items go urgent at once.

> **If an answer is needed before the feature is built:** the same Monte Carlo
> math can be run as a one-off against an exported list of completed work items
> (their `ClosedDate`s) — that is a separate quick task, not part of this plan,
> and can be done on request.
