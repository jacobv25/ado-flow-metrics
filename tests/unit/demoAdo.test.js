/**
 * tests/unit/demoAdo.test.js
 * The demo fake must honour the parts of the Azure DevOps REST contract that
 * server.js relies on — otherwise demo mode would exercise different code
 * paths than a live org.
 */
import { describe, test, expect } from 'vitest';
import { demoRequest, WORK_ITEMS, PULL_REQUESTS, PEOPLE } from '../../lib/demoAdo.js';

const BASE = 'https://dev.azure.com/demo-org/Demo%20Project/_apis';
const wiql = (query, top = 2000) =>
  demoRequest(`${BASE}/wit/wiql?api-version=7.1&$top=${top}`, { method: 'POST', body: JSON.stringify({ query }) });
const batch = (ids, fields) =>
  demoRequest(`${BASE}/wit/workitemsbatch?api-version=7.1`, { method: 'POST', body: JSON.stringify({ ids, fields }) });

describe('synthetic dataset', () => {
  test('is deterministic across module loads', async () => {
    const again = await import('../../lib/demoAdo.js?reload=' + Date.now()).catch(() => null);
    // Same seed → same first few ids/titles (module cache may return the same object; either way equal)
    const first = WORK_ITEMS.slice(0, 5).map(w => w.title);
    expect(first).toEqual((again ? again.WORK_ITEMS : WORK_ITEMS).slice(0, 5).map(w => w.title));
  });
  test('has every state the dashboards expect, plus deliberately stuck items', () => {
    const states = new Set(WORK_ITEMS.map(w => w.state));
    expect([...states].sort()).toEqual(['Active', 'Closed', 'New', 'Resolved']);
    const stuck = WORK_ITEMS.filter(w => w.state === 'Active' && (Date.now() - w.activated) / 864e5 > 21);
    expect(stuck.length).toBeGreaterThanOrEqual(5);
  });
  test('assignees come only from the fictional team and use example.com addresses', () => {
    for (const w of WORK_ITEMS) if (w.assignee) expect(PEOPLE).toContain(w.assignee);
    for (const pr of PULL_REQUESTS) expect(pr.createdBy.uniqueName).toMatch(/@example\.com$/);
  });
});

describe('WIQL endpoint', () => {
  test('filters by state list and honours $top', async () => {
    const r = await wiql("SELECT [System.Id] FROM WorkItems WHERE [System.State] IN ('Active') ORDER BY [System.ChangedDate] ASC", 4);
    expect(r.workItems).toHaveLength(4);
    const byId = new Map(WORK_ITEMS.map(w => [w.id, w]));
    for (const { id } of r.workItems) expect(byId.get(id).state).toBe('Active');
  });
  test('filters by type and ClosedDate >= since, ordered by ClosedDate', async () => {
    const since = new Date(Date.now() - 28 * 864e5).toISOString().slice(0, 10);
    const r = await wiql(`SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] IN ('Bug') AND [System.State] IN ('Closed', 'Done', 'Resolved') AND [Microsoft.VSTS.Common.ClosedDate] >= '${since}T00:00:00Z' ORDER BY [Microsoft.VSTS.Common.ClosedDate] ASC`);
    const byId = new Map(WORK_ITEMS.map(w => [w.id, w]));
    const rows = r.workItems.map(x => byId.get(x.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const w of rows) {
      expect(w.type).toBe('Bug');
      expect(w.closed).toBeGreaterThanOrEqual(new Date(since).getTime());
    }
    for (let i = 1; i < rows.length; i++) expect(rows[i].closed).toBeGreaterThanOrEqual(rows[i - 1].closed);
  });
  test('escaped quotes in state names round-trip', async () => {
    const r = await wiql("SELECT [System.Id] FROM WorkItems WHERE [System.State] IN ('Won''t Fix')");
    expect(r.workItems).toEqual([]);
  });
});

describe('workitemsbatch endpoint', () => {
  test('returns only requested fields, omitting empty ones', async () => {
    const closed = WORK_ITEMS.find(w => w.state === 'Closed' && w.tags.length === 0);
    const r = await batch([closed.id], ['System.Id', 'System.Title', 'System.Tags', 'Microsoft.VSTS.Common.ClosedDate']);
    expect(r.value).toHaveLength(1);
    const f = r.value[0].fields;
    expect(Object.keys(f).sort()).toEqual(['Microsoft.VSTS.Common.ClosedDate', 'System.Id', 'System.Title']);
    expect(f['System.Id']).toBe(closed.id);
  });
  test('unknown ids are omitted, matching errorPolicy=Omit', async () => {
    const r = await batch([WORK_ITEMS[0].id, 1], ['System.Id']);
    expect(r.value.map(v => v.id)).toEqual([WORK_ITEMS[0].id]);
  });
  test('AssignedTo has the identity shape server.js reads', async () => {
    const w = WORK_ITEMS.find(x => x.assignee);
    const r = await batch([w.id], ['System.AssignedTo']);
    expect(r.value[0].fields['System.AssignedTo']).toEqual({ displayName: w.assignee, uniqueName: expect.stringMatching(/@example\.com$/) });
  });
});

describe('pullrequests endpoint', () => {
  const prs = q => demoRequest(`${BASE}/git/pullrequests?${q}&api-version=7.1`);
  test('status=active returns open PRs with every review state represented', async () => {
    const r = await prs('searchCriteria.status=active&$top=100');
    expect(r.value.every(p => p.status === 'active')).toBe(true);
    const votes = new Set(r.value.flatMap(p => p.reviewers.map(x => x.vote)));
    expect(votes).toEqual(new Set([10, 5, 0, -5, -10]));
    expect(r.value.some(p => p.isDraft)).toBe(true);
    expect(r.value.filter(p => p.mergeStatus === 'conflicts')).toHaveLength(1);
  });
  test('paginates with $top/$skip and never overlaps', async () => {
    const a = await prs('searchCriteria.status=completed&$top=30&$skip=0');
    const b = await prs('searchCriteria.status=completed&$top=30&$skip=30');
    expect(a.value).toHaveLength(30);
    const ids = new Set(a.value.map(p => p.pullRequestId));
    expect(b.value.some(p => ids.has(p.pullRequestId))).toBe(false);
  });
  test('minTime filters completed PRs by closedDate', async () => {
    const min = new Date(Date.now() - 30 * 864e5).toISOString();
    const r = await prs(`searchCriteria.status=completed&searchCriteria.queryTimeRangeType=closed&searchCriteria.minTime=${encodeURIComponent(min)}&$top=500`);
    expect(r.value.length).toBeGreaterThan(0);
    for (const p of r.value) expect(new Date(p.closedDate).getTime()).toBeGreaterThanOrEqual(new Date(min).getTime());
  });
});

test('unknown endpoints reject with an ADO-style 404', async () => {
  await expect(demoRequest(`${BASE}/build/builds`)).rejects.toMatchObject({ adoStatus: 404 });
});
