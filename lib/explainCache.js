'use strict';

// Small in-memory cache for "Explain with AI" results.
//
// The same three outlier weeks get clicked many times, and every click used to
// be a fresh model call. The key is a hash of the exact request payload plus
// the model name, so a changed number, a changed window, or a model switch is
// a miss, and an identical click is free. Entries expire after `ttlMs` and the
// map is capped at `max` entries (oldest evicted first).

const crypto = require('crypto');

/** JSON with keys sorted at every level, so key order never affects the hash. */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function keyFor(payload, model) {
  return crypto.createHash('sha256').update(String(model) + '\n' + canonical(payload)).digest('hex');
}

function createCache({ ttlMs = 24 * 60 * 60 * 1000, max = 200, now = Date.now } = {}) {
  const entries = new Map(); // key -> { value, expires }

  function get(key) {
    const e = entries.get(key);
    if (!e) return undefined;
    if (e.expires <= now()) { entries.delete(key); return undefined; }
    return e.value;
  }
  function set(key, value) {
    if (entries.has(key)) entries.delete(key); // re-insert so it becomes newest
    entries.set(key, { value, expires: now() + ttlMs });
    while (entries.size > max) entries.delete(entries.keys().next().value);
  }
  return { get, set, delete: k => entries.delete(k), clear: () => entries.clear(), get size() { return entries.size; } };
}

module.exports = { createCache, keyFor, canonical };
