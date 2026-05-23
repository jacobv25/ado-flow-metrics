# Throughput Outlier Explanation — Extension Plan for the WIP Aging Tracker

**Status:** Proposal · **Date:** 2026-05-23 · **Scope:** Add outlier
*detection* and *attribution* to the existing throughput view, so a user can
see **why** individual weeks varied so much — not just **that** they did.

This document is a *plan only* — no code has been changed. It lays out how to
turn the throughput bar chart from a "here is the variance" display into a
"here is what caused the variance" tool, the Azure DevOps data involved,
several solution options at each design decision (with trade-offs), a
recommended path, and a phased roadmap.

The bucket-grain decision is already settled: **G1 — calendar weeks** (reuse
the existing ISO-week buckets; do not introduce a separate ADO-iteration
grain). Every other decision below follows recommended best practice.

---

## 1. Goal

The forecast page already renders weekly throughput as a bar chart with a mean
reference line and `min` / `max` summary cards. A user can *see* that one week
finished 11 items and another finished 2 — but the tool offers no way to
answer the obvious next question: **what made that week an outlier?**

We want the throughput view to also answer:

1. **Which weeks are outliers?** — flag the buckets that are statistically
   unusual, rather than leaving the user to eyeball the chart.
2. **What is an outlier week made of?** — break the bucket down by item type,
   size, contributors, and close-timing.
3. **Why did it vary?** — a plain-language explanation per outlier that
   separates a *genuine* capacity swing from a *measurement artifact* (a
   batch status update, an aged-WIP backlog flush, a grain leak).

Why this matters beyond curiosity: the Monte Carlo forecast on this same page
samples directly from these weekly counts. If half the week-to-week variance
is artifact rather than signal, the forecast's spread is misleadingly wide and
its percentiles are hard to trust. Explaining outliers helps the team *and*
makes the forecast defensible.

The feature surfaces three things: **outlier detection**, an **attribution
breakdown**, and a **one-line explanation** for each flagged week.

---

## 2. Current architecture (recap)

A deliberately small app — one Express proxy plus static pages:

| File | Role |
| --- | --- |
| `server.js` | Express proxy. Holds the PAT server-side, validates env, exposes `/api/config`, `/api/wip-aging`, `/api/pr-aging`, `/api/pr-cycle-time`, `/api/throughput`, `/api/wi-cycle-time`. Input helpers (`parseStates`, `parseHistoryDays`, `parseInterval`, `parseItemTypes`, `wiqlString`) sanitize every query. |
| `lib/adoClient.js` | The single `adoRequest()` HTTP helper — Basic-auth with the PAT, TLS options, timeout, error objects carrying `adoStatus`. All ADO traffic goes through it. |
| `lib/montecarlo.js` | Pure, dependency-free forecasting module (UMD). The model for how new shared math should be packaged. |
| `public/forecast.html` | Delivery-forecast page. Renders the throughput bar chart and runs the Monte Carlo client-side. |
| `public/index.html` / `public/prs.html` | Work-item and pull-request aging pages. |
| `public/common.js` / `public/styles.css` | Shared helpers and styling. |

What `/api/throughput` does today: it runs one WIQL query for done items in
the history window, then batch-fetches **only `System.Id` and
`Microsoft.VSTS.Common.ClosedDate`** via `workitemsbatch` (chunks of 200,
`errorPolicy: Omit`), buckets the close dates by ISO week, and returns:

```jsonc
{
  "interval": "week",
  "buckets": [ { "start": "2026-03-02", "end": "2026-03-08", "count": 6 } ],
  "totalCompleted": 71,
  "perInterval": { "mean": 5.9, "min": 2, "max": 11 },
  "days": 84
}
```

`forecast.html` reads `buckets[].count` for both the chart and the Monte Carlo
samples.

Patterns worth reusing rather than reinventing:

- **`workitemsbatch` already returns whatever fields you ask for.** `/api/wip-aging`
  fetches `System.AssignedTo`, `System.AreaPath`, `System.IterationPath` and
  `Microsoft.VSTS.Common.Priority` in exactly the same call shape. Enriching
  throughput is just a wider `fields` array — no new request pattern.
- **`/api/wi-cycle-time` already computes `cycleDays`** from
  `ClosedDate − ActivatedDate` per item. The aged-WIP detector below reuses
  that exact derivation.
- **Pure, testable math modules.** `lib/montecarlo.js` is a dependency-free
  UMD module, unit-tested in isolation and inlined into `forecast.html`. New
  outlier math follows the same packaging.
- **Input whitelisting.** `parseHistoryDays`, `parseInterval` and
  `parseItemTypes` whitelist or clamp every query parameter; `wiqlString`
  escapes quotes. Any new input does the same.

Strengths to preserve: the PAT never reaches the browser; one guarded
`adoRequest()`; sanitized inputs; SRI-pinned Chart.js; clean
error-to-message mapping. This feature reuses all of it and adds no new
dependency.

---

## 3. What "explaining an outlier" means — mapping to ADO data

A throughput bucket is just a **count of items whose `ClosedDate` fell inside
that week.** To explain a bucket we need the *attributes* of the items that
make it up — and every attribute below rides along free in the same
`workitemsbatch` call `/api/throughput` already issues.

| ADO field | Used to explain |
| --- | --- |
| `System.Id`, `System.Title` | Item identity / drill-down links |
| `System.WorkItemType` | Item-mix — a "huge" week is often just quick Bugs |
| `Microsoft.VSTS.Common.Priority` | Priority mix of what was closed |
| `Microsoft.VSTS.Common.ClosedDate` (full timestamp) | **Batch-close clustering** — many items closed at the same moment |
| `Microsoft.VSTS.Common.ActivatedDate` | Cycle time → **aged-WIP flush** detection |
| `System.AssignedTo` | Distinct-contributor count — a dip is often fewer people active |
| `System.AreaPath` | Which component/team the work came from |
| `Microsoft.VSTS.Scheduling.StoryPoints` (or `…Scheduling.Effort`) | Item size, **when the team estimates** |
| `System.IterationPath` | Sprint label, shown as context only — buckets stay weekly per G1 |

Two important consequences:

- **No new PAT scope.** Every field above is a Work Items (Read) field, which
  the PAT already has for `/api/wip-aging`. Like the forecasting feature, this
  extension needs *no* PAT change — a low-friction win worth calling out.
- **Throughput stays exact.** Enrichment only adds detail to each bucket; the
  `count` that drives the chart and the Monte Carlo is unchanged.

What the data **cannot** explain, and the UI must say so:

- **Public holidays / team PTO.** A dip during a holiday week looks identical
  to a capacity problem; there is no calendar data source.
- **Carry-over / slippage.** A low week next to a high week often means items
  *should* have closed in the first week and slipped — inferable as a hint,
  not provable.
- **Genuine focus, morale, interruptions.** Real but unmeasured.

---

## 4. Best practices that apply throughout

These hold regardless of which options are chosen:

- **Reuse, don't fork.** Route all traffic through `adoRequest()`, reuse
  `wiqlString` / `parseHistoryDays` / `parseItemTypes`, and reuse the
  error-to-message mapping.
- **No new PAT scope.** Attribution reads only Work Items fields the PAT
  already has.
- **Backward-compatible response.** The enriched `/api/throughput` must keep
  `count`, `perInterval` and `totalCompleted` byte-for-byte identical — the
  Monte Carlo on the same page reads `buckets[].count` and must not change.
  New detail is purely *additive*.
- **Robust statistics, not textbook ones.** Throughput is right-skewed and the
  sample is small (~12 weekly buckets). Use the **median and IQR**, never the
  mean and standard deviation, for outlier thresholds — the outliers
  themselves inflate σ and hide.
- **Forecast and explain at one grain.** Mixing Epics/Features with
  Stories/Bugs corrupts both the count and the breakdown. Keep the
  Story/Bug-level type filter; add a detector for any grain leak.
- **Degrade gracefully.** Too few buckets → detection disabled with a clear
  "not enough history to flag outliers" note, never a crash or a `NaN`.
  `StoryPoints` mostly empty → size breakdown falls back to cycle time, with a
  label saying so.
- **Heuristics are labelled as heuristics.** An "artifact" verdict is a
  *likely* explanation, not a fact. Phrasing and the item list let the user
  judge.
- **Don't regress.** `/api/wip-aging`, `/api/pr-aging`, `/api/pr-cycle-time`,
  `/api/wi-cycle-time` and all three existing pages must be unaffected.
- **Keep the no-secrets-in-page principle** and reuse the already-pinned
  Chart.js — no new CDN asset.

---

## 5. Solution options — Outlier detection method

How do we decide a weekly bucket is an outlier?

### Option O1 — Tukey IQR fence (recommended)
Compute Q1, Q3 and IQR over the bucket counts; flag any bucket below
`Q1 − 1.5·IQR` or above `Q3 + 1.5·IQR`.

- **Pros:** Robust to skew and to the outliers themselves (extreme weeks don't
  drag the threshold); no distribution assumption; the standard approach in
  flow tooling. The fence renders naturally as a shaded band on the chart.
- **Cons:** With ~12 buckets the quartiles are coarse; on a tight sample it may
  flag nothing — which is itself an honest answer.

### Option O2 — Mean ± k·σ
- **Pros:** Familiar to most users.
- **Cons:** Throughput is right-skewed and the outlier weeks inflate σ,
  masking themselves. Statistically the wrong tool here. Rejected.

### Option O3 — MAD (median absolute deviation)
A modified z-score built from the median and MAD.

- **Pros:** Even more robust than IQR; behaves well on very small samples.
- **Cons:** "Modified z-score" is less intuitive to explain in the UI.

### Option O4 — Percentile / top-N
Unconditionally flag the highest and lowest *N* buckets.

- **Pros:** Always returns something to inspect.
- **Cons:** Flags buckets that may not be unusual at all; *N* is arbitrary.

**Recommendation:** **O1 (Tukey IQR fence)** as the primary detector — the
recommended best practice for skewed, small-sample flow data. Use **O3 (MAD)**
as a documented fallback when there are too few buckets for stable quartiles.
Independently of flagging, let the user click **any** bar to drill in
(O4-style manual inspection is always available). Draw the fence as a shaded
band on the throughput chart so the threshold is visible, not hidden in code.

---

## 6. Solution options — Attribution dimensions

Once a bucket is flagged, what do we break it down by? Recommended best
practice is to **compute all of the dimensions below** and let the explanation
engine pick the most salient one(s) per bucket. They fall into two tiers.

**Tier 1 — artifact detectors** (separate a *real* swing from *noise*):

- **C1 — Batch-close clustering.** Cluster the full `ClosedDate` timestamps; if
  a large share of the bucket closed within the same hour or day, that is a
  bulk status update or end-of-sprint dump, not real flow.
- **C2 — Aged-WIP flush.** Compare the bucket items' cycle time
  (`ClosedDate − ActivatedDate`) against the overall median. A high-count week
  built from long-aged items is a backlog cleanup, not fast delivery.
- **C3 — Grain leakage.** Count any `Epic` / `Feature` that slipped past the
  type filter — each inflates the bucket by a non-comparable "1".

**Tier 2 — composition breakdowns** (explain a *genuine* swing):

- **C4 — Work-item-type mix.** Bug vs. Story share for the bucket vs. the
  team's baseline mix across all buckets.
- **C5 — Size mix.** `StoryPoints` / `Effort` distribution where populated;
  otherwise the cycle-time distribution as a size proxy.
- **C6 — Contributor / area mix.** Distinct `AssignedTo` count and `AreaPath`
  spread — a dip is frequently just fewer people active that week.

**Recommendation:** compute all six. **Lead the explanation with Tier 1**,
because "this spike isn't real throughput" is the single most valuable finding
for someone trying to trust their numbers; fall back to Tier 2 to characterise
a swing that *is* real.

---

## 7. Solution options — Historical-data plumbing

All options feed the same detection + breakdown logic. They differ in *how*
the per-item attributes reach the client.

### Option A1 — Enrich `/api/throughput` (recommended)
Widen the `workitemsbatch` `fields` array and attach an `items[]` array to
each bucket in the response. `count`, `perInterval` and `totalCompleted` stay
exactly as they are.

- **Pros:** One round trip; the client has everything for detection, every
  breakdown, and the drill-down item list; matches the existing fetch pattern;
  fully backward compatible.
- **Cons:** Larger payload — proportional to the number of items completed in
  the window (typically tens to low hundreds for a normal team). Note that
  `/api/throughput` sets no `$top` on its WIQL today, so the enriched route
  should add a sensible `$top` clamp as a safety measure.
- **Cost:** Identical call count to today (1 WIQL + ⌈ids/200⌉ batch calls).

### Option A2 — Lazy `/api/throughput-detail?week=…`
Fetch per-bucket detail only when the user drills into a week.

- **Pros:** Smaller initial payload.
- **Cons:** Detection itself needs per-item data up front, so this would
  fetch most items twice; a second endpoint to build and maintain. Rejected.

### Option A3 — Client-side join with `/api/wi-cycle-time`
`forecast.html` already fetches `/api/wi-cycle-time`, which returns per-item
`type`, `cycleDays` and `closedDate`. Correlate it client-side.

- **Pros:** Zero new server work.
- **Cons:** That endpoint omits `priority`, `assignedTo` and `area`, and
  **drops every item with no `ActivatedDate`** — so attribution would be
  partial and silently biased. Rejected as the primary path.

**Recommendation:** **A1.** A bounded payload, one call, every dimension
available, and a strictly additive response shape.

---

## 8. Solution options — Where the analysis runs

- **X-A — Client-side over the enriched data (recommended).** The server
  returns enriched buckets once; the page computes the IQR fence, the
  per-bucket breakdowns and the narrative in JavaScript. This mirrors how the
  Monte Carlo and the cycle-time histogram already work — instant, no extra
  round trip, and the user can change the outlier-sensitivity setting and see
  flags update immediately.
- **X-B — Server-side `/api/throughput-insights`.** Consistent with the proxy
  model, but a round trip on every sensitivity change and a larger API
  surface. Not needed now.

Regardless of placement, **put the detection + breakdown + narrative math in a
new pure `lib/outliers.js`** — a dependency-free UMD module, unit-tested in
isolation, and inlined into `forecast.html` exactly as `lib/montecarlo.js` is
today. (An optional server reference path can be added later, as the
forecasting plan's X-C does.)

**Recommendation:** **X-A** with `lib/outliers.js` for the algorithm.

---

## 9. Solution options — UI surface & explanation style

### UI surface (recommended combination)

- **Flag outliers on the existing throughput chart.** Recolour outlier bars
  and shade the IQR fence as a band, so the chart the user already looks at
  answers "which weeks" at a glance.
- **Click any bar → an inline drill-down panel** expands beneath the chart
  with that week's breakdown charts and item list.
- **An "Outlier Insights" panel** auto-lists every flagged week with its
  one-line explanation, so the user never has to hunt bar by bar.

### Explanation style (recommended combination)

- **A rule-based narrative headline per outlier**, generated by deterministic
  heuristics in `lib/outliers.js` — e.g. *"Week of Apr 6: 14 items, 2.3× the
  median. 9 of them closed on Apr 10 — likely a batch status update."* No LLM:
  keeps it offline, instant, and unit-testable.
- **A side-by-side comparison vs. the median bucket**, so "unusual" is shown
  relative to a concrete normal week.
- **The raw breakdown charts** beneath, for users who want to judge for
  themselves.

---

## 10. Proposed API surface

### `GET /api/throughput` — enriched (additive, backward compatible)

Same query params as today (`days`, `interval`, `states`, `types`). Each
bucket gains an `items[]` array. Optionally accept `detail=0` to skip
enrichment and return the lean legacy payload for any other consumer.

```jsonc
{
  "interval": "week",
  "buckets": [
    {
      "start": "2026-03-02", "end": "2026-03-08", "count": 6,
      "items": [
        {
          "id": 4310,
          "title": "Fix login redirect loop",
          "type": "User Story",
          "priority": 2,
          "assignedTo": "Dana Lee",
          "area": "Web\\Auth",
          "iteration": "Web\\Sprint 24",
          "closedDate": "2026-03-05T14:22:00Z",
          "activatedDate": "2026-03-01T09:00:00Z",
          "cycleDays": 4.2,
          "storyPoints": 3
        }
        // … one per item closed in this bucket
      ]
    }
  ],
  "totalCompleted": 71,
  "perInterval": { "mean": 5.9, "min": 2, "max": 11 },
  "days": 84
}
```

Implementation notes: widen the `workitemsbatch` `fields` list to
`System.Id`, `System.Title`, `System.WorkItemType`,
`Microsoft.VSTS.Common.Priority`, `System.AssignedTo`, `System.AreaPath`,
`System.IterationPath`, `Microsoft.VSTS.Common.ActivatedDate`,
`Microsoft.VSTS.Common.ClosedDate`, `Microsoft.VSTS.Scheduling.StoryPoints`;
keep `errorPolicy: 'Omit'`. Every field is null-safe — `storyPoints` and
`activatedDate` are commonly absent and must not throw. `cycleDays` is `null`
when `activatedDate` is missing.

Detection itself stays **off the server** (Option X-A) — the response carries
data, not verdicts.

### Work-item links

Drill-down rows link to `{ADO_ORG}/{project}/_workitems/edit/{id}`, the same
format the other pages use.

---

## 11. Proposed module — `lib/outliers.js`

A pure, dependency-free UMD module, packaged like `lib/montecarlo.js` and
inlined into `forecast.html`.

```
detectOutliers(counts)
  → { median, q1, q3, iqr, lowerFence, upperFence, method, flags[] }
  flags[i] = 'high' | 'low' | null   (per bucket)
  method   = 'iqr'  | 'mad'          ('mad' fallback on small samples)

summarizeBucket(bucket, baseline)
  → { typeMix, sizeMix, contributorCount, areaMix,
      batchClusters, agedWipRatio, grainLeakCount }
  baseline = the same stats aggregated across all buckets, for comparison

explainOutlier(bucket, summary, baseline)
  → { headline, reasons[] }
  headline = a deterministic one-line narrative string
  reasons  = structured { code, detail } items, ordered Tier 1 → Tier 2
```

Each function is pure and deterministic, so it is unit-tested against fixed
arrays and synthetic buckets with no network or RNG.

---

## 12. Proposed UI (`public/forecast.html`)

All additions live on the existing forecast page — no new page, reusing
`common.js`, `styles.css` and the pinned Chart.js.

- **Throughput chart:** outlier bars recoloured (high vs. low), the IQR fence
  drawn as a shaded band, every bar clickable.
- **"Outlier Insights" panel** (new, below the throughput chart): one card per
  flagged week — week label, count, "×N the median", the one-line cause, and a
  "view detail" link. Empty state when nothing is flagged: *"No outlier weeks —
  throughput is within the normal range."*
- **Drill-down panel** (inline, expands on bar click): a side-by-side
  comparison against the median week; small breakdown charts (type mix, size /
  cycle-time, contributors); and the item table with ADO links.
- **Settings:** one new control — outlier sensitivity (`Standard` 1.5× IQR /
  `Strict` 1.0× / `Loose` 3.0×), stored under an `fc_` `localStorage` key so it
  never collides with `wip_*` / `pr_*` settings.
- **Limitations note:** a short line near the Insights panel — detection
  cannot see holidays or PTO, and "artifact" labels are heuristic.

---

## 13. Phased roadmap

| Phase | Deliverable | Notes |
| --- | --- | --- |
| **0. Prep** | Confirm `ActivatedDate` and `StoryPoints` population on the project; confirm done-states. | No PAT change — Work Items (Read) already covers it. |
| **1. Backend** | Enrich `/api/throughput` with `items[]`; widen the `workitemsbatch` field list; assert `count` / `perInterval` unchanged. | Strictly additive response. |
| **2. Core module** | `lib/outliers.js` — `detectOutliers`, `summarizeBucket`, `explainOutlier`; full unit tests. | Pure, dependency-free. |
| **3. Frontend** | Outlier flagging + IQR band on the throughput chart; "Outlier Insights" panel; click-to-drill panel; sensitivity setting. | First fully usable increment. |
| **4. Polish** | Median-week comparison view; carry-over hint (low week beside a high week); optional server reference path; per-type baselines. | Nice-to-haves. |

Phases 1–3 are a complete, shippable increment; Phase 4 is optional.

---

## 14. Testing & verification strategy

- **`detectOutliers`:** fixed arrays with hand-computed Q1/Q3/fences; an
  all-equal array (no outliers); a known spike is flagged `high` and a known
  trough `low`; a tiny sample triggers the `mad` fallback.
- **`summarizeBucket`:** synthetic `ClosedDate` timestamps assert batch-close
  clustering; crafted cycle times assert the aged-WIP ratio; injected
  `Epic`/`Feature` items assert the grain-leak count.
- **`explainOutlier`:** each heuristic rule fires on a bucket built to trigger
  exactly it; the narrative string is deterministic across runs.
- **Backward compatibility:** the enriched `/api/throughput` drives the Monte
  Carlo identically — same `buckets[].count`, same forecast percentiles;
  assert `perInterval` and `totalCompleted` are unchanged.
- **Input validation:** the new sensitivity setting is whitelisted; the
  `detail=0` opt-out returns the legacy shape.
- **Empty / low history:** zero completed items → friendly message, never
  `NaN`; fewer than ~6 buckets → detection disabled with a clear note.
- **Regression:** `/api/wip-aging`, `/api/pr-aging`, `/api/pr-cycle-time`,
  `/api/wi-cycle-time` and all three pages unaffected.
- **Smoke test:** run against the real project; eyeball the flagged weeks and
  their explanations against the raw item lists.

---

## 15. Risks & open questions

- **Small sample.** ~12 weekly buckets is thin for stable quartiles.
  Mitigation: MAD fallback plus a "low confidence" note; allow a wider history
  window.
- **`StoryPoints` sparsity.** If the team does not estimate, the size
  breakdown falls back to cycle time — already handled, but cycle time
  conflates item size with queue/wait time.
- **"Artifact" is a heuristic.** A same-day cluster of closes can be genuine.
  Mitigation: label verdicts "likely", always show the underlying item list.
- **Holidays / PTO are invisible.** A holiday-week dip looks like a capacity
  problem. Mitigation: state the limitation in the UI; a future optional
  team-calendar input could resolve it.
- **Carry-over ambiguity.** A low week beside a high week often means
  slippage, but the data cannot prove it. Mitigation: phrase it as a hint, not
  a verdict.
- **Grain leakage depends on the type filter.** The grain-leak detector is a
  safety net that *surfaces* the problem; fixing it is a config change to the
  types setting.
- **Payload growth.** Proportional to the items completed in the history
  window — modest for a normal team, but unbounded in principle, since
  `/api/throughput` sets no `$top` on its WIQL today (unlike `/api/wip-aging`
  and `/api/pr-cycle-time`). Mitigation: add a `$top` clamp to the enriched
  route, and keep the `detail=0` opt-out for a lean payload.

---

## 16. Recommendation summary

| Decision | Recommended | Why |
| --- | --- | --- |
| Bucket grain | **G1** calendar weeks (already chosen) | Reuses existing ISO-week buckets; no new endpoint or interval type. |
| Outlier detection | **O1** Tukey IQR fence, **O3** MAD fallback for small samples | Robust to skew and to the outliers themselves; standard for flow data. |
| Attribution | **All six dimensions**, Tier-1 artifact detectors lead | "This spike isn't real" is the highest-value finding. |
| Data plumbing | **A1** enrich `/api/throughput` (additive) | One call, every dimension, backward compatible. |
| Analysis location | **X-A** client-side, pure `lib/outliers.js` | Instant, interactive; mirrors the Monte Carlo pattern; unit-testable math. |
| UI surface | Chart flagging + IQR band + "Outlier Insights" list + click-to-drill panel | Answers "which / why / show me" in one page. |
| Explanation style | Deterministic rule-based narrative + median-week comparison + breakdown charts | Offline, instant, testable; user can still judge for themselves. |

Net: one enriched endpoint (strictly additive), one new pure
`lib/outliers.js`, and additions to `forecast.html` sharing the existing
CSS/JS — turning the throughput chart into a tool that explains its own
variance, requiring no PAT change and leaving the WIP, PR and forecast
features untouched.
