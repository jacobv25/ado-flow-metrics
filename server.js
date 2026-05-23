'use strict'

require('dotenv').config();

const express = require('express');
const path    = require('path');

const { adoRequest, ADO_API_VERSION } = require('./lib/adoClient');

const app  = express();
const PORT = parseInt(process.env.PORT || '3333', 10);

const ADO_ORG     = (process.env.ADO_ORG     || '').replace(/\/+$/, '');
const ADO_PROJECT = process.env.ADO_PROJECT   || '';

// --- Startup validation -------------------------------------------------------
function isValidAdoOrgUrl(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && Boolean(u.hostname); }
  catch { return false; }
}

function validateEnv() {
  const missing = ['ADO_PAT', 'ADO_ORG', 'ADO_PROJECT'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error('\nMissing required env vars:', missing.join(', '));
    console.error('Copy .env.example to .env and fill in your values.\n');
    process.exit(1);
  }
  if (!isValidAdoOrgUrl(ADO_ORG)) {
    console.error('\nADO_ORG is not a valid HTTPS URL:', ADO_ORG);
    process.exit(1);
  }
  if ((process.env.ADO_PAT || '').length < 10) {
    console.error('\nADO_PAT looks too short.\n');
    process.exit(1);
  }
}

// --- Input helpers ------------------------------------------------------------
function wiqlString(v) { return "'" + String(v).replace(/'/g, "''") + "'"; }

function parseStates(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('states parameter is required');
  if (raw.length > 500) throw new Error('states parameter is too long');
  const states = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!states.length) throw new Error('At least one state is required');
  if (states.length > 30) throw new Error('Too many states; max is 30');
  for (const s of states) {
    if (s.length > 100) throw new Error('State name too long');
    if (!/^[\w\s\-()]+$/.test(s)) throw new Error('Invalid state name: "' + s + '"');
  }
  return states;
}

function parseMax(raw) {
  const n = parseInt(raw || '200', 10);
  if (Number.isNaN(n) || n < 1) return 200;
  return Math.min(n, 500);
}

const ALLOWED_PR_STATUS    = new Set(['active', 'completed', 'abandoned', 'all']);
const ALLOWED_CYCLE_DAYS   = new Set([7, 14, 30, 90]);
const ALLOWED_HISTORY_DAYS = new Set([28, 56, 84, 180]);
const ALLOWED_INTERVALS    = new Set(['week', 'day']);

function parsePrStatus(raw) {
  const v = (raw || 'active').toLowerCase().trim();
  if (!ALLOWED_PR_STATUS.has(v)) throw new Error('Invalid PR status: ' + v);
  return v;
}

function parseCycleDays(raw) {
  const n = parseInt(raw || '30', 10);
  if (!ALLOWED_CYCLE_DAYS.has(n)) throw new Error('Invalid days value: ' + raw);
  return n;
}

function parseHistoryDays(raw) {
  const n = parseInt(raw || '84', 10);
  if (!ALLOWED_HISTORY_DAYS.has(n))
    throw new Error('Invalid days value: ' + raw + '. Allowed: 28, 56, 84, 180');
  return n;
}

function parseInterval(raw) {
  const v = (raw || 'week').toLowerCase().trim();
  if (!ALLOWED_INTERVALS.has(v))
    throw new Error('Invalid interval: ' + (raw || '') + '. Allowed: week, day');
  return v;
}

function parseItemTypes(raw) {
  if (!raw || typeof raw !== 'string') return ['User Story', 'Bug'];
  if (raw.length > 500) throw new Error('types parameter is too long');
  const types = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!types.length) return ['User Story', 'Bug'];
  if (types.length > 20) throw new Error('Too many types; max is 20');
  for (const t of types) {
    if (t.length > 100) throw new Error('Type name too long');
    if (!/^[\w\s\-()/]+$/.test(t)) throw new Error('Invalid type name: "' + t + '"');
  }
  return types;
}

// ─── Throughput / forecasting helpers ─────────────────────────────────────────

/**
 * Return the ISO date (YYYY-MM-DD) of the Monday of the week containing `dateStr`.
 * Weeks are UTC-based (Monday → Sunday).
 */
function isoWeekStart(dateStr) {
  const d   = new Date(dateStr);
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, …
  const diff = day === 0 ? -6 : 1 - day;
  const mon  = new Date(d);
  mon.setUTCDate(d.getUTCDate() + diff);
  mon.setUTCHours(0, 0, 0, 0);
  return mon.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// --- PR helpers ---------------------------------------------------------------
function deriveReviewState(isDraft, reviewers) {
  if (isDraft) return 'draft';
  if (!reviewers || !reviewers.length) return 'none';
  const ind = reviewers.filter(r => !r.isContainer);
  if (ind.some(r => r.vote === -10)) return 'rejected';
  if (ind.some(r => r.vote === -5))  return 'changes';
  const req = ind.filter(r => r.isRequired);
  const chk = req.length ? req : ind;
  if (chk.length && chk.every(r => r.vote >= 5)) return 'approved';
  if (ind.some(r => r.vote === 0)) return 'awaiting';
  return 'none';
}

function daysBetween(start, end) {
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  if (Number.isNaN(s)) return 0;
  return Math.max(0, Math.floor((e - s) / 86400000));
}

function prUrl(repo, id) {
  return ADO_ORG + '/' + encodeURIComponent(ADO_PROJECT) +
    '/_git/' + encodeURIComponent(repo) + '/pullrequest/' + id;
}

async function fetchAllPrs(status, max) {
  const items = [], ps = Math.min(100, max);
  let skip = 0;
  while (items.length < max) {
    const u = new URL(ADO_ORG + '/' + encodeURIComponent(ADO_PROJECT) + '/_apis/git/pullrequests');
    u.searchParams.set('searchCriteria.status', status);
    u.searchParams.set('$top',  String(ps));
    u.searchParams.set('$skip', String(skip));
    u.searchParams.set('api-version', ADO_API_VERSION);
    const page  = await adoRequest(u.toString());
    const batch = page.value || [];
    items.push(...batch);
    if (batch.length < ps) break;
    skip += ps;
  }
  return items.slice(0, max);
}

function adoErrorMessage(err, feature) {
  const s = err.adoStatus;
  if (s === 401 || s === 403)
    return 'Authentication failed for ' + feature +
      '. Ensure PAT has Work Items (Read) and Code (Read) scope and has not expired.';
  if (s === 404) return 'ADO project/endpoint not found. Check ADO_ORG and ADO_PROJECT.';
  if (err.message.includes('timed out')) return 'Request to ADO timed out.';
  if (err.message.includes('certificate') || err.message.includes('issuer'))
    return 'TLS validation failed. Use ADO_CA_CERT_PATH or ADO_INSECURE_TLS=true (dev only).';
  return 'Failed to fetch ' + feature + '. Check server terminal for details.';
}

// --- Routes ------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (_req, res) => {
  res.json({
    org:        ADO_ORG,
    project:    ADO_PROJECT,
    projectUrl: ADO_ORG + '/' + encodeURIComponent(ADO_PROJECT),
  });
});

// GET /api/wip-aging?states=Active,...&max=200
app.get('/api/wip-aging', async (req, res) => {
  let states, maxItems;
  try { states = parseStates(req.query.states); maxItems = parseMax(req.query.max); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  try {
    const stateList    = states.map(wiqlString).join(', ');
    const projectToken = wiqlString(ADO_PROJECT);
    const wiql = [
      'SELECT [System.Id] FROM WorkItems',
      'WHERE [System.TeamProject] = ' + projectToken,
      "AND [System.WorkItemType] IN ('User Story', 'Bug', 'Feature', 'Epic')",
      'AND [System.State] IN (' + stateList + ')',
      'ORDER BY [System.ChangedDate] ASC',
    ].join(' ');

    const wu = new URL(ADO_ORG + '/' + encodeURIComponent(ADO_PROJECT) + '/_apis/wit/wiql');
    wu.searchParams.set('api-version', ADO_API_VERSION);
    wu.searchParams.set('$top', String(maxItems));
    const wiqlResult = await adoRequest(wu.toString(), { method: 'POST', body: JSON.stringify({ query: wiql }) });

    const ids = (wiqlResult.workItems || []).map(w => w.id).filter(Boolean);
    if (!ids.length) return res.json({ items: [], total: 0 });

    const FIELDS = [
      'System.Id', 'System.Title', 'System.WorkItemType', 'System.State',
      'System.AssignedTo', 'Microsoft.VSTS.Common.StateChangeDate',
      'System.ChangedDate', 'System.AreaPath', 'System.IterationPath',
      'Microsoft.VSTS.Common.Priority',
    ];

    const items = [];
    const BATCH = 200;
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const du = new URL(ADO_ORG + '/' + encodeURIComponent(ADO_PROJECT) + '/_apis/wit/workitemsbatch');
      du.searchParams.set('api-version', ADO_API_VERSION);
      const details = await adoRequest(du.toString(), {
        method: 'POST', body: JSON.stringify({ ids: chunk, fields: FIELDS, errorPolicy: 'Omit' }),
      });
      const now = Date.now();
      for (const raw of details.value || []) {
        const f = raw.fields || {};
        const at = f['System.AssignedTo'];
        const assignedName = at ? (at.displayName || at.uniqueName || 'Unknown') : 'Unassigned';
        const stateChangeDate = f['Microsoft.VSTS.Common.StateChangeDate'] || f['System.ChangedDate'] || null;
        const pd = stateChangeDate ? new Date(stateChangeDate).getTime() : NaN;
        const daysInState = Number.isFinite(pd) ? Math.max(0, Math.floor((now - pd) / 86400000)) : 0;
        items.push({
          id:             Number(f['System.Id']           || raw.id),
          title:          String(f['System.Title']        || '(no title)'),
          type:           String(f['System.WorkItemType'] || 'Unknown'),
          state:          String(f['System.State']        || ''),
          assignedTo:     String(assignedName),
          daysInState,
          stateChangedOn: stateChangeDate,
          area:           String(f['System.AreaPath']     || ''),
          iteration:      String(f['System.IterationPath']|| ''),
          priority:       f['System.Priority'] != null ? Number(f['System.Priority']) : null,
        });
      }
    }
    res.json({ items, total: items.length });
  } catch (err) {
    console.error('[wip-aging] Error:', err.message);
    res.status(500).json({ error: adoErrorMessage(err, 'work items') });
  }
});

// GET /api/pr-aging?status=active&max=200
// Phase 1 S1 (staleness=off): staleDays/lastActivityOn are null.
// The UI labels staleness figures as approximate.
app.get('/api/pr-aging', async (req, res) => {
  let status, maxItems;
  try { status = parsePrStatus(req.query.status); maxItems = parseMax(req.query.max); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  try {
    const rawPrs = await fetchAllPrs(status, maxItems);
    const items  = rawPrs.map(pr => {
      const repoName        = (pr.repository && pr.repository.name) || 'unknown';
      const ageDays         = daysBetween(pr.creationDate, pr.closedDate || null);
      const reviewers       = (pr.reviewers || []).map(r => ({
        name:        r.displayName || r.uniqueName || 'Unknown',
        vote:        typeof r.vote === 'number' ? r.vote : 0,
        isRequired:  Boolean(r.isRequired),
        isContainer: Boolean(r.isContainer),
      }));
      const reviewState      = deriveReviewState(Boolean(pr.isDraft), pr.reviewers || []);
      const hasMergeConflict = pr.mergeStatus === 'conflicts';
      return {
        id:             pr.pullRequestId,
        title:          String(pr.title || '(no title)'),
        repo:           repoName,
        status:         pr.status || status,
        isDraft:        Boolean(pr.isDraft),
        createdBy:      pr.createdBy
                          ? (pr.createdBy.displayName || pr.createdBy.uniqueName || 'Unknown')
                          : 'Unknown',
        creationDate:   pr.creationDate || null,
        closedDate:     pr.closedDate   || null,
        ageDays,
        lastActivityOn: null,
        staleDays:      null,
        reviewState,
        reviewWaitDays: ageDays,
        hasMergeConflict,
        reviewers,
        sourceRef: (pr.sourceRefName || '').replace(/^refs\/heads\//, ''),
        targetRef: (pr.targetRefName || '').replace(/^refs\/heads\//, ''),
        url:       prUrl(repoName, pr.pullRequestId),
      };
    });
    res.json({ items, total: items.length, stalenessMode: 'off' });
  } catch (err) {
    console.error('[pr-aging] Error:', err.message);
    res.status(500).json({ error: adoErrorMessage(err, 'pull requests') });
  }
});

// GET /api/pr-cycle-time?days=30
app.get('/api/pr-cycle-time', async (req, res) => {
  let days;
  try { days = parseCycleDays(req.query.days); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  try {
    const minTime = new Date(Date.now() - days * 86400000).toISOString();
    const u = new URL(ADO_ORG + '/' + encodeURIComponent(ADO_PROJECT) + '/_apis/git/pullrequests');
    u.searchParams.set('searchCriteria.status',             'completed');
    u.searchParams.set('searchCriteria.queryTimeRangeType', 'closed');
    u.searchParams.set('searchCriteria.minTime',            minTime);
    u.searchParams.set('$top', '500');
    u.searchParams.set('api-version', ADO_API_VERSION);

    const page  = await adoRequest(u.toString());
    const items = (page.value || [])
      .filter(pr => pr.creationDate && pr.closedDate)
      .map(pr => {
        const repoName  = (pr.repository && pr.repository.name) || 'unknown';
        const mergeDays = parseFloat(daysBetween(pr.creationDate, pr.closedDate).toFixed(1));
        return { id: pr.pullRequestId, title: String(pr.title || '(no title)'),
                 repo: repoName, mergeDays, closedDate: pr.closedDate,
                 url: prUrl(repoName, pr.pullRequestId) };
      });

    const count = items.length;
    let avgDays = null, medianDays = null;
    if (count > 0) {
      const sorted = [...items].sort((a, b) => a.mergeDays - b.mergeDays);
      avgDays    = parseFloat((items.reduce((s, i) => s + i.mergeDays, 0) / count).toFixed(1));
      medianDays = count % 2 === 0
        ? parseFloat(((sorted[count/2 - 1].mergeDays + sorted[count/2].mergeDays) / 2).toFixed(1))
        : sorted[Math.floor(count / 2)].mergeDays;
    }
    res.json({ items, total: count, avgDays, medianDays, days });
  } catch (err) {
    console.error('[pr-cycle-time] Error:', err.message);
    res.status(500).json({ error: adoErrorMessage(err, 'pr cycle time') });
  }
});

// GET /api/throughput?days=84&interval=week&states=Closed,Done&types=User+Story,Bug&detail=1
// detail=0 returns the lean legacy payload (count only, no items[]) for other consumers.
app.get('/api/throughput', async (req, res) => {
  let days, interval, states, types;
  try {
    days     = parseHistoryDays(req.query.days);
    interval = parseInterval(req.query.interval);
    states   = req.query.states
      ? parseStates(req.query.states)
      : ['Closed', 'Done', 'Resolved'];
    types    = parseItemTypes(req.query.types);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // detail=0 opts out of per-item enrichment (lean legacy shape)
  const wantDetail = req.query.detail !== '0';

  // Fields for enriched vs. lean requests
  const ENRICHED_FIELDS = [
    'System.Id', 'System.Title', 'System.WorkItemType',
    'Microsoft.VSTS.Common.Priority', 'System.AssignedTo',
    'System.AreaPath', 'System.IterationPath',
    'Microsoft.VSTS.Common.ActivatedDate',
    'Microsoft.VSTS.Common.ClosedDate',
    'Microsoft.VSTS.Scheduling.StoryPoints',
  ];
  const LEAN_FIELDS = ['System.Id', 'Microsoft.VSTS.Common.ClosedDate'];

  try {
    const since        = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const stateList    = states.map(wiqlString).join(', ');
    const typeList     = types.map(wiqlString).join(', ');
    const projectToken = wiqlString(ADO_PROJECT);

    const wiql = [
      'SELECT [System.Id] FROM WorkItems',
      'WHERE [System.TeamProject] = ' + projectToken,
      'AND [System.WorkItemType] IN (' + typeList + ')',
      'AND [System.State] IN (' + stateList + ')',
      "AND [Microsoft.VSTS.Common.ClosedDate] >= '" + since + "T00:00:00Z'",
      'ORDER BY [Microsoft.VSTS.Common.ClosedDate] ASC',
    ].join(' ');

    const wu = new URL(ADO_ORG + '/' + encodeURIComponent(ADO_PROJECT) + '/_apis/wit/wiql');
    wu.searchParams.set('api-version', ADO_API_VERSION);
    wu.searchParams.set('$top', '2000');
    const wiqlResult = await adoRequest(wu.toString(), {
      method: 'POST', body: JSON.stringify({ query: wiql }),
    });

    const ids = (wiqlResult.workItems || []).map(w => w.id).filter(Boolean);
    if (!ids.length) {
      return res.json({
        interval, buckets: [], totalCompleted: 0,
        perInterval: { mean: 0, min: 0, max: 0 }, days,
      });
    }

    const closedItems = [];
    const BATCH = 200;
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const du = new URL(ADO_ORG + '/' + encodeURIComponent(ADO_PROJECT) + '/_apis/wit/workitemsbatch');
      du.searchParams.set('api-version', ADO_API_VERSION);
      const details = await adoRequest(du.toString(), {
        method: 'POST',
        body: JSON.stringify({
          ids: chunk,
          fields: wantDetail ? ENRICHED_FIELDS : LEAN_FIELDS,
          errorPolicy: 'Omit',
        }),
      });
      for (const raw of details.value || []) {
        const f  = raw.fields || {};
        const cd = f['Microsoft.VSTS.Common.ClosedDate'];
        if (!cd) continue;

        if (!wantDetail) {
          closedItems.push({ id: Number(raw.id), closedDate: cd });
          continue;
        }

        const at            = f['System.AssignedTo'];
        const assignedTo    = at ? (at.displayName || at.uniqueName || 'Unknown') : 'Unassigned';
        const activatedDate = f['Microsoft.VSTS.Common.ActivatedDate'] || null;
        const rawCycleDays  = activatedDate
          ? (new Date(cd) - new Date(activatedDate)) / 86400000
          : null;
        const cycleDays     = rawCycleDays != null && rawCycleDays >= 0
          ? parseFloat(rawCycleDays.toFixed(1))
          : null;
        const spRaw         = f['Microsoft.VSTS.Scheduling.StoryPoints'];

        closedItems.push({
          id:           Number(f['System.Id'] || raw.id),
          title:        String(f['System.Title']        || '(no title)'),
          type:         String(f['System.WorkItemType'] || 'Unknown'),
          priority:     f['Microsoft.VSTS.Common.Priority'] != null
                          ? Number(f['Microsoft.VSTS.Common.Priority']) : null,
          assignedTo,
          area:         String(f['System.AreaPath']      || ''),
          iteration:    String(f['System.IterationPath'] || ''),
          closedDate:   cd,
          activatedDate,
          cycleDays,
          storyPoints:  spRaw != null ? Number(spRaw) : null,
        });
      }
    }

    const bucketMap   = new Map();
    const windowStart = new Date(since + 'T00:00:00Z');
    const today       = new Date();
    today.setUTCHours(23, 59, 59, 999);

    if (interval === 'week') {
      let cursor = new Date(since + 'T00:00:00Z');
      const dow  = cursor.getUTCDay();
      cursor.setUTCDate(cursor.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
      while (cursor <= today) {
        const start = cursor.toISOString().slice(0, 10);
        const end   = addDays(start, 6);
        bucketMap.set(start, { start, end, count: 0, items: [] });
        cursor.setUTCDate(cursor.getUTCDate() + 7);
      }
    } else {
      let cursor = new Date(windowStart);
      cursor.setUTCHours(0, 0, 0, 0);
      while (cursor <= today) {
        const ds = cursor.toISOString().slice(0, 10);
        bucketMap.set(ds, { start: ds, end: ds, count: 0, items: [] });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }

    for (const item of closedItems) {
      const key = interval === 'week'
        ? isoWeekStart(item.closedDate)
        : item.closedDate.slice(0, 10);
      const bucket = bucketMap.get(key);
      if (bucket) {
        bucket.count++;
        if (wantDetail) bucket.items.push(item);
      }
    }

    const buckets        = [...bucketMap.values()];
    const totalCompleted = closedItems.length;
    const counts         = buckets.map(b => b.count);
    const mean = counts.length
      ? parseFloat((counts.reduce((s, v) => s + v, 0) / counts.length).toFixed(2))
      : 0;

    const responseBuckets = wantDetail
      ? buckets
      : buckets.map(b => ({ start: b.start, end: b.end, count: b.count }));

    res.json({
      interval, buckets: responseBuckets, totalCompleted,
      perInterval: {
        mean,
        min: counts.length ? Math.min(...counts) : 0,
        max: counts.length ? Math.max(...counts) : 0,
      },
      days,
    });
  } catch (err) {
    console.error('[throughput] Error:', err.message);
    res.status(500).json({ error: adoErrorMessage(err, 'throughput') });
  }
});

// GET /api/wi-cycle-time?days=84&states=Closed,Done&types=User+Story,Bug
app.get('/api/wi-cycle-time', async (req, res) => {
  let days, states, types;
  try {
    days   = parseHistoryDays(req.query.days);
    states = req.query.states
      ? parseStates(req.query.states)
      : ['Closed', 'Done', 'Resolved'];
    types  = parseItemTypes(req.query.types);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const since        = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const stateList    = states.map(wiqlString).join(', ');
    const typeList     = types.map(wiqlString).join(', ');
    const projectToken = wiqlString(ADO_PROJECT);

    const wiql = [
      'SELECT [System.Id] FROM WorkItems',
      'WHERE [System.TeamProject] = ' + projectToken,
      'AND [System.WorkItemType] IN (' + typeList + ')',
      'AND [System.State] IN (' + stateList + ')',
      "AND [Microsoft.VSTS.Common.ClosedDate] >= '" + since + "T00:00:00Z'",
      'ORDER BY [Microsoft.VSTS.Common.ClosedDate] ASC',
    ].join(' ');

    const wu = new URL(ADO_ORG + '/' + encodeURIComponent(ADO_PROJECT) + '/_apis/wit/wiql');
    wu.searchParams.set('api-version', ADO_API_VERSION);
    const wiqlResult = await adoRequest(wu.toString(), {
      method: 'POST', body: JSON.stringify({ query: wiql }),
    });

    const ids = (wiqlResult.workItems || []).map(w => w.id).filter(Boolean);
    if (!ids.length) {
      return res.json({
        items: [], total: 0, avgDays: null,
        p50: null, p85: null, p95: null,
        startField: 'ActivatedDate', days,
      });
    }

    const FIELDS = [
      'System.Id', 'System.Title', 'System.WorkItemType',
      'Microsoft.VSTS.Common.ClosedDate',
      'Microsoft.VSTS.Common.ActivatedDate',
    ];
    const allItems = [];
    const BATCH    = 200;
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const du = new URL(ADO_ORG + '/' + encodeURIComponent(ADO_PROJECT) + '/_apis/wit/workitemsbatch');
      du.searchParams.set('api-version', ADO_API_VERSION);
      const details = await adoRequest(du.toString(), {
        method: 'POST',
        body: JSON.stringify({ ids: chunk, fields: FIELDS, errorPolicy: 'Omit' }),
      });
      for (const raw of details.value || []) {
        const f             = raw.fields || {};
        const closedDate    = f['Microsoft.VSTS.Common.ClosedDate'];
        const activatedDate = f['Microsoft.VSTS.Common.ActivatedDate'];
        if (!closedDate || !activatedDate) continue;
        const cycleDays = parseFloat(
          ((new Date(closedDate) - new Date(activatedDate)) / 86400000).toFixed(1)
        );
        if (cycleDays < 0) continue;
        allItems.push({
          id:         Number(f['System.Id'] || raw.id),
          type:       String(f['System.WorkItemType'] || 'Unknown'),
          cycleDays,
          closedDate,
        });
      }
    }

    const total = allItems.length;
    let avgDays = null, p50 = null, p85 = null, p95 = null;
    if (total > 0) {
      const sorted = [...allItems].sort((a, b) => a.cycleDays - b.cycleDays);
      avgDays = parseFloat(
        (allItems.reduce((s, i) => s + i.cycleDays, 0) / total).toFixed(1)
      );
      p50 = sorted[Math.floor(0.50 * sorted.length)].cycleDays;
      p85 = sorted[Math.min(Math.floor(0.85 * sorted.length), total - 1)].cycleDays;
      p95 = sorted[Math.min(Math.floor(0.95 * sorted.length), total - 1)].cycleDays;
    }

    res.json({ items: allItems, total, avgDays, p50, p85, p95, startField: 'ActivatedDate', days });
  } catch (err) {
    console.error('[wi-cycle-time] Error:', err.message);
    res.status(500).json({ error: adoErrorMessage(err, 'work-item cycle time') });
  }
});

// --- Start -------------------------------------------------------------------
validateEnv();

app.listen(PORT, '127.0.0.1', () => {
  console.log('\n  WIP + PR Aging Tracker');
  console.log('    URL     : http://localhost:' + PORT);
  console.log('    Project : ' + ADO_PROJECT);
  console.log('    Org     : ' + ADO_ORG);
  console.log('    API     : ' + ADO_API_VERSION);
  console.log('    PAT     : ' + '*'.repeat(8) + ' (from environment)');
  console.log('    Routes  : /api/config  /api/wip-aging  /api/pr-aging  /api/pr-cycle-time');
  console.log('              /api/throughput  /api/wi-cycle-time\n');
});
