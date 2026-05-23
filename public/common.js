/* common.js — shared utilities for index.html and prs.html */
'use strict';

// ─── HTML escaping ────────────────────────────────────────────────────────────
/**
 * Escape a string for safe insertion into HTML attribute or text content.
 * Uses DOM text-node trick so we never manually list entities.
 */
function esc(str) {
  const el = document.createElement('span');
  el.textContent = String(str);
  return el.innerHTML;
}

// ─── Avatar helpers ───────────────────────────────────────────────────────────
function initials(name) {
  if (!name || name === 'Unassigned' || name === 'Unknown') return '?';
  return name.split(/\s+/).map(p => p[0] || '').join('').slice(0, 2).toUpperCase();
}

function nameToHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h) % 360;
}

// ─── Date formatting ──────────────────────────────────────────────────────────
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Age-band logic ───────────────────────────────────────────────────────────
/**
 * Assign a colour band to a number of days, given three thresholds [t1,t2,t3].
 * Returns { idx, cls, label, emoji, color }
 */
function ageBand(days, thresholds) {
  const [t1, t2, t3] = thresholds;
  if (days <= t1) return { idx: 0, cls: 'age-0', label: 'On Track', emoji: '🟢', color: 'var(--green)'  };
  if (days <= t2) return { idx: 1, cls: 'age-1', label: 'Watch',    emoji: '🟡', color: 'var(--yellow)' };
  if (days <= t3) return { idx: 2, cls: 'age-2', label: 'At Risk',  emoji: '🟠', color: 'var(--orange)' };
  return               { idx: 3, cls: 'age-3', label: 'Critical', emoji: '🔴', color: 'var(--red)'    };
}

// ─── Fetch helper ─────────────────────────────────────────────────────────────
async function apiFetch(url) {
  const res  = await fetch(url);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `Server error ${res.status}`);
  return json;
}

// ─── UI helpers shared across pages ──────────────────────────────────────────
function setLoading(on, msg) {
  document.getElementById('loadingOverlay').classList.toggle('on', on);
  document.getElementById('refreshSpinner').classList.toggle('on', on);
  document.getElementById('refreshBtn').disabled = on;
  if (msg) document.getElementById('loadingMsg').textContent = msg;
}

function showError(msg) {
  const el = document.getElementById('errorBanner');
  el.textContent = '⚠️ ' + msg;
  el.classList.add('on');
}

function hideError() {
  document.getElementById('errorBanner').classList.remove('on');
}

function setStatusDot(state) {
  const el = document.getElementById('statusDot');
  el.className = 'status-dot' + (state === 'ok' ? ' ok' : state === 'err' ? ' err' : '');
}

// ─── Server config loader ─────────────────────────────────────────────────────
async function loadServerConfig() {
  try {
    const cfg   = await apiFetch('/api/config');
    const strip = document.getElementById('serverStrip');
    strip.classList.add('visible');
    document.getElementById('serverProjectLabel').innerHTML =
      `Project: <a href="${esc(cfg.projectUrl)}" target="_blank" rel="noopener">${esc(cfg.project)}</a>`;
    document.getElementById('topProject').textContent = `· ${cfg.project}`;
    setStatusDot('ok');
    return cfg;
  } catch {
    setStatusDot('err');
    return null;
  }
}

// ─── Settings panel toggle ────────────────────────────────────────────────────
let _settingsOpen = false;

function toggleSettings() {
  _settingsOpen = !_settingsOpen;
  document.getElementById('settingsBody').classList.toggle('hidden', !_settingsOpen);
  document.getElementById('settingsFooter').style.display = _settingsOpen ? '' : 'none';
  document.getElementById('settingsToggle').textContent   = _settingsOpen ? '▲ Hide' : '▼ Show';
}

function collapseSettings() {
  _settingsOpen = false;
  document.getElementById('settingsBody').classList.add('hidden');
  document.getElementById('settingsFooter').style.display = 'none';
  document.getElementById('settingsToggle').textContent   = '▼ Show';
}

// ─── Pagination builder ───────────────────────────────────────────────────────
/**
 * Render pagination controls into `pageBtnsEl`.
 * @param {HTMLElement} pageBtnsEl
 * @param {number} currentPage
 * @param {number} totalPages
 * @param {function} goPageFn  called with target page number
 */
function buildPaginationButtons(pageBtnsEl, currentPage, totalPages, goPageFn) {
  const btnEls  = [];
  const maxBtns = 5;

  const prevBtn = document.createElement('button');
  prevBtn.className   = 'page-btn';
  prevBtn.textContent = '← Prev';
  prevBtn.disabled    = currentPage === 1;
  prevBtn.onclick     = () => goPageFn(currentPage - 1);
  btnEls.push(prevBtn);

  let startP = Math.max(1, currentPage - Math.floor(maxBtns / 2));
  let endP   = Math.min(totalPages, startP + maxBtns - 1);
  if (endP - startP < maxBtns - 1) startP = Math.max(1, endP - maxBtns + 1);

  for (let p = startP; p <= endP; p++) {
    const pb = document.createElement('button');
    pb.className   = 'page-btn' + (p === currentPage ? ' active' : '');
    pb.textContent = String(p);
    const pp = p;
    pb.onclick = () => goPageFn(pp);
    btnEls.push(pb);
  }

  const nextBtn = document.createElement('button');
  nextBtn.className   = 'page-btn';
  nextBtn.textContent = 'Next →';
  nextBtn.disabled    = currentPage === totalPages;
  nextBtn.onclick     = () => goPageFn(currentPage + 1);
  btnEls.push(nextBtn);

  pageBtnsEl.replaceChildren(...btnEls);
}
