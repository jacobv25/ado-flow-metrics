'use strict';

/**
 * lib/adoClient.js
 *
 * Shared Azure DevOps HTTP helper.
 * All ADO traffic in this app goes through `adoRequest()`.
 * The PAT is read once from the environment at module load time and never
 * leaves the server process.
 */

const https = require('https');
const fs    = require('fs');

const ADO_PAT         = process.env.ADO_PAT         || '';
const ADO_API_VERSION = process.env.ADO_API_VERSION  || '7.1';

// ─── TLS agent ───────────────────────────────────────────────────────────────
/**
 * Optional TLS settings (env-driven):
 *   ADO_INSECURE_TLS=true          disables cert validation — dev/local only
 *   ADO_CA_CERT_PATH=/path/ca.pem  trusts your corporate/internal CA
 */
function buildHttpsAgent() {
  if (process.env.ADO_INSECURE_TLS === 'true') {
    console.warn(
      '[adoClient] WARNING: TLS certificate validation is disabled. ' +
      'Use only for local/dev testing.'
    );
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ─── Core request helper ──────────────────────────────────────────────────────
/**
 * Make an authenticated HTTPS request to Azure DevOps.
 *
 * @param {string} url     Full HTTPS URL (must start with https://)
 * @param {object} options { method?, body? (JSON string) }
 * @returns {Promise<object>} Parsed JSON response body
 */
function adoRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      if (typeof url !== 'string' || !url.startsWith('https://')) {
        throw new Error(`Invalid ADO URL: ${url}`);
      }

      // Guard against accidentally HTML-escaped URLs in source code.
      if (url.includes('&amp;')) {
        throw new Error(`Bad URL contains literal HTML entity &amp;: ${url}`);
      }

      const body   = options.body || null;
      const token  = Buffer.from(':' + ADO_PAT).toString('base64');
      const parsed = new URL(url);

      const reqOptions = {
        hostname: parsed.hostname,
        port:     parsed.port || 443,
        path:     parsed.pathname + parsed.search,
        method:   (options.method || 'GET').toUpperCase(),
        headers: {
          Authorization:  `Basic ${token}`,
          Accept:         'application/json',
          'User-Agent':   'wip-aging-tracker/2.0',
        },
      };

      if (adoAgent) {
        reqOptions.agent = adoAgent;
      }

      if (body) {
        reqOptions.headers['Content-Type']   = 'application/json';
        reqOptions.headers['Content-Length'] = Buffer.byteLength(body);
      }

      console.log('[ADO REQUEST]', { method: reqOptions.method, url });

      const req = https.request(reqOptions, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');

          if (res.statusCode >= 400) {
            const parsedBody = safeJsonParse(responseBody);
            console.error('[ADO ERROR]', {
              method: reqOptions.method, url,
              statusCode: res.statusCode,
              body: parsedBody || responseBody,
            });
            return reject(Object.assign(
              new Error(`Azure DevOps returned HTTP ${res.statusCode}`),
              {
                adoStatus: res.statusCode,
                adoBody:   parsedBody || responseBody,
                adoUrl:    url,
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

// ─── Exports ─────────────────────────────────────────────────────────────────
module.exports = {
  adoRequest,
  ADO_API_VERSION,
};
