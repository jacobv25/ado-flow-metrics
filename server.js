'use strict';
require('dotenv').config();

const express = require('express');
const https   = require('https');
const path    = require('path');

const app  = express();
const PORT = parseInt(process.env.PORT || '3333', 10);

// ─── Environment config ───────────────────────────────────────────────────────
const ADO_PAT     = process.env.ADO_PAT     || '';
const ADO_ORG     = (process.env.ADO_ORG    || '').replace(/\/+$/, '');
const ADO_PROJECT = process.env.ADO_PROJECT || '';

// ─── Startup validation ───────────────────────────────────────────────────────
function validateEnv() {
  const missing = ['ADO_PAT', 'ADO_ORG', 'ADO_PROJECT'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error('\n❌  Missing required environment variables:', missing.join(', '));
    console.error('    Copy .env.example → .env and fill in your values.\n');
    process.exit(1);
  }

  if (!isValidAdoOrgUrl(ADO_ORG)) {
    console.error('\n❌  ADO_ORG does not look like a valid Azure DevOps URL:', ADO_ORG);
    console.error('    Expected: https://dev.azure.com/yourorg  or  https://yourorg.visualstudio.com\n');
    process.exit(1);
  }

  if (ADO_PAT.length < 10) {
    console.error('\n❌  ADO_PAT looks too short — please check your Personal Access Token.\n');
    process.exit(1);
  }
}

function isValidAdoOrgUrl(url) {
  try {
    const u = new URL(url);
    // Must be HTTPS
    if (u.protocol !== 'https:') return false;
    // Must be a recognised ADO hostname
    const host = u.hostname.toLowerCase();
    const allowed =
      host === 'dev.azure.com' ||
      host.endsWith('.visualstudio.com') ||
      host.endsWith('.azure.com');
    // Must not have a suspicious path (org-level URL only)
    const pathOk = /^(\/[^/]+)?\/?$/.test(u.pathname);
    return allowed && pathOk;
  } catch {
    return false;
  }
}

// ─── Input helpers ────────────────────────────────────────────────────────────

/**
 * Escape a value for safe inclusion inside a WIQL string literal.
 * Single quotes are doubled per WIQL spec.
 */
function wiqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Parse, validate and sanitise the comma-separated states query param.
 * Returns an array of clean state strings, or throws on bad input.
 */
function parseStates(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('states parameter is required');
  if (raw.length > 500) throw new Error('states parameter is too long');

  const states = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (states.length === 0) throw new Error('At least one state is required');
  if (states.length > 30)  throw new Error('Too many states (max 30)');

  for (const s of states) {
    if (s.length > 100) throw new Error(`State name too long: "${s.slice(0, 40)}…"`);
    // Allow letters, digits, spaces, hyphens, underscores, parentheses
    if (!/^[\w\s\-()]+$/u.test(s)) throw new Error(`State name contains invalid characters: "${s}"`);
  }

  return states;
}

/**
 * Parse and clamp the max-items query param.
 */
function parseMax(raw) {
  const n = parseInt(raw || '200', 10);
  if (isNaN(n) || n < 1) return 200;
  return Math.min(n, 500);
}

// ─── Azure DevOps API helper ──────────────────────────────────────────────────
function adoRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    // Build Basic auth header server-side; PAT never leaves this process
    const token = Buffer.from(':' + ADO_PAT).toString('base64');

    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      port:     443,
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers: {
        'Authorization': `Basic ${token}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json; api-version=7.1',
        'User-Agent':    'wip-aging-tracker/2.0',
      },
    };

    const req = https.request(reqOptions, res => {
      const chunks = [];
      res.on('data',  c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          // Surface the ADO status code but not the raw body (may contain PAT hints)
          return reject(Object.assign(
            new Error(`Azure DevOps returned HTTP ${res.statusCode}`),
            { adoStatus: res.statusCode }
          ));
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Non-JSON response from Azure DevOps')); }
      });
    });

    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(new Error('ADO request timed out')); });

    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Serve the frontend
app.use(express.static(path.join(__dirname, 'public')));

/**
 * GET /api/config
 * Returns non-sensitive display config to the frontend.
 * The PAT is NEVER included.
 */
app.get('/api/config', (_req, res) => {
  res.json({
    org:        ADO_ORG,
    project:    ADO_PROJECT,
    projectUrl: `${ADO_ORG}/${encodeURIComponent(ADO_PROJECT)}`,
  });
});

/**
 * GET /api/wip-aging?states=Active,In+Progress&max=200
 * Returns sanitised work item aging data.
 */
app.get('/api/wip-aging', async (req, res) => {
  // --- Input validation ---
  let states, maxItems;
  try {
    states   = parseStates(req.query.states);
    maxItems = parseMax(req.query.max);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    // --- Build WIQL query with properly escaped values ---
    const stateList    = states.map(wiqlString).join(', ');
    const projectToken = wiqlString(ADO_PROJECT);

    const wiql = [
      'SELECT [System.Id] FROM WorkItems',
      `WHERE [System.TeamProject] = ${projectToken}`,
      `AND [System.WorkItemType] IN ('User Story', 'Bug', 'Feature', 'Epic')`,
      `AND [System.State] IN (${stateList})`,
      'ORDER BY [Microsoft.VSTS.Common.StateChangeDate] ASC',
    ].join(' ');

    const wiqlUrl = `${ADO_ORG}/${encodeURIComponent(ADO_PROJECT)}/_apis/wit/wiql`
                  + `?api-version=7.1&$top=${maxItems}`;

    const wiqlResult = await adoRequest(wiqlUrl, {
      method: 'POST',
      body:   JSON.stringify({ query: wiql }),
    });

    const ids = (wiqlResult.workItems || []).map(w => w.id);
    if (ids.length === 0) return res.json({ items: [], total: 0 });

    // --- Fetch work item details in batches of 200 ---
    const FIELDS = [
      'System.Id',
      'System.Title',
      'System.WorkItemType',
      'System.State',
      'System.AssignedTo',
      'Microsoft.VSTS.Common.StateChangeDate',
      'System.AreaPath',
      'System.IterationPath',
      'System.Priority',
    ].join(',');

    const items = [];
    const BATCH = 200;

    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk      = ids.slice(i, i + BATCH).join(',');
      const detailsUrl = `${ADO_ORG}/_apis/wit/workitems`
                       + `?ids=${chunk}&fields=${FIELDS}&api-version=7.1`;
      const details    = await adoRequest(detailsUrl);

      const now = Date.now();
      for (const raw of (details.value || [])) {
        const f          = raw.fields || {};
        const assignedTo = f['System.AssignedTo'];
        const assignedName =
          assignedTo
            ? (assignedTo.displayName || assignedTo.uniqueName || 'Unknown')
            : 'Unassigned';

        const stateChangeDate = f['Microsoft.VSTS.Common.StateChangeDate'] || null;
        const daysInState = stateChangeDate
          ? Math.max(0, Math.floor((now - new Date(stateChangeDate).getTime()) / 86_400_000))
          : 0;

        items.push({
          id:             Number(f['System.Id']),
          title:          String(f['System.Title'] || '(no title)'),
          type:           String(f['System.WorkItemType'] || 'Unknown'),
          state:          String(f['System.State'] || ''),
          assignedTo:     String(assignedName),
          daysInState,
          stateChangedOn: stateChangeDate,
          area:           String(f['System.AreaPath'] || ''),
          iteration:      String(f['System.IterationPath'] || ''),
          priority:       f['System.Priority'] != null ? Number(f['System.Priority']) : null,
        });
      }
    }

    res.json({ items, total: items.length });

  } catch (err) {
    // Log full error server-side; send a generic message to the client
    console.error('[wip-aging] Error:', err.message);

    const adoStatus = err.adoStatus;
    let clientMessage;
    if (adoStatus === 401 || adoStatus === 403) {
      clientMessage = 'Azure DevOps authentication failed. Check your PAT has Work Items (Read) permission and has not expired.';
    } else if (adoStatus === 404) {
      clientMessage = 'Project not found. Check ADO_PROJECT in your .env matches exactly (case-sensitive).';
    } else if (err.message.includes('timed out')) {
      clientMessage = 'Request to Azure DevOps timed out. Check your network or org URL.';
    } else {
      clientMessage = 'Failed to fetch work items. Check the server terminal for details.';
    }

    res.status(500).json({ error: clientMessage });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
validateEnv();

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n✅  WIP Aging Tracker`);
  console.log(`    URL     : http://localhost:${PORT}`);
  console.log(`    Project : ${ADO_PROJECT}`);
  console.log(`    Org     : ${ADO_ORG}`);
  console.log(`    PAT     : ${'*'.repeat(8)} (loaded from environment)\n`);
});
