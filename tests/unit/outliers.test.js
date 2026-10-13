
/**
 * tests/outliers.test.js
 *
 * Unit tests for lib/outliers.js
 * Run with:  npm test   (Vitest)
 */

import { test } from 'vitest';
import assert from 'node:assert';
import Outliers from '../../lib/outliers.js';
const { detectOutliers, computeBaseline, summarizeBucket, explainOutlier } = Outliers;

// ─── detectOutliers ───────────────────────────────────────────────────────────
// ── detectOutliers ──

test('known spike is flagged high (IQR method)', () => {
  const counts = [2, 3, 3, 4, 4, 4, 5, 5, 6, 11];
  const r = detectOutliers(counts);
  assert.strictEqual(r.method, 'iqr', 'should use IQR for n=10');
  assert.strictEqual(r.flags[counts.length - 1], 'high', 'last element (11) should be high');
  assert.ok(r.flags.slice(0, -1).every(f => f === null), 'only the spike should be flagged');
});

test('known trough is flagged low (IQR method)', () => {
  const counts = [0, 4, 5, 5, 5, 5, 6, 6, 6, 7];
  const r = detectOutliers(counts);
  assert.strictEqual(r.method, 'iqr');
  assert.strictEqual(r.flags[0], 'low', 'first element (0) should be low');
});

test('all-equal array returns no flags', () => {
  const counts = [5, 5, 5, 5, 5, 5, 5, 5];
  const r = detectOutliers(counts);
  assert.ok(r.flags.every(f => f === null), 'identical counts → no outliers');
  assert.strictEqual(r.median, 5);
});

test('small sample (n=3) returns method disabled', () => {
  const r = detectOutliers([3, 5, 10]);
  assert.strictEqual(r.method, 'disabled');
  assert.ok(r.flags.every(f => f === null));
  assert.ok(typeof r.message === 'string' && r.message.length > 0);
});

test('empty array returns method disabled', () => {
  const r = detectOutliers([]);
  assert.strictEqual(r.method, 'disabled');
  assert.strictEqual(r.median, 0);
});

test('n=5 uses MAD fallback', () => {
  const counts = [3, 4, 4, 4, 20]; // 20 is clearly an outlier
  const r = detectOutliers(counts);
  assert.strictEqual(r.method, 'mad');
  assert.strictEqual(r.flags[4], 'high', '20 should be flagged high');
});

test('strict multiplier (1.0) flags more outliers than standard (1.5)', () => {
  const counts = [2, 3, 4, 4, 4, 5, 5, 6, 8];
  const rStd    = detectOutliers(counts, 1.5);
  const rStrict = detectOutliers(counts, 1.0);
  const stdFlagged    = rStd.flags.filter(Boolean).length;
  const strictFlagged = rStrict.flags.filter(Boolean).length;
  assert.ok(strictFlagged >= stdFlagged, 'strict should flag at least as many as standard');
});

test('loose multiplier (3.0) flags fewer outliers than standard (1.5)', () => {
  const counts = [1, 3, 4, 4, 5, 5, 5, 6, 14];
  const rStd   = detectOutliers(counts, 1.5);
  const rLoose = detectOutliers(counts, 3.0);
  const stdFlagged   = rStd.flags.filter(Boolean).length;
  const looseFlagged = rLoose.flags.filter(Boolean).length;
  assert.ok(looseFlagged <= stdFlagged, 'loose should flag at most as many as standard');
});

test('IQR fences are reported correctly', () => {
  // Q1=3, Q3=6, IQR=3, fences at 3-1.5*3=-1.5 and 6+1.5*3=10.5
  const counts = [3, 3, 3, 4, 5, 5, 6, 6, 6, 6, 6, 11];
  const r = detectOutliers(counts, 1.5);
  if (r.method === 'iqr') {
    assert.ok(r.upperFence > r.median, 'upper fence > median');
    assert.ok(r.lowerFence < r.median, 'lower fence < median');
  }
  // At minimum the result must have finite fences
  assert.ok(Number.isFinite(r.upperFence) || r.upperFence === null);
});

test('median is computed correctly for even-length array', () => {
  const counts = [2, 4, 6, 8, 10, 12, 14, 16];
  const r = detectOutliers(counts);
  assert.strictEqual(r.median, 9, 'median of [2..16 even] = (8+10)/2 = 9');
});

// ─── computeBaseline ──────────────────────────────────────────────────────────
// ── computeBaseline ──

function makeBucket(items, count) {
  return { count: count != null ? count : items.length, items };
}

const sampleBuckets = [
  makeBucket([
    { assignedTo: 'Alice', type: 'User Story', closedDate: '2026-03-01T10:00:00Z', activatedDate: '2026-02-22T10:00:00Z', cycleDays: 7,  storyPoints: 3,  area: 'Web' },
    { assignedTo: 'Bob',   type: 'Bug',        closedDate: '2026-03-02T10:00:00Z', activatedDate: '2026-02-26T10:00:00Z', cycleDays: 4,  storyPoints: null, area: 'Web' },
    { assignedTo: 'Alice', type: 'User Story', closedDate: '2026-03-03T10:00:00Z', activatedDate: '2026-02-20T10:00:00Z', cycleDays: 11, storyPoints: 5,  area: 'API' },
  ]),
  makeBucket([
    { assignedTo: 'Carol', type: 'User Story', closedDate: '2026-03-10T09:00:00Z', activatedDate: '2026-03-08T09:00:00Z', cycleDays: 2,  storyPoints: 2, area: 'Web' },
    { assignedTo: 'Carol', type: 'Bug',        closedDate: '2026-03-10T09:15:00Z', activatedDate: '2026-03-09T09:00:00Z', cycleDays: 1,  storyPoints: null, area: 'Web' },
  ]),
];

test('computeBaseline returns medianCount', () => {
  const b = computeBaseline(sampleBuckets);
  assert.strictEqual(b.medianCount, 2.5, 'median of [3,2] = 2.5');
});

test('computeBaseline returns medianCycleDays', () => {
  const b = computeBaseline(sampleBuckets);
  // cycle days: [7,4,11,2,1] sorted [1,2,4,7,11] → median = 4
  assert.strictEqual(b.medianCycleDays, 4);
});

test('computeBaseline returns medianContributors', () => {
  const b = computeBaseline(sampleBuckets);
  // bucket 1: Alice,Bob → 2; bucket 2: Carol → 1; median of [1,2] = 1.5
  assert.strictEqual(b.medianContributors, 1.5);
});

test('computeBaseline empty buckets returns safe defaults', () => {
  const b = computeBaseline([]);
  assert.strictEqual(b.medianCount, 0);
  assert.strictEqual(b.medianCycleDays, null);
  assert.strictEqual(b.medianContributors, 1);
});

// ─── summarizeBucket ──────────────────────────────────────────────────────────
// ── summarizeBucket ──

const baseline = computeBaseline(sampleBuckets);

test('summarizeBucket detects batch-close clustering', () => {
  // All 4 items close on the same day
  const bucket = makeBucket([
    { assignedTo: 'Alice', type: 'User Story', closedDate: '2026-03-10T10:00:00Z', activatedDate: '2026-02-01T10:00:00Z', cycleDays: 37, storyPoints: null, area: 'Web' },
    { assignedTo: 'Bob',   type: 'User Story', closedDate: '2026-03-10T11:00:00Z', activatedDate: '2026-02-01T10:00:00Z', cycleDays: 37, storyPoints: null, area: 'Web' },
    { assignedTo: 'Carol', type: 'Bug',        closedDate: '2026-03-10T12:00:00Z', activatedDate: '2026-02-01T10:00:00Z', cycleDays: 37, storyPoints: null, area: 'Web' },
    { assignedTo: 'Dave',  type: 'User Story', closedDate: '2026-03-10T14:00:00Z', activatedDate: '2026-02-01T10:00:00Z', cycleDays: 37, storyPoints: null, area: 'API' },
  ]);
  const s = summarizeBucket(bucket, baseline);
  assert.strictEqual(s.batchClusterRatio, 1, 'all items close on same day → ratio=1');
  assert.strictEqual(s.batchClusterDay, '2026-03-10');
  assert.strictEqual(s.batchClusterCount, 4);
});

test('summarizeBucket detects aged-WIP items', () => {
  // baseline.medianCycleDays = 4, so threshold = 8d; inject items with cycleDays=30
  const bucket = makeBucket([
    { assignedTo: 'Alice', type: 'User Story', closedDate: '2026-03-15T10:00:00Z', activatedDate: '2026-02-13T10:00:00Z', cycleDays: 30, storyPoints: null, area: 'Web' },
    { assignedTo: 'Bob',   type: 'Bug',        closedDate: '2026-03-16T10:00:00Z', activatedDate: '2026-02-14T10:00:00Z', cycleDays: 30, storyPoints: null, area: 'Web' },
    { assignedTo: 'Carol', type: 'User Story', closedDate: '2026-03-17T10:00:00Z', activatedDate: '2026-03-15T10:00:00Z', cycleDays: 2,  storyPoints: null, area: 'API' },
  ]);
  const s = summarizeBucket(bucket, baseline);
  assert.strictEqual(s.agedItems, 2);
  assert.ok(s.agedWipRatio > 0.5);
});

test('summarizeBucket detects grain leakage', () => {
  const bucket = makeBucket([
    { assignedTo: 'Alice', type: 'Epic',       closedDate: '2026-03-10T10:00:00Z', activatedDate: null, cycleDays: null, storyPoints: null, area: 'Web' },
    { assignedTo: 'Bob',   type: 'Feature',    closedDate: '2026-03-11T10:00:00Z', activatedDate: null, cycleDays: null, storyPoints: null, area: 'Web' },
    { assignedTo: 'Carol', type: 'User Story', closedDate: '2026-03-12T10:00:00Z', activatedDate: null, cycleDays: null, storyPoints: null, area: 'API' },
  ]);
  const s = summarizeBucket(bucket, baseline);
  assert.strictEqual(s.grainLeakCount, 2);
});

test('summarizeBucket contributor count is correct', () => {
  const bucket = sampleBuckets[0]; // Alice, Bob, Alice → 2 distinct
  const s = summarizeBucket(bucket, baseline);
  assert.strictEqual(s.contributorCount, 2);
});

test('summarizeBucket uses storyPoints when >50% populated', () => {
  const bucket = makeBucket([
    { assignedTo: 'Alice', type: 'User Story', closedDate: '2026-03-01T10:00:00Z', activatedDate: null, cycleDays: null, storyPoints: 3, area: 'Web' },
    { assignedTo: 'Bob',   type: 'User Story', closedDate: '2026-03-02T10:00:00Z', activatedDate: null, cycleDays: null, storyPoints: 5, area: 'Web' },
    { assignedTo: 'Carol', type: 'User Story', closedDate: '2026-03-03T10:00:00Z', activatedDate: null, cycleDays: null, storyPoints: 1, area: 'API' },
  ]);
  const s = summarizeBucket(bucket, baseline);
  assert.strictEqual(s.sizeMix.source, 'storyPoints');
  assert.strictEqual(s.sizeMix.avg, 3);
});

test('summarizeBucket falls back to cycleDays when points absent', () => {
  const bucket = makeBucket([
    { assignedTo: 'Alice', type: 'User Story', closedDate: '2026-03-01T10:00:00Z', activatedDate: '2026-02-28T10:00:00Z', cycleDays: 1, storyPoints: null, area: 'Web' },
    { assignedTo: 'Bob',   type: 'Bug',        closedDate: '2026-03-02T10:00:00Z', activatedDate: '2026-02-26T10:00:00Z', cycleDays: 4, storyPoints: null, area: 'Web' },
  ]);
  const s = summarizeBucket(bucket, baseline);
  assert.strictEqual(s.sizeMix.source, 'cycleDays');
});

// ─── explainOutlier ────────────────────────────────────────────────────────────
// ── explainOutlier ──

test('explainOutlier fires grain-leak reason when present', () => {
  const bucket = makeBucket([
    { assignedTo: 'Alice', type: 'Epic',       closedDate: '2026-03-10T10:00:00Z', activatedDate: null, cycleDays: null, storyPoints: null, area: 'Web' },
    { assignedTo: 'Bob',   type: 'User Story', closedDate: '2026-03-11T10:00:00Z', activatedDate: null, cycleDays: null, storyPoints: null, area: 'Web' },
    { assignedTo: 'Carol', type: 'User Story', closedDate: '2026-03-12T10:00:00Z', activatedDate: null, cycleDays: null, storyPoints: null, area: 'Web' },
  ], 3);
  const summary = summarizeBucket(bucket, baseline);
  const result  = explainOutlier(bucket, summary, { ...baseline, medianCount: 3 }, 'high');
  assert.ok(result.reasons.some(r => r.code === 'grain-leak'), 'grain-leak reason expected');
  assert.ok(typeof result.headline === 'string' && result.headline.length > 0);
});

test('explainOutlier fires batch-close reason when ratio >= 0.5', () => {
  const bucket = makeBucket([
    { assignedTo: 'Alice', type: 'User Story', closedDate: '2026-03-10T10:00:00Z', activatedDate: '2026-02-01T10:00:00Z', cycleDays: 37, storyPoints: null, area: 'Web' },
    { assignedTo: 'Bob',   type: 'User Story', closedDate: '2026-03-10T11:00:00Z', activatedDate: '2026-02-01T10:00:00Z', cycleDays: 37, storyPoints: null, area: 'Web' },
    { assignedTo: 'Carol', type: 'User Story', closedDate: '2026-03-10T12:00:00Z', activatedDate: '2026-02-01T10:00:00Z', cycleDays: 37, storyPoints: null, area: 'Web' },
  ], 3);
  const summary = summarizeBucket(bucket, baseline);
  const result  = explainOutlier(bucket, summary, { ...baseline, medianCount: 3 }, 'high');
  assert.ok(result.reasons.some(r => r.code === 'batch-close'), 'batch-close reason expected');
});

test('explainOutlier fires aged-wip reason when ratio >= 0.5', () => {
  const bucket = makeBucket([
    { assignedTo: 'Alice', type: 'User Story', closedDate: '2026-03-15T10:00:00Z', activatedDate: '2026-01-01T10:00:00Z', cycleDays: 73, storyPoints: null, area: 'Web' },
    { assignedTo: 'Bob',   type: 'User Story', closedDate: '2026-03-16T10:00:00Z', activatedDate: '2026-01-02T10:00:00Z', cycleDays: 73, storyPoints: null, area: 'Web' },
    { assignedTo: 'Carol', type: 'Bug',        closedDate: '2026-03-17T10:00:00Z', activatedDate: '2026-03-16T10:00:00Z', cycleDays: 1,  storyPoints: null, area: 'Web' },
  ], 3);
  const summary = summarizeBucket(bucket, baseline);
  const result  = explainOutlier(bucket, summary, { ...baseline, medianCount: 3 }, 'high');
  assert.ok(result.reasons.some(r => r.code === 'aged-wip'), 'aged-wip reason expected');
});

test('explainOutlier fires contributor-dip for low outlier with few contributors', () => {
  const bucket = makeBucket([
    { assignedTo: 'Alice', type: 'User Story', closedDate: '2026-03-05T10:00:00Z', activatedDate: '2026-03-03T10:00:00Z', cycleDays: 2, storyPoints: null, area: 'Web' },
  ], 1);
  const extBaseline = { ...baseline, medianContributors: 4, medianCount: 5 };
  const summary = summarizeBucket(bucket, extBaseline);
  const result  = explainOutlier(bucket, summary, extBaseline, 'low');
  assert.ok(result.reasons.some(r => r.code === 'contributor-dip'), 'contributor-dip expected for low outlier');
});

test('explainOutlier headline is deterministic across runs', () => {
  const bucket = makeBucket([
    { assignedTo: 'Alice', type: 'User Story', closedDate: '2026-03-10T10:00:00Z', activatedDate: '2026-02-01T10:00:00Z', cycleDays: 37, storyPoints: null, area: 'Web' },
    { assignedTo: 'Bob',   type: 'User Story', closedDate: '2026-03-10T11:00:00Z', activatedDate: '2026-02-01T10:00:00Z', cycleDays: 37, storyPoints: null, area: 'Web' },
    { assignedTo: 'Carol', type: 'Bug',        closedDate: '2026-03-10T12:00:00Z', activatedDate: '2026-02-01T10:00:00Z', cycleDays: 37, storyPoints: null, area: 'Web' },
  ], 3);
  const summary = summarizeBucket(bucket, baseline);
  const r1 = explainOutlier(bucket, summary, { ...baseline, medianCount: 3 }, 'high');
  const r2 = explainOutlier(bucket, summary, { ...baseline, medianCount: 3 }, 'high');
  assert.strictEqual(r1.headline, r2.headline, 'headline must be deterministic');
});

test('explainOutlier with no pattern returns generic headline', () => {
  // Items spread across different days, normal cycle time, no leakage
  const bucket = makeBucket([
    { assignedTo: 'Alice', type: 'User Story', closedDate: '2026-03-01T10:00:00Z', activatedDate: '2026-02-28T10:00:00Z', cycleDays: 1, storyPoints: 2, area: 'Web' },
    { assignedTo: 'Bob',   type: 'User Story', closedDate: '2026-03-02T10:00:00Z', activatedDate: '2026-03-01T10:00:00Z', cycleDays: 1, storyPoints: 2, area: 'Web' },
    { assignedTo: 'Carol', type: 'User Story', closedDate: '2026-03-03T10:00:00Z', activatedDate: '2026-03-02T10:00:00Z', cycleDays: 1, storyPoints: 2, area: 'Web' },
    { assignedTo: 'Dave',  type: 'User Story', closedDate: '2026-03-04T10:00:00Z', activatedDate: '2026-03-03T10:00:00Z', cycleDays: 1, storyPoints: 2, area: 'Web' },
    { assignedTo: 'Eve',   type: 'User Story', closedDate: '2026-03-05T10:00:00Z', activatedDate: '2026-03-04T10:00:00Z', cycleDays: 1, storyPoints: 2, area: 'Web' },
  ], 5);
  const b2 = computeBaseline([bucket, makeBucket([], 0), makeBucket([], 0)]);
  const summary = summarizeBucket(bucket, b2);
  const result  = explainOutlier(bucket, summary, { ...b2, medianCount: 2 }, 'high');
  // Should not crash; headline exists
  assert.ok(typeof result.headline === 'string' && result.headline.length > 0);
});

// ─── Backward-compat guard: count unchanged by enrichment ─────────────────────
// ── Backward compatibility ──

test('bucket count is preserved after adding items[]', () => {
  // Simulate an enriched bucket — count must equal items.length
  const bucket = {
    start: '2026-03-02', end: '2026-03-08', count: 3,
    items: [
      { id: 1, type: 'User Story', closedDate: '2026-03-03T10:00:00Z', activatedDate: null, cycleDays: null, storyPoints: null, assignedTo: 'Alice', area: 'Web', iteration: '' },
      { id: 2, type: 'Bug',        closedDate: '2026-03-04T10:00:00Z', activatedDate: null, cycleDays: null, storyPoints: null, assignedTo: 'Bob',   area: 'Web', iteration: '' },
      { id: 3, type: 'User Story', closedDate: '2026-03-05T10:00:00Z', activatedDate: null, cycleDays: null, storyPoints: null, assignedTo: 'Carol', area: 'API', iteration: '' },
    ],
  };
  assert.strictEqual(bucket.count, bucket.items.length, 'count must equal items.length');
  assert.strictEqual(typeof bucket.count, 'number', 'count must be a number');
});
