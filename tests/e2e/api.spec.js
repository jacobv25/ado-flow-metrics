// API contract: every route the pages depend on, plus input validation.
const { test, expect } = require('@playwright/test');

test.describe('/api', () => {
  test('config reports demo mode and a project link', async ({ request }) => {
    const cfg = await (await request.get('/api/config')).json();
    expect(cfg).toMatchObject({ demo: true, project: 'Demo Project' });
    expect(cfg.projectUrl).toContain(encodeURIComponent('Demo Project'));
  });

  test('wip-aging returns aged items with the fields the table renders', async ({ request }) => {
    const res = await request.get('/api/wip-aging?states=Active');
    expect(res.ok()).toBeTruthy();
    const { items, total } = await res.json();
    expect(total).toBe(items.length);
    expect(total).toBeGreaterThan(0);
    for (const i of items) {
      expect(i).toMatchObject({ id: expect.any(Number), title: expect.any(String), state: 'Active' });
      expect(i.daysInState).toBeGreaterThanOrEqual(0);
      expect(i.priority).not.toBeNull();            // regression: was always null before the field-name fix
      expect(Array.isArray(i.tags)).toBe(true);
    }
    expect(Math.max(...items.map(i => i.daysInState))).toBeGreaterThan(21); // stuck items exist
  });

  test('wip-aging rejects malformed state names', async ({ request }) => {
    const res = await request.get("/api/wip-aging?states=Active'%20OR%201=1");
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid state name/);
  });

  test('pr-aging derives review state from votes', async ({ request }) => {
    const { items, stalenessMode } = await (await request.get('/api/pr-aging?status=active')).json();
    expect(stalenessMode).toBe('off');
    const states = new Set(items.map(i => i.reviewState));
    for (const s of ['approved', 'awaiting', 'changes', 'rejected', 'draft', 'none']) expect(states).toContain(s);
    expect(items.filter(i => i.hasMergeConflict)).toHaveLength(1);
    expect(items.every(i => i.url.includes('/pullrequest/'))).toBe(true);
  });

  test('pr-aging rejects unknown status values', async ({ request }) => {
    expect((await request.get('/api/pr-aging?status=bogus')).status()).toBe(400);
  });

  test('pr-cycle-time returns a consistent count, average and median', async ({ request }) => {
    const r = await (await request.get('/api/pr-cycle-time?days=30')).json();
    expect(r.total).toBe(r.items.length);
    expect(r.total).toBeGreaterThan(0);
    expect(r.medianDays).toBeGreaterThanOrEqual(0);
    expect(r.days).toBe(30);
    expect((await request.get('/api/pr-cycle-time?days=31')).status()).toBe(400);
  });

  test('throughput buckets cover the window and include a detectable outlier week', async ({ request }) => {
    const r = await (await request.get('/api/throughput?days=84&interval=week')).json();
    expect(r.buckets.length).toBeGreaterThanOrEqual(12);
    expect(r.totalCompleted).toBe(r.buckets.reduce((s, b) => s + b.count, 0));
    expect(r.perInterval.max).toBeGreaterThan(r.perInterval.mean);
    expect(r.perInterval.min).toBe(0);                           // the holiday week
    const lean = await (await request.get('/api/throughput?days=84&interval=week&detail=0')).json();
    expect(lean.buckets[0]).not.toHaveProperty('items');
    expect((await request.get('/api/throughput?days=10')).status()).toBe(400);
  });

  test('wi-cycle-time percentiles are ordered', async ({ request }) => {
    const r = await (await request.get('/api/wi-cycle-time?days=84')).json();
    expect(r.total).toBeGreaterThan(0);
    expect(r.p50).toBeLessThanOrEqual(r.p85);
    expect(r.p85).toBeLessThanOrEqual(r.p95);
    expect(r.startField).toBe('ActivatedDate');
  });
});
