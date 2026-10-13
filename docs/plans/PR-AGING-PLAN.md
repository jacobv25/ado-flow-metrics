# PR Aging — Extension Plan for the WIP Aging Tracker

**Status:** Proposal · **Date:** 2026-05-22 · **Scope:** Add Pull Request aging
alongside the existing Work-Item (WIP) aging view.

This document is a *plan only* — no code has been changed. It lays out what PR
aging means, the Azure DevOps APIs involved, several solution options at each
design decision (with trade-offs), a recommended path, and a phased roadmap.

---

## 1. Goal

The app today answers one question: *"Which work items have been sitting in a
WIP state too long?"* We want it to also answer the parallel question for code
review: *"Which pull requests have been open / stale / waiting on a reviewer
too long, and how long are PRs taking to merge?"*

Per the agreed scope, the PR view should surface four signals:

1. **Age of open PRs** — days since the PR was created.
2. **Staleness** — days since the last activity (push or comment).
3. **Review wait time** — how long a PR has sat with reviewers but no decision.
4. **Time to merge** — cycle time of recently completed PRs (trend metric).

---

## 2. Current architecture (recap)

A deliberately small two-file app:

| File | Role |
| --- | --- |
| `server.js` | Express proxy. Holds the PAT server-side, validates env, exposes `/api/config` and `/api/wip-aging`. All ADO traffic goes through one helper, `adoRequest()`. |
| `public/index.html` | Single-file frontend: Chart.js (SRI-pinned), summary cards, an aging-distribution chart, type/search/sort filters, and a paginated table. Aging "bands" (green/yellow/orange/red) are derived from configurable day thresholds stored in `localStorage`. |

Strengths to preserve: the PAT never reaches the browser; one well-guarded
`adoRequest()` helper; input sanitization (`parseStates`, `parseMax`); SRI on
the CDN script; clean error-to-message mapping. The PR feature should reuse all
of this rather than fork it.

---

## 3. What "PR aging" means — mapping each metric to ADO data

Azure DevOps exposes pull requests through the Git REST API. The project-wide
list endpoint is:

```
GET {ADO_ORG}/{project}/_apis/git/pullrequests?searchCriteria.status=active&api-version=7.1
```

It returns `GitPullRequest` objects across **all repos** in the project. The
fields that matter to us:

| Field | Used for |
| --- | --- |
| `pullRequestId`, `title`, `repository.{id,name}` | Identity / display / building the web link |
| `createdBy`, `creationDate` | Author + **Age of open PRs** |
| `closedDate`, `status` | **Time to merge** (completed PRs) |
| `isDraft` | Exclude / flag draft (WIP) PRs |
| `mergeStatus` | Flag PRs blocked on merge conflicts |
| `reviewers[]` (`vote`, `isRequired`, `hasDeclined`) | **Review wait time** / review state |
| `sourceRefName`, `targetRefName` | Branch context |
| `labels`, `workItemRefs` | Optional extra context |

Reviewer `vote` values are a fixed enum: **10** approved · **5** approved with
suggestions · **0** no vote · **-5** waiting for author · **-10** rejected.

### 3.1 The one important constraint

`GitPullRequest` has **no "last updated / changed date"** field — only
`creationDate` and `closedDate`. Metrics 1 and 4 are therefore free (one list
call), but **metrics 2 and 3 (staleness, review wait) need extra per-PR
calls**, because "last activity" lives in:

- **Iterations** — `…/repositories/{repoId}/pullRequests/{prId}/iterations` —
  the latest iteration's date ≈ the last push to the source branch.
- **Threads** — `…/repositories/{repoId}/pullRequests/{prId}/threads` — comment
  `publishedDate` / `lastUpdatedDate` ≈ last review conversation; thread
  `status` also yields an "unresolved comments" count.

`last activity = max(latest iteration date, latest comment date)`. This is an
N+1 query pattern and is the single biggest design decision below (Section 6).

---

## 4. Best practices that apply throughout

These hold regardless of which options are chosen:

- **Reuse, don't fork.** Route all new traffic through the existing
  `adoRequest()` helper and the existing error-to-message mapping.
- **PAT scope.** The current app only needs *Work Items (Read)*. PRs need the
  PAT to also carry **Code (Read)**. Document this in `.env.example` / README
  and surface a clear message on the 401/403 path.
- **Validate & whitelist new inputs.** `status` must be checked against a fixed
  set (`active`, `completed`, `abandoned`, `all`); reuse the `parseMax()`
  clamp; whitelist `days` for cycle-time queries.
- **Paginate.** The PR list endpoint uses `$top` / `$skip`; loop until a short
  page is returned or `max` is reached. Never assume one page.
- **Bound the N+1.** When fetching staleness, use a concurrency limiter
  (e.g. 6–8 in flight) to respect ADO rate limits, plus a short-TTL in-memory
  cache so a Refresh click doesn't re-fetch everything.
- **Degrade gracefully.** If the staleness calls fail or time out, fall back to
  age-based numbers and tell the user the staleness column is approximate.
- **Separate, configurable thresholds.** PRs should move faster than work
  items — don't reuse 3/7/14. Add independent PR thresholds (suggested default
  **1 / 3 / 7** days).
- **Keep the no-secrets-in-page principle** and SRI-pin any new CDN asset.
- **Don't regress WIP.** `/api/wip-aging` and its UI must keep working
  untouched.

---

## 5. Solution options — Frontend integration

How should the PR view live next to the WIP view? Four options:

### Option F1 — Tabbed single page (fastest)
Add a "Work Items / Pull Requests" tab switcher to `index.html`; both views
share one file, one top bar, one settings panel.

- **Pros:** No new files; shared CSS/Chart.js for free; one URL.
- **Cons:** `index.html` is already ~950 lines — this pushes it past ~1,600;
  two unrelated data models in one script scope.

### Option F2 — Separate page + shared assets (recommended)
Add `public/prs.html` as a second page, linked from the top bar. Extract the
shared CSS into `public/styles.css` and shared helpers (fetch wrapper, age
bands, avatar/escape utils) into `public/common.js`, consumed by both pages.

- **Pros:** Each page stays small and focused; the shared-asset extraction is a
  modest, low-risk refactor that also tidies the existing page; clean mental
  model ("one page per dataset").
- **Cons:** Slightly more files; a one-time refactor of `index.html` to consume
  the shared assets.

### Option F3 — Unified combined dashboard
A single page showing WIP and PR cards/charts together.

- **Pros:** One glance at everything.
- **Cons:** Two very different data shapes crammed together; cluttered; filters
  and sort become ambiguous. Not recommended.

### Option F4 — Refactor to a small SPA
Extract a shared shell and render views client-side (hash routing or a tiny
component split).

- **Pros:** Most maintainable if many more views are coming.
- **Cons:** Biggest upfront cost; over-engineered for a 2-view internal tool
  today. A good *future* direction, not a *now* one.

**Recommendation:** **F2.** It keeps the single-file-per-view simplicity the
project already favours, makes each file maintainable, and the shared-asset
step pays for itself immediately. Choose **F1** only if this is positively the
last view you'll ever add and you want zero new files.

---

## 6. Solution options — Staleness & review-wait data source

This is the key trade-off (see Section 3.1). All three options compute Age and
Time-to-merge identically; they differ in how "last activity" is obtained.

### Option S1 — Approximate (no extra calls)
Treat staleness as equal to PR age, and review-wait as PR age when no vote is
recorded.

- **Pros:** One list call; instant; zero rate-limit risk.
- **Cons:** Wrong whenever a PR is actively being pushed to — an old-but-busy
  PR looks "stale". Honest only if labelled "approximate".
- **Cost:** 1 request total.

### Option S2 — Iterations only (recommended)
One `…/iterations` call per active PR; last iteration date = last push. This
same call also feeds review-wait (time since the last push that reviewers
would need to re-review).

- **Pros:** Accurate "last code activity"; one extra call per PR; the call does
  double duty for staleness *and* review-wait.
- **Cons:** N extra calls — must be concurrency-limited and cached.
- **Cost:** 1 + N requests (N = open PR count, typically tens).

### Option S3 — Iterations + threads (most accurate)
Add a `…/threads` call so a comment with no new push still counts as activity,
and so unresolved-comment counts can be shown.

- **Pros:** True "last activity"; richest review-wait signal.
- **Cons:** 2N extra calls; most rate-limit exposure and latency.
- **Cost:** 1 + 2N requests.

**Recommendation:** Ship **S1** as the MVP (fast, correct for Age and
Time-to-merge, "approximate" label on staleness), then upgrade the staleness
mode to **S2** behind a query flag (`staleness=iterations`) with a concurrency
limiter and a 60–120s TTL cache. Treat **S3** as opt-in for teams that want
unresolved-comment counts. A `staleness` query param lets all three coexist.

---

## 7. Solution options — Backend structure

### Option B1 — Sibling route in `server.js`
Add `/api/pr-aging` directly next to `/api/wip-aging` in the existing file.

- **Pros:** Smallest diff; matches today's style.
- **Cons:** `server.js` grows; WIP and PR logic intermingle.

### Option B2 — Light module split (recommended)
Extract `lib/adoClient.js` (the `adoRequest` helper + agent), `routes/wip.js`,
and `routes/prs.js`; `server.js` becomes wiring + validation only.

- **Pros:** Each concern is testable in isolation; adding the PR routes doesn't
  touch WIP code; natural home for the concurrency limiter and cache.
- **Cons:** A handful of new files; small refactor of existing code.

### Option B3 — Add a caching/aggregation service layer
On top of B2, a `lib/cache.js` TTL cache and a `lib/prAging.js` service that
orchestrates list → iterations → assembly.

- **Pros:** Cleanest separation; the N+1 orchestration is isolated and unit-
  testable.
- **Cons:** More structure than a tool this size strictly needs *today*.

**Recommendation:** **B2**, and pull the cache + limiter into a single small
`lib/` helper (a lightweight slice of B3) since S2 needs them anyway.

---

## 8. Proposed API surface

Two new endpoints, mirroring the existing `/api/wip-aging` contract
(`{ items, total }`, sanitized fields, no secrets):

### `GET /api/pr-aging`
Query params: `status` (default `active`, whitelisted), `max` (clamped, reuse
`parseMax`), `staleness` (`off` | `iterations` | `full`, default `off`).

```jsonc
{
  "items": [
    {
      "id": 1421,
      "title": "Add retry to ADO client",
      "repo": "payments-api",
      "status": "active",
      "isDraft": false,
      "createdBy": "Dana Lee",
      "creationDate": "2026-05-09T10:22:00Z",
      "ageDays": 13,
      "lastActivityOn": "2026-05-18T16:00:00Z",  // null when staleness=off
      "staleDays": 4,                            // null when staleness=off
      "reviewState": "awaiting",  // awaiting | changes | approved | rejected | none | draft
      "reviewWaitDays": 13,
      "hasMergeConflict": false,
      "reviewers": [{ "name": "Sam Ortiz", "vote": 0, "isRequired": true }],
      "sourceRef": "feature/retry",
      "targetRef": "main",
      "url": "https://dev.azure.com/org/proj/_git/payments-api/pullrequest/1421"
    }
  ],
  "total": 1
}
```

`reviewState` is derived from `reviewers[].vote` with **no extra call**: any
`-10` → `rejected`; any `-5` → `changes`; all required reviewers `>= 5` →
`approved`; reviewers present but all `0` → `awaiting`; none → `none`;
`isDraft` → `draft`. `staleDays` / `lastActivityOn` are populated only when
`staleness` ≠ `off`.

### `GET /api/pr-cycle-time`
Query param: `days` (whitelisted, e.g. 7/14/30/90). Queries **completed** PRs
with `searchCriteria.queryTimeRangeType=closed` + `minTime`.

```jsonc
{
  "items": [{ "id": 1390, "title": "...", "repo": "...", "mergeDays": 2.4 }],
  "avgDays": 3.1, "medianDays": 2.0, "count": 27
}
```

PR web link format: `{ADO_ORG}/{project}/_git/{repo}/pullrequest/{id}` (note
this differs from the work-item link `…/_workitems/edit/{id}`).

---

## 9. Proposed UI (under Option F2)

`public/prs.html` reuses the WIP layout vocabulary so the two pages feel like
one product:

- **Summary cards:** Open PRs · Avg Age · Stale (no activity > threshold) ·
  Awaiting Review · Avg Time-to-Merge.
- **Charts:** PR aging-distribution bar chart (reusing the band logic); a
  small Time-to-Merge trend or histogram fed by `/api/pr-cycle-time`.
- **Filters:** by repository, by review state, by status (active/draft),
  search, and sort (most-aged / stalest / longest-waiting first).
- **Table columns:** ID (links to ADO) · Repo · Title · Author · Age ·
  Last Activity / Stale · Review State · Reviewers · Target branch.
- **Settings:** PR-specific day thresholds (default 1/3/7), max items, and the
  staleness mode — stored under separate `localStorage` keys (`pr_thresholds`,
  `pr_staleness`, …) so they don't collide with WIP settings.
- **Conflict flag:** PRs with `mergeStatus === "conflicts"` get a visible badge
  — a real, actionable reason a PR is aging.

---

## 10. Phased roadmap

| Phase | Deliverable | Notes |
| --- | --- | --- |
| **0. Prep** | Add *Code (Read)* to the PAT; update `.env.example` / README. | Unblocks everything; no code risk. |
| **1. Backend MVP** | `lib/adoClient.js` extracted (B2); `/api/pr-aging` with `staleness=off` (S1) + `/api/pr-cycle-time`. | Age, review-state, time-to-merge all correct. |
| **2. Frontend MVP** | Extract `styles.css` + `common.js`; build `public/prs.html`; add nav link. | Delivers a usable PR view. |
| **3. Real staleness** | `staleness=iterations` (S2) + concurrency limiter + TTL cache. | Upgrades the staleness/review-wait columns from approximate to accurate. |
| **4. Polish (optional)** | `staleness=full` (S3, unresolved comments); cycle-time trend chart; auto-refresh. | Nice-to-haves. |

Phases 1–2 are a shippable increment on their own; Phase 3 is the quality
upgrade; Phase 4 is optional.

---

## 11. Testing & verification strategy

- **Input validation:** unit-test `status` / `days` whitelisting and the `max`
  clamp (bad/oversized/empty values).
- **Metric math:** unit-test age, staleness, and `mergeDays` against fixed
  fixture dates (including missing-date and same-day edge cases).
- **`reviewState` derivation:** table-driven test over every vote combination
  (rejected beats changes beats approved; draft; no reviewers).
- **Pagination loop:** mock a multi-page list response and assert all pages are
  collected and `max` is honoured.
- **Concurrency/cache (Phase 3):** assert no more than the limit are in flight
  and that a second call within the TTL hits the cache.
- **Smoke test:** run against a real project; spot-check 3–5 PRs' Age and
  Last-Activity against the ADO web UI.
- **Regression:** confirm `/api/wip-aging` and the WIP page are byte-for-byte
  unaffected (especially after the shared-asset extraction).

---

## 12. Risks & open questions

- **Rate limits.** A project with hundreds of open PRs makes S2/S3 expensive.
  Mitigation: cap with `max`, concurrency-limit, cache; consider only computing
  staleness for the rows currently on screen (lazy hybrid).
- **PAT scope rollout.** Existing users must regenerate/extend their PAT before
  the PR page works — call this out prominently.
- **Reviewer roll-ups.** Teams/groups appear as reviewers (`isContainer`);
  decide whether to count group votes or only individuals when deriving
  `reviewState`.
- **Abandoned PRs.** Decide whether to show them at all, or only as a count.
- **On-prem TFS.** The app supports TFS URLs; the Git PR API exists there too,
  but `api-version` and exact paths should be smoke-tested on a TFS instance if
  any users are on-prem.
- **"Review wait" precision.** Even S2 approximates — a true "time since
  reviewers were assigned" needs thread history (S3). Confirm the S2
  approximation is good enough before investing in S3.

---

## 13. Recommendation summary

| Decision | Recommended | Why |
| --- | --- | --- |
| Frontend integration | **F2** — separate `prs.html` + shared assets | Keeps each file small; modest, reusable refactor. |
| Staleness source | **S1 → S2** behind a `staleness` flag | Ship fast, upgrade accuracy without a rewrite. |
| Backend structure | **B2** + a small `lib/` cache & limiter | Isolates PR logic; testable; no WIP regression. |
| PR thresholds | Separate config, default **1/3/7** days | PRs should move faster than work items. |

Net: a backend `lib/` extraction plus two new endpoints, a new `prs.html`
sharing extracted CSS/JS, and a two-step staleness rollout — delivering all
four requested PR metrics while leaving the existing WIP feature untouched.
