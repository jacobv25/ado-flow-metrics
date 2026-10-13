'use strict';

/**
 * lib/demoAdo.js
 *
 * A fake Azure DevOps for DEMO_MODE=true.
 *
 * It answers the three ADO REST endpoints the server uses — WIQL queries,
 * work-item batch lookups, and the pull-request list — with deterministic,
 * synthetic data for a fictional 8-person team. The real route handlers in
 * server.js run unchanged against it, so demo mode exercises the same code
 * paths as a live org. No network calls, no PAT.
 *
 * The data is seeded, so every run produces the same team, the same backlog,
 * the same stale PRs and the same holiday-dip / catch-up-spike weeks in the
 * throughput chart.
 */

const DAY = 86400000;
const NOW = Date.now();

// ─── Seeded RNG (mulberry32) ──────────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng     = mulberry32(20260513);
const pick    = arr => arr[Math.floor(rng() * arr.length)];
const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const chance  = p => rng() < p;
/** Roughly log-normal: median ≈ 5 days, p85 ≈ 12, occasional 30+. */
function cycleDaysSample() {
  const z = (rng() + rng() + rng() + rng() - 2) * 1.2;
  return Math.max(0.3, Math.exp(1.6 + 0.55 * z));
}
const iso = ms => new Date(ms).toISOString();

// ─── Fictional team ───────────────────────────────────────────────────────────
const PEOPLE = [
  'Priya Natarajan', 'Marcus Reed', 'Elena Sokolova', 'Dev Patel',
  'Hannah Lindqvist', 'Tomás Herrera', 'Aiko Tanaka', "Sam O'Neill",
];
const person = name => ({
  displayName: name,
  uniqueName:  name.toLowerCase().replace(/[^a-z]+/g, '.') + '@example.com',
});
const AREAS = ['Demo\\Web', 'Demo\\Platform', 'Demo\\Data'];
const REPOS = ['web-client', 'platform-api', 'data-pipeline'];
const TAGS  = ['tech-debt', 'customer-reported', 'blocked', 'needs-design', 'perf', 'security'];

const STORY_TITLES = [
  'Add CSV export to the timeline view', 'Bulk-edit tags from the work item grid',
  'Show reviewer avatars on PR cards', 'Remember filter state between sessions',
  'Keyboard navigation for the aging table', 'Dark mode for the dashboard',
  'Paginate the audit log', 'Per-team default states setting',
  'Add iteration filter to throughput chart', 'Surface merge conflicts in PR list',
  'Email digest of stale work items', 'Configurable aging thresholds',
  'Export forecast as PDF', 'Support on-prem Azure DevOps Server',
  'Group WIP table by assignee', 'Add story points to throughput buckets',
  'OAuth sign-in instead of PAT', 'Trend sparkline on summary cards',
  'Localize date formats', 'Archive completed sprints view',
  'Inline edit of work item priority', 'Webhook on PR aging threshold',
  'Column chooser for the PR table', 'Drill-down from bucket to items',
  'Rate-limit retry for ADO API calls', 'Cache work item batches for 60s',
  'Add area path breadcrumbs', 'Sortable cycle-time table',
  'Sprint burndown overlay', 'Capacity-aware forecast',
];
const BUG_TITLES = [
  'Timeline scrolls to top on refresh', 'Stale badge shows wrong day count after DST',
  'PR list drops items beyond page 2', 'Forecast chart overflows on narrow screens',
  'Tag filter is case-sensitive', 'Percentile labels overlap at small widths',
  'Draft PRs counted as awaiting review', 'Null assignee crashes the aging table',
  'Double-encoded project name in links', 'Throughput week boundary off by one in UTC-',
  'Chart tooltip stuck after filter change', 'Config endpoint leaks trailing slash',
  'Sort by priority ignores unset values', 'Spinner never hides on 401',
  'Story points parsed as string', 'Iteration path truncated in table',
];
const FEATURE_TITLES = ['Pull request analytics', 'Probabilistic forecasting', 'Team-level flow policies', 'Self-serve onboarding'];
const PR_TITLES = [
  'feat: csv export for timeline', 'fix: stale badge DST math', 'chore: bump express to 4.19',
  'feat: reviewer avatars on PR cards', 'refactor: extract adoRequest helper', 'test: outlier detection edge cases',
  'fix: null assignee in aging table', 'feat: iteration filter on throughput', 'docs: PAT scopes in .env.example',
  'fix: pagination past page 2', 'feat: dark mode tokens', 'perf: batch work item lookups',
  'fix: tooltip stuck after filter', 'feat: group WIP by assignee', 'chore: eslint config',
  'feat: configurable aging thresholds', 'fix: double-encoded project link', 'feat: forecast pdf export',
  'refactor: split forecast page scripts', 'fix: spinner on 401', 'feat: sparkline on summary cards',
  'test: montecarlo degenerate samples', 'fix: priority sort with unset values', 'feat: webhook on aging threshold',
];

// ─── Work items ───────────────────────────────────────────────────────────────
const SPRINT_EPOCH = NOW - 400 * DAY;
const sprintFor = ms => 'Demo\\Sprint ' + (30 + Math.floor((ms - SPRINT_EPOCH) / (14 * DAY)));

function mondayOf(ms) {
  const d = new Date(ms); const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow)); d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}
// Holiday week: six weeks back the team was mostly out; most of that week's
// completions landed the following week (the catch-up spike).
const HOLIDAY_WEEK = mondayOf(NOW - 42 * DAY);

const WORK_ITEMS = [];
let nextId = 4100;
function addWorkItem(w) { WORK_ITEMS.push(Object.assign({ id: nextId++ }, w)); }

(function generateWorkItems() {
  let storyIdx = 0, bugIdx = 0;
  for (let dayBack = 210; dayBack >= 0; dayBack--) {
    // Steady intake: 1 item/day plus a coin-flip second one (low variance, so
    // the holiday dip and its catch-up spike stand out as genuine outliers).
    const n = dayBack > 180 ? (dayBack % 2 ? 1 : 0) : 1 + (dayBack % 3 === 0 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      const type = chance(0.68) ? 'User Story' : chance(0.9) ? 'Bug' : 'Feature';
      const created   = NOW - dayBack * DAY - randInt(0, 20) * 3600000;
      const title     = type === 'Bug'
        ? BUG_TITLES[bugIdx++ % BUG_TITLES.length] + (bugIdx > BUG_TITLES.length ? ' (' + Math.ceil(bugIdx / BUG_TITLES.length) + ')' : '')
        : type === 'Feature' ? pick(FEATURE_TITLES)
        : STORY_TITLES[storyIdx++ % STORY_TITLES.length] + (storyIdx > STORY_TITLES.length ? ' — part ' + Math.ceil(storyIdx / STORY_TITLES.length) : '');
      const points    = type === 'Feature' ? null : pick([1, 2, 3, 3, 5, 5, 8]);
      const priority  = type === 'Bug' ? pick([1, 2, 2, 3]) : pick([2, 3, 3, 4]);
      const area      = pick(AREAS);
      const tags      = chance(0.3) ? [pick(TAGS)] : [];
      const assignee  = chance(0.92) ? pick(PEOPLE) : null;

      // 12% of items never leave the backlog
      if (chance(0.12) && dayBack < 60) {
        addWorkItem({ type, title, state: 'New', created, activated: null, closed: null,
          changed: created + randInt(0, 3) * DAY, points, priority, area, tags, assignee: null });
        continue;
      }
      const activated = created + randInt(0, 6) * DAY + randInt(0, 8) * 3600000;
      let closed      = activated + cycleDaysSample() * DAY;

      // Holiday dip → catch-up spike the week after
      if (closed >= HOLIDAY_WEEK && closed < HOLIDAY_WEEK + 7 * DAY && chance(0.95)) closed += 7 * DAY;

      if (activated > NOW) {
        addWorkItem({ type, title, state: 'New', created, activated: null, closed: null,
          changed: created, points, priority, area, tags, assignee });
      } else if (closed > NOW) {
        addWorkItem({ type, title, state: 'Active', created, activated, closed: null,
          changed: Math.min(NOW, activated + randInt(0, 2) * DAY), points, priority, area, tags, assignee });
      } else {
        const resolved = chance(0.1);
        addWorkItem({ type, title, state: resolved ? 'Resolved' : 'Closed', created, activated, closed,
          changed: closed + randInt(0, 1) * DAY, points, priority, area, tags, assignee });
      }
    }
  }
  // A handful of genuinely stuck items — the reason an aging view exists.
  const stuck = [
    ['User Story', 'Migrate legacy report service', 47, 'blocked'],
    ['Bug',        'Intermittent 502 from platform-api behind proxy', 38, 'needs-info'],
    ['User Story', 'SSO integration with corporate IdP', 61, 'blocked'],
    ['User Story', 'Replace vis.js timeline with canvas renderer', 29, 'needs-design'],
    ['Bug',        'Memory growth in long-lived dashboard tabs', 24, 'perf'],
  ];
  for (const [type, title, age, tag] of stuck) {
    const activated = NOW - age * DAY;
    addWorkItem({ type, title, state: 'Active', created: activated - randInt(2, 10) * DAY, activated, closed: null,
      changed: activated + randInt(0, 3) * DAY, points: pick([5, 8]), priority: 2, area: pick(AREAS), tags: [tag], assignee: pick(PEOPLE) });
  }
})();

function stateChangeDate(w) {
  if (w.state === 'Closed' || w.state === 'Resolved') return w.closed;
  if (w.state === 'Active') return w.activated;
  return w.created;
}

function fieldsFor(w, wanted) {
  const all = {
    'System.Id':                              w.id,
    'System.Title':                           w.title,
    'System.WorkItemType':                    w.type,
    'System.State':                           w.state,
    'System.AssignedTo':                      w.assignee ? person(w.assignee) : undefined,
    'Microsoft.VSTS.Common.StateChangeDate':  iso(stateChangeDate(w)),
    'System.ChangedDate':                     iso(w.changed),
    'System.AreaPath':                        w.area,
    'System.IterationPath':                   sprintFor(w.closed || w.activated || w.created),
    'Microsoft.VSTS.Common.Priority':         w.priority,
    'System.Tags':                            w.tags.length ? w.tags.join('; ') : undefined,
    'Microsoft.VSTS.Common.ActivatedDate':    w.activated ? iso(w.activated) : undefined,
    'Microsoft.VSTS.Common.ClosedDate':       w.closed    ? iso(w.closed)    : undefined,
    'Microsoft.VSTS.Scheduling.StoryPoints':  w.points != null ? w.points : undefined,
  };
  const out = {};
  for (const f of wanted || Object.keys(all)) if (all[f] !== undefined) out[f] = all[f];
  return out;
}

// ─── Pull requests ────────────────────────────────────────────────────────────
const PULL_REQUESTS = [];
(function generatePrs() {
  let prId = 1200;
  // Completed PRs over the last 100 days
  for (let i = 0; i < 70; i++) {
    const closed    = NOW - rng() * 100 * DAY;
    const mergeDays = Math.max(0.1, Math.exp(0.9 + 0.9 * ((rng() + rng() + rng() - 1.5) * 1.1)));
    const author    = pick(PEOPLE);
    PULL_REQUESTS.push({
      pullRequestId: prId++, title: pick(PR_TITLES), repository: { name: pick(REPOS) },
      status: 'completed', isDraft: false, createdBy: person(author),
      creationDate: iso(closed - mergeDays * DAY), closedDate: iso(closed), mergeStatus: 'succeeded',
      reviewers: [{ ...person(pick(PEOPLE.filter(p => p !== author))), vote: 10, isRequired: true, isContainer: false }],
      sourceRefName: 'refs/heads/' + pick(['feature', 'fix', 'chore']) + '/' + randInt(100, 999),
      targetRefName: 'refs/heads/main',
    });
  }
  // Open PRs: a realistic spread, including a few that have been sitting too long
  const open = [
    ['feat: capacity-aware forecast',           14, 'awaiting', false, false],
    ['fix: tag filter case sensitivity',         1, 'approved', false, false],
    ['refactor: forecast page into modules',    11, 'changes',  false, false],
    ['feat: oauth sign-in',                     18, 'none',     true,  false],
    ['fix: percentile label overlap',            2, 'awaiting', false, false],
    ['chore: dependabot config',                 0, 'none',     false, false],
    ['feat: webhook on aging threshold',         6, 'awaiting', false, true],
    ['feat: drill-down from bucket to items',    3, 'approved', false, false],
    ['fix: spinner never hides on 401',          9, 'rejected', false, false],
    ['docs: architecture overview',              4, 'none',     true,  false],
    ['perf: cache work item batches',            7, 'awaiting', false, false],
    ['feat: sortable cycle-time table',          1, 'none',     false, false],
    ['test: demo mode contract tests',           2, 'awaiting', false, false],
    ['fix: UTC week boundary',                  13, 'changes',  false, false],
  ];
  const voteFor = { approved: 10, awaiting: 0, changes: -5, rejected: -10, none: null };
  for (const [title, age, state, isDraft, conflict] of open) {
    const author    = pick(PEOPLE);
    const vote      = voteFor[state];
    const reviewers = vote == null ? [] : [
      { ...person(pick(PEOPLE.filter(p => p !== author))), vote, isRequired: true, isContainer: false },
      ...(chance(0.5) ? [{ ...person(pick(PEOPLE.filter(p => p !== author))), vote: state === 'approved' ? 5 : 0, isRequired: false, isContainer: false }] : []),
    ];
    PULL_REQUESTS.push({
      pullRequestId: prId++, title, repository: { name: pick(REPOS) },
      status: 'active', isDraft, createdBy: person(author),
      creationDate: iso(NOW - age * DAY - randInt(1, 9) * 3600000), closedDate: null,
      mergeStatus: conflict ? 'conflicts' : 'succeeded', reviewers,
      sourceRefName: 'refs/heads/' + title.split(':')[0] + '/' + randInt(100, 999), targetRefName: 'refs/heads/main',
    });
  }
})();

// ─── Request router ───────────────────────────────────────────────────────────
function parseInList(wiql, field) {
  const m = wiql.match(new RegExp('\\[' + field.replace('.', '\\.') + '\\]\\s+IN\\s*\\(([^)]*)\\)', 'i'));
  if (!m) return null;
  return m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '').replace(/''/g, "'"));
}

function handleWiql(url, body) {
  const wiql   = (body && body.query) || '';
  const states = parseInList(wiql, 'System.State');
  const types  = parseInList(wiql, 'System.WorkItemType');
  const since  = (wiql.match(/ClosedDate\]\s*>=\s*'([^']+)'/) || [])[1];
  const top    = parseInt(url.searchParams.get('$top') || '2000', 10);
  const byClosed = /ORDER BY \[Microsoft\.VSTS\.Common\.ClosedDate\]/i.test(wiql);

  let rows = WORK_ITEMS.filter(w =>
    (!states || states.includes(w.state)) &&
    (!types  || types.includes(w.type)) &&
    (!since  || (w.closed && w.closed >= new Date(since).getTime()))
  );
  rows.sort((a, b) => byClosed ? a.closed - b.closed : a.changed - b.changed);
  return { workItems: rows.slice(0, top).map(w => ({ id: w.id })) };
}

function handleBatch(body) {
  const ids    = (body && body.ids) || [];
  const fields = body && body.fields;
  const byId   = new Map(WORK_ITEMS.map(w => [w.id, w]));
  return { value: ids.filter(id => byId.has(id)).map(id => ({ id, fields: fieldsFor(byId.get(id), fields) })) };
}

function handlePrs(url) {
  const status  = url.searchParams.get('searchCriteria.status') || 'active';
  const minTime = url.searchParams.get('searchCriteria.minTime');
  const top     = parseInt(url.searchParams.get('$top')  || '100', 10);
  const skip    = parseInt(url.searchParams.get('$skip') || '0',   10);
  let rows = PULL_REQUESTS.filter(pr => status === 'all' || pr.status === status);
  if (minTime) rows = rows.filter(pr => pr.closedDate && new Date(pr.closedDate).getTime() >= new Date(minTime).getTime());
  rows.sort((a, b) => new Date(b.creationDate) - new Date(a.creationDate));
  const page = rows.slice(skip, skip + top);
  return { value: page, count: page.length };
}

/**
 * Drop-in replacement for adoClient.adoRequest(url, options).
 * Resolves with the same JSON shapes Azure DevOps returns for the endpoints
 * server.js uses; rejects with an ADO-style 404 for anything else.
 */
function demoRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    const path = u.pathname;
    if (path.endsWith('/_apis/wit/wiql'))           return resolve(handleWiql(u, body));
    if (path.endsWith('/_apis/wit/workitemsbatch')) return resolve(handleBatch(body));
    if (path.endsWith('/_apis/git/pullrequests'))   return resolve(handlePrs(u));
    reject(Object.assign(new Error('Demo ADO: no handler for ' + path), { adoStatus: 404 }));
  });
}

module.exports = { demoRequest, WORK_ITEMS, PULL_REQUESTS, PEOPLE };
