'use strict'

require('dotenv').config();

const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = parseInt(process.env.PORT || '3333', 10);

// ─── Environment config ───────────────────────────────────────────────────────
const ADO_PAT = process.env.ADO_PAT || '';
const ADO_ORG = (process.env.ADO_ORG || '').replace(/\/+$/, '');
const ADO_PROJECT = process.env.ADO_PROJECT || '';
const ADO_API_VERSION = process.env.ADO_API_VERSION || '7.1';

// Optional TLS settings:
//   ADO_INSECURE_TLS=true                 disables TLS cert validation; dev only
//   ADO_CA_CERT_PATH=/path/to/ca.pem      trusts your corporate/internal CA
function buildHttpsAgent() {
  if (process.env.ADO_INSECURE_TLS === 'true') {
    console.warn('[wip-aging] WARNING: TLS certificate validation is disabled. Use only for local/dev testing.');
    return new https.Agent({ rejectUnauthorized: false });
  }

  if (process.env.ADO_CA_CERT_PATH) {
    return new https.Agent({
      ca: fs.readFileSync(process.env.ADO_CA_CERT_PATH),
    });
  }

  return undefined;
}

const adoAgent = buildHttpsAgent();

// ─── Startup validation ───────────────────────────────────────────────────────
function validateEnv() {
  const missing = ['ADO_PAT', 'ADO_ORG', 'ADO_PROJECT'].filter(k => !process.env[k]);

  if (missing.length) {
    console.error('\n❌ Missing required environment variables:', missing.join(', '));
    console.error('   Copy .env.example → .env and fill in your values.\n');
    process.exit(1);
  }

  if (!isValidAdoOrgUrl(ADO_ORG)) {
    console.error('\n❌ ADO_ORG does not look like a valid Azure DevOps/TFS URL:', ADO_ORG);
    console.error('   Expected examples:');
    console.error('   - https://dev.azure.com/yourorg');
    console.error('   - https://yourorg.visualstudio.com');
    console.error('   - https://your-tfs-server/tfs/DefaultCollection');
    console.error('   - https://your-tfs-server/CollectionName\n');
    process.exit(1);
  }

  if (ADO_PAT.length < 10) {
    console.error('\n❌ ADO_PAT looks too short — please check your Personal Access Token.\n');
    process.exit(1);
  }
}

function isValidAdoOrgUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && Boolean(u.hostname);
  } catch {
    return false;
  }
}

// ─── Input helpers ────────────────────────────────────────────────────────────
/**
 * Escape a value for safe inclusion inside a WIQL string literal.
 * Single quotes are doubled per WIQL syntax.
 */
function wiqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Parse, validate and sanitize the comma-separated states query param.
 */
function parseStates(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('states parameter is required');
  }

  if (raw.length > 500) {
    throw new Error('states parameter is too long');
  }

  const states = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (states.length === 0) {
    throw new Error('At least one state is required');
  }

  if (states.length > 30) {
    throw new Error('Too many states; max is 30');
  }

  for (const s of states) {
    if (s.length > 100) {
      throw new Error(`State name too long: "${s.slice(0, 40)}…"`);
    }

    // Allows letters/digits/underscore via \w, whitespace, hyphen, and parentheses.
    if (!/^[\w\s\-()]+$/.test(s)) {
      throw new Error(`Invalid state name: "${s}"`);
    }
  }

  return states;
}

/**
 * Parse and clamp the max-items query param.
 */
function parseMax(raw) {
  const n = parseInt(raw || '200', 10);
  if (Number.isNaN(n) || n < 1) return 200;
  return Math.min(n, 500);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ─── Azure DevOps API helper ──────────────────────────────────────────────────
function adoRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      if (typeof url !== 'string' || !url.startsWith('https://')) {
        throw new Error(`Invalid ADO URL: ${url}`);
      }

      // Guard against accidentally pasting HTML-escaped URLs into source code.
      if (url.includes('&amp;')) {
        throw new Error(`Bad URL contains literal HTML entity &amp;: ${url}`);
      }

      const body = options.body || null;
      const token = Buffer.from(':' + ADO_PAT).toString('base64');
      const parsed = new URL(url);

      const reqOptions = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: (options.method || 'GET').toUpperCase(),
        headers: {
          Authorization: `Basic ${token}`,
          Accept: 'application/json',
          'User-Agent': 'wip-aging-tracker/2.0',
        },
      };

      if (adoAgent) {
        reqOptions.agent = adoAgent;
      }

      if (body) {
        reqOptions.headers['Content-Type'] = 'application/json';
        reqOptions.headers['Content-Length'] = Buffer.byteLength(body);
      }

      console.log('[ADO REQUEST]', {
        method: reqOptions.method,
        url,
        path: reqOptions.path,
      });

      const req = https.request(reqOptions, res => {
        const chunks = [];

        res.on('data', c => chunks.push(c));

        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');

          if (res.statusCode >= 400) {
            const parsedBody = safeJsonParse(responseBody);

            console.error('[ADO ERROR DETAILS]', {
              method: reqOptions.method,
              url,
              path: reqOptions.path,
              statusCode: res.statusCode,
              body: parsedBody || responseBody,
            });

            return reject(Object.assign(
              new Error(`Azure DevOps returned HTTP ${res.statusCode}`),
              {
                adoStatus: res.statusCode,
                adoBody: parsedBody || responseBody,
                adoUrl: url,
                adoMethod: reqOptions.method,
              }
            ));
          }

          const json = safeJsonParse(responseBody);
          if (!json) {
            return reject(Object.assign(
              new Error('Non-JSON response from Azure DevOps'),
              { adoBody: responseBody, adoUrl: url, adoMethod: reqOptions.method }
            ));
          }

          resolve(json);
        });
      });

      req.on('error', reject);

      req.setTimeout(15_000, () => {
        req.destroy(new Error('ADO request timed out'));
      });

      if (body) req.write(body);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

/**
 * GET /api/config
 * Returns non-sensitive display config to the frontend.
 * The PAT is NEVER included.
 */
app.get('/api/config', (_req, res) => {
  res.json({
    org: ADO_ORG,
    project: ADO_PROJECT,
    projectUrl: `${ADO_ORG}/${encodeURIComponent(ADO_PROJECT)}`,
  });
});

/**
 * GET /api/wip-aging?states=Active,In+Progress&max=200
 * Returns sanitized work item aging data.
 */
app.get('/api/wip-aging', async (req, res) => {
  let states;
  let maxItems;

  try {
    states = parseStates(req.query.states);
    maxItems = parseMax(req.query.max);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const stateList = states.map(wiqlString).join(', ');
    const projectToken = wiqlString(ADO_PROJECT);

    const wiql = [
      'SELECT [System.Id] FROM WorkItems',
      `WHERE [System.TeamProject] = ${projectToken}`,
      `AND [System.WorkItemType] IN ('User Story', 'Bug', 'Feature', 'Epic')`,
      `AND [System.State] IN (${stateList})`,
      'ORDER BY [System.ChangedDate] ASC',
    ].join(' ');

    const wiqlUrlObj = new URL(`${ADO_ORG}/${encodeURIComponent(ADO_PROJECT)}/_apis/wit/wiql`);
    wiqlUrlObj.searchParams.set('api-version', ADO_API_VERSION);
    wiqlUrlObj.searchParams.set('$top', String(maxItems));
    const wiqlUrl = wiqlUrlObj.toString();

    console.log('[WIQL]', wiql);
    console.log('[WIQL URL]', wiqlUrl);
    console.log('[WIQL URL HAS AMP ENTITY]', wiqlUrl.includes('&amp;'));

    const wiqlResult = await adoRequest(wiqlUrl, {
      method: 'POST',
      body: JSON.stringify({ query: wiql }),
    });

    const ids = (wiqlResult.workItems || []).map(w => w.id).filter(Boolean);
    if (ids.length === 0) {
      return res.json({ items: [], total: 0 });
    }

    // Use workitemsbatch instead of a long GET query string. This avoids URL-length,
    // comma-encoding, and query parsing problems on older/on-prem ADO/TFS servers.
    const FIELDS = [
      'System.Id',
      'System.Title',
      'System.WorkItemType',
      'System.State',
      'System.AssignedTo',
      'Microsoft.VSTS.Common.StateChangeDate',
      'System.ChangedDate',
      'System.AreaPath',
      'System.IterationPath',
      'Microsoft.VSTS.Common.Priority',
    ];

    const items = [];
    const BATCH = 200;

    for (let i = 0; i < ids.length; i += BATCH) {
      const chunkIds = ids.slice(i, i + BATCH);

      const detailsUrlObj = new URL(`${ADO_ORG}/${encodeURIComponent(ADO_PROJECT)}/_apis/wit/workitemsbatch`);
      detailsUrlObj.searchParams.set('api-version', ADO_API_VERSION);
      const detailsUrl = detailsUrlObj.toString();

      const details = await adoRequest(detailsUrl, {
        method: 'POST',
        body: JSON.stringify({
          ids: chunkIds,
          fields: FIELDS,
          errorPolicy: 'Omit',
        }),
      });

      const now = Date.now();

      for (const raw of details.value || []) {
        const f = raw.fields || {};
        const assignedTo = f['System.AssignedTo'];

        const assignedName = assignedTo
          ? (assignedTo.displayName || assignedTo.uniqueName || 'Unknown')
          : 'Unassigned';

        const stateChangeDate =
          f['Microsoft.VSTS.Common.StateChangeDate'] ||
          f['System.ChangedDate'] ||
          null;

        const parsedDate = stateChangeDate ? new Date(stateChangeDate).getTime() : NaN;
        const daysInState = Number.isFinite(parsedDate)
          ? Math.max(0, Math.floor((now - parsedDate) / 86_400_000))
          : 0;

        items.push({
          id: Number(f['System.Id'] || raw.id),
          title: String(f['System.Title'] || '(no title)'),
          type: String(f['System.WorkItemType'] || 'Unknown'),
          state: String(f['System.State'] || ''),
          assignedTo: String(assignedName),
          daysInState,
          stateChangedOn: stateChangeDate,
          area: String(f['System.AreaPath'] || ''),
          iteration: String(f['System.IterationPath'] || ''),
          priority: f['System.Priority'] != null ? Number(f['System.Priority']) : null,
        });
      }
    }

    res.json({ items, total: items.length });
  } catch (err) {
    console.error('[wip-aging] Error:', err.message);

    const adoStatus = err.adoStatus;
    let clientMessage;

    if (adoStatus === 401 || adoStatus === 403) {
      clientMessage = 'Azure DevOps authentication failed. Check your PAT has Work Items (Read) permission and has not expired.';
    } else if (adoStatus === 404) {
      clientMessage = 'Azure DevOps project/API endpoint not found. Check ADO_ORG and ADO_PROJECT.';
    } else if (err.message.includes('timed out')) {
      clientMessage = 'Request to Azure DevOps timed out. Check your network or org URL.';
    } else if (err.message.includes('certificate') || err.message.includes('issuer')) {
      clientMessage = 'TLS certificate validation failed. Use ADO_CA_CERT_PATH for your corporate CA, or ADO_INSECURE_TLS=true for local/dev only.';
    } else {
      clientMessage = 'Failed to fetch work items. Check the server terminal for ADO error details.';
    }

    res.status(500).json({ error: clientMessage });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
validateEnv();

app.listen(PORT, '127.0.0.1', () => {
  console.log('\n✅  WIP Aging Tracker');
  console.log(`    URL     : http://localhost:${PORT}`);
  console.log(`    Project : ${ADO_PROJECT}`);
  console.log(`    Org     : ${ADO_ORG}`);
  console.log(`    API     : ${ADO_API_VERSION}`);
  console.log(`    PAT     : ${'*'.repeat(8)} (loaded from environment)\n`);
});
