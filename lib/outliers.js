'use strict';

/**
 * lib/outliers.js
 *
 * Pure, dependency-free UMD module for throughput outlier detection and attribution.
 * Works in Node.js (CommonJS require) and in the browser (UMD global → window.Outliers).
 *
 * EXPORTS
 *   detectOutliers(counts, multiplier?)
 *     → { median, q1, q3, iqr, lowerFence, upperFence, method, flags[], message? }
 *     flags[i] = 'high' | 'low' | null   (one per bucket)
 *     method   = 'iqr' | 'mad' | 'disabled'
 *
 *   computeBaseline(buckets)
 *     → { medianCount, medianCycleDays, typeBaseline[], medianContributors, avgPointsBaseline }
 *     Aggregates attribution stats across ALL buckets for comparison.
 *
 *   summarizeBucket(bucket, baseline)
 *     → { typeMix[], sizeMix, contributorCount, areaCount,
 *         batchClusterCount, batchClusterDay, batchClusterRatio,
 *         agedWipRatio, agedItems, grainLeakCount, itemCount }
 *
 *   explainOutlier(bucket, summary, baseline, flag)
 *     → { headline, reasons[] }
 *     headline  = deterministic one-line narrative
 *     reasons[] = [{ code, detail }, …] ordered Tier-1 → Tier-2
 *
 * DETECTION STRATEGY
 *   - n >= 7 data points → Tukey IQR fence (recommended for flow data)
 *   - n 4–6              → MAD (modified z-score) fallback
 *   - n < 4              → disabled, returns flags of null
 *   The IQR multiplier (default 1.5) is the standard sensitivity; pass 1.0 for
 *   strict or 3.0 for loose flagging.
 *
 * TESTING
 *   detectOutliers([2,3,3,4,4,4,5,5,6,11]) with default multiplier should flag 11 'high'.
 *   detectOutliers([5,5,5,5]) should return all null flags (no outliers).
 *   detectOutliers([1,2]) should return method 'disabled'.
 */

// ─── Core statistics ───────────────────────────────────────────────────────────

/** Median of a pre-sorted ascending array. */
function _median(sortedArr) {
  const n = sortedArr.length;
  if (!n) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedArr[mid - 1] + sortedArr[mid]) / 2 : sortedArr[mid];
}

/**
 * Nearest-rank percentile of a pre-sorted ascending array.
 * @param {number[]} sortedArr
 * @param {number}   p  Percentile 0–100.
 */
function _pct(sortedArr, p) {
  if (!sortedArr.length) return 0;
  if (p <= 0)   return sortedArr[0];
  if (p >= 100) return sortedArr[sortedArr.length - 1];
  return sortedArr[Math.min(Math.floor((p / 100) * sortedArr.length), sortedArr.length - 1)];
}

// ─── detectOutliers ────────────────────────────────────────────────────────────

/**
 * Detect outlier buckets using the Tukey IQR fence (primary) or MAD (fallback).
 *
 * @param {number[]} counts      One count per bucket (may contain zeros).
 * @param {number}   [multiplier=1.5]  IQR fence multiplier (1.0 = strict, 3.0 = loose).
 * @returns {{ median, q1, q3, iqr, lowerFence, upperFence, method, flags[], message? }}
 */
function detectOutliers(counts, multiplier) {
  if (multiplier == null) multiplier = 1.5;

  const n = counts ? counts.length : 0;

  // Fewer than 4 buckets: detection meaningless — disable gracefully
  if (n < 4) {
    const sorted = n ? [...counts].sort((a, b) => a - b) : [];
    return {
      median: n ? _median(sorted) : 0,
      q1: null, q3: null, iqr: null,
      lowerFence: null, upperFence: null,
      method: 'disabled',
      flags: counts ? counts.map(() => null) : [],
      message: 'Not enough history to flag outliers (need at least 4 data points).',
    };
  }

  const sorted = [...counts].sort((a, b) => a - b);
  const med    = _median(sorted);

  // ── IQR method (n >= 7 and IQR > 0) ───────────────────────────────────────
  if (n >= 7) {
    const q1  = _pct(sorted, 25);
    const q3  = _pct(sorted, 75);
    const iqr = q3 - q1;

    if (iqr > 0) {
      const lower = q1 - multiplier * iqr;
      const upper = q3 + multiplier * iqr;
      return {
        median: med, q1, q3, iqr,
        lowerFence: lower, upperFence: upper,
        method: 'iqr',
        flags: counts.map(c => c > upper ? 'high' : c < lower ? 'low' : null),
      };
    }
  }

  // ── MAD fallback (n 4–6, or IQR === 0) ────────────────────────────────────
  const deviations = sorted.map(c => Math.abs(c - med)).sort((a, b) => a - b);
  const mad        = _median(deviations);

  // Scale modified-z threshold proportionally with the multiplier.
  // Standard: multiplier 1.5 ↔ modified-z threshold 3.5
  const modZThreshold = 3.5 * (multiplier / 1.5);

  if (mad === 0) {
    // More than half the values equal the median (modal data).
    // Fall back to the minimum non-zero deviation as the effective MAD,
    // which correctly flags extreme values while respecting the central cluster.
    const nonZeroDevs = deviations.filter(d => d > 0); // already sorted asc
    if (!nonZeroDevs.length) {
      // Truly all values identical — no outliers
      return {
        median: med, q1: null, q3: null, iqr: null,
        lowerFence: null, upperFence: null,
        method: 'mad',
        flags: counts.map(() => null),
      };
    }
    // Use the smallest non-zero deviation as the effective MAD
    const effectiveMad = nonZeroDevs[0];
    const spreadNZ = modZThreshold * effectiveMad / 0.6745;
    const lowerNZ  = med - spreadNZ;
    const upperNZ  = med + spreadNZ;
    return {
      median: med, q1: null, q3: null, iqr: null,
      lowerFence: lowerNZ, upperFence: upperNZ,
      method: 'mad',
      flags: counts.map(c => c > upperNZ ? 'high' : c < lowerNZ ? 'low' : null),
    };
  }

  // |0.6745*(x - median)/MAD| > modZThreshold  ↔  |x - median| > modZThreshold * MAD / 0.6745
  const spread = modZThreshold * mad / 0.6745;
  const lower  = med - spread;
  const upper  = med + spread;

  return {
    median: med, q1: null, q3: null, iqr: null,
    lowerFence: lower, upperFence: upper,
    method: 'mad',
    flags: counts.map(c => c > upper ? 'high' : c < lower ? 'low' : null),
  };
}

// ─── computeBaseline ──────────────────────────────────────────────────────────

/**
 * Aggregate attribution stats across ALL buckets for comparison.
 * Accepts the enriched buckets array from /api/throughput.
 *
 * @param  {Array}  buckets  Enriched bucket objects with items[].
 * @returns {{ medianCount, medianCycleDays, typeBaseline, medianContributors, avgPointsBaseline }}
 */
function computeBaseline(buckets) {
  if (!buckets || !buckets.length) {
    return {
      medianCount: 0, medianCycleDays: null,
      typeBaseline: [], medianContributors: 1, avgPointsBaseline: null,
    };
  }

  // Median bucket count
  const sortedCounts = buckets.map(b => b.count).sort((a, b) => a - b);
  const medianCount  = _median(sortedCounts);

  const allItems = buckets.flatMap(b => b.items || []);

  // Median cycle days across all items with a valid ActivatedDate
  const cycleTimes = allItems
    .filter(i => i.cycleDays != null && i.cycleDays >= 0)
    .map(i => i.cycleDays)
    .sort((a, b) => a - b);
  const medianCycleDays = cycleTimes.length ? _median(cycleTimes) : null;

  // Type fractions across all items
  const typeCounts = {};
  for (const item of allItems) {
    const t = item.type || 'Unknown';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  const total = allItems.length;
  const typeBaseline = Object.entries(typeCounts).map(([type, count]) => ({
    type, count, fraction: total > 0 ? count / total : 0,
  }));

  // Median distinct-contributor count per non-empty bucket
  const contribPerBucket = buckets
    .filter(b => (b.items || []).length > 0)
    .map(b => new Set((b.items || []).map(i => i.assignedTo).filter(Boolean)).size)
    .sort((a, b) => a - b);
  const medianContributors = contribPerBucket.length ? _median(contribPerBucket) : 1;

  // Baseline average story points (only if >50% of items have them)
  const withPoints    = allItems.filter(i => i.storyPoints != null);
  const avgPointsBaseline = (total > 0 && withPoints.length / total > 0.5)
    ? withPoints.reduce((s, i) => s + i.storyPoints, 0) / withPoints.length
    : null;

  return { medianCount, medianCycleDays, typeBaseline, medianContributors, avgPointsBaseline };
}

// ─── summarizeBucket ──────────────────────────────────────────────────────────

/**
 * Compute all six attribution dimensions for a single bucket.
 *
 * @param  {{ items[] }} bucket    Enriched bucket object.
 * @param  {object}      baseline  From computeBaseline().
 * @returns {object}  Attribution summary.
 */
function summarizeBucket(bucket, baseline) {
  const items = bucket.items || [];
  const n     = items.length;

  // ── C1: Batch-close clustering ─────────────────────────────────────────────
  // Group items by close-day; report the busiest day's share.
  const dayMap = {};
  for (const item of items) {
    const day = item.closedDate ? item.closedDate.slice(0, 10) : 'unknown';
    dayMap[day] = (dayMap[day] || 0) + 1;
  }
  const dayEntries        = Object.entries(dayMap).sort((a, b) => b[1] - a[1]);
  const maxCloseDay       = dayEntries[0];
  const batchClusterCount = maxCloseDay ? maxCloseDay[1] : 0;
  const batchClusterDay   = maxCloseDay ? maxCloseDay[0] : null;
  const batchClusterRatio = n > 0 ? batchClusterCount / n : 0;

  // ── C2: Aged-WIP flush ─────────────────────────────────────────────────────
  // Flag items whose cycle time is > 2× the overall median.
  const withCycleDays  = items.filter(i => i.cycleDays != null && i.cycleDays >= 0);
  const agedThreshold  = baseline.medianCycleDays != null ? baseline.medianCycleDays * 2 : null;
  const agedItemsList  = agedThreshold != null
    ? withCycleDays.filter(i => i.cycleDays > agedThreshold)
    : [];
  const agedWipRatio   = withCycleDays.length > 0 ? agedItemsList.length / withCycleDays.length : 0;

  // ── C3: Grain leakage ──────────────────────────────────────────────────────
  // Count items whose type indicates they are not Story/Bug-level.
  const grainLeakItems = items.filter(i => /epic|feature/i.test(i.type || ''));
  const grainLeakCount = grainLeakItems.length;

  // ── C4: Work-item-type mix ─────────────────────────────────────────────────
  const typeCounts = {};
  for (const item of items) {
    const t = item.type || 'Unknown';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  const typeMix = Object.entries(typeCounts).map(([type, count]) => ({
    type, count, fraction: n > 0 ? count / n : 0,
  }));

  // ── C5: Size mix ───────────────────────────────────────────────────────────
  // Use StoryPoints if >50% populated; fall back to cycle-time as a size proxy.
  const withPoints  = items.filter(i => i.storyPoints != null);
  const hasPoints   = n > 0 && withPoints.length / n > 0.5;
  let sizeMix;
  if (hasPoints) {
    const avg = withPoints.reduce((s, i) => s + i.storyPoints, 0) / withPoints.length;
    sizeMix = { source: 'storyPoints', avg: parseFloat(avg.toFixed(1)), populated: withPoints.length };
  } else {
    const withCT = withCycleDays;
    const avg    = withCT.length > 0
      ? withCT.reduce((s, i) => s + i.cycleDays, 0) / withCT.length
      : null;
    sizeMix = {
      source:    'cycleDays',
      avg:       avg != null ? parseFloat(avg.toFixed(1)) : null,
      populated: withCT.length,
    };
  }

  // ── C6: Contributor / area mix ─────────────────────────────────────────────
  const contributors  = new Set(items.map(i => i.assignedTo).filter(Boolean));
  const areas         = new Set(items.map(i => i.area).filter(Boolean));
  const contributorCount = contributors.size;
  const areaCount        = areas.size;

  return {
    itemCount: n,
    typeMix,
    sizeMix,
    contributorCount,
    areaCount,
    batchClusterCount,
    batchClusterDay,
    batchClusterRatio,
    agedWipRatio,
    agedItems: agedItemsList.length,
    grainLeakCount,
  };
}

// ─── explainOutlier ────────────────────────────────────────────────────────────

/**
 * Generate a deterministic rule-based explanation for a flagged bucket.
 * Reasons are ordered Tier-1 (artifact) → Tier-2 (composition).
 *
 * @param  {object}  bucket    Enriched bucket.
 * @param  {object}  summary   From summarizeBucket().
 * @param  {object}  baseline  From computeBaseline().
 * @param  {string}  flag      'high' | 'low'
 * @returns {{ headline, reasons[] }}
 */
function explainOutlier(bucket, summary, baseline, flag) {
  const n      = summary.itemCount;
  const median = baseline.medianCount || 1;
  const ratio  = n > 0 ? (n / median).toFixed(1) : '0';

  const reasons = [];

  // ── Tier 1: Artifact detectors ─────────────────────────────────────────────

  // C3: Grain leakage — hardest data error, mention first
  if (summary.grainLeakCount > 0) {
    reasons.push({
      code:   'grain-leak',
      detail: `${summary.grainLeakCount} item${summary.grainLeakCount > 1 ? 's are' : ' is'} of type Epic/Feature — ` +
              `these are not comparable to Stories/Bugs and inflate the count.`,
    });
  }

  // C1: Batch-close clustering (only meaningful for high-count weeks)
  if (n >= 3 && summary.batchClusterRatio >= 0.5) {
    const day = summary.batchClusterDay || 'one day';
    reasons.push({
      code:   'batch-close',
      detail: `${summary.batchClusterCount} of ${n} item${n !== 1 ? 's' : ''} closed on ${day} — ` +
              `likely a batch status update rather than steady-flow delivery.`,
    });
  }

  // C2: Aged-WIP flush
  if (summary.agedWipRatio >= 0.5 && summary.agedItems >= 2) {
    reasons.push({
      code:   'aged-wip',
      detail: `${summary.agedItems} of ${summary.itemCount} item${summary.agedItems !== 1 ? 's' : ''} ` +
              `had unusually long cycle times (>2× the median of ${
                baseline.medianCycleDays != null ? baseline.medianCycleDays + 'd' : 'normal'
              }) — likely an aged-WIP backlog flush.`,
    });
  }

  // ── Tier 2: Composition breakdowns ────────────────────────────────────────

  // C6: Contributor dip (mainly meaningful for low outliers)
  if (
    flag === 'low' &&
    baseline.medianContributors > 1 &&
    summary.contributorCount < baseline.medianContributors * 0.6
  ) {
    reasons.push({
      code:   'contributor-dip',
      detail: `Only ${summary.contributorCount} contributor${summary.contributorCount !== 1 ? 's' : ''} active ` +
              `vs. the usual ~${Math.round(baseline.medianContributors)} — ` +
              `capacity may have been reduced (holidays, PTO, or competing priorities).`,
    });
  }

  // C4: Type-mix shift (Bug fraction)
  const bucketBugFrac   = (summary.typeMix.find(t => /bug/i.test(t.type)) || { fraction: 0 }).fraction;
  const baselineBugFrac = (baseline.typeBaseline.find(t => /bug/i.test(t.type)) || { fraction: 0 }).fraction;
  if (Math.abs(bucketBugFrac - baselineBugFrac) > 0.3) {
    const dir = bucketBugFrac > baselineBugFrac ? 'higher' : 'lower';
    reasons.push({
      code:   'type-mix',
      detail: `Bug completion rate is ${dir} than usual ` +
              `(${Math.round(bucketBugFrac * 100)}% vs. ${Math.round(baselineBugFrac * 100)}% baseline) — ` +
              `this ${flag === 'high' ? 'boosted' : 'reduced'} the count.`,
    });
  }

  // C5: Size/cycle-time shift
  if (summary.sizeMix.avg != null && baseline.medianCycleDays != null) {
    if (summary.sizeMix.source === 'cycleDays') {
      const avgCT = summary.sizeMix.avg;
      if (
        flag === 'high' && avgCT < baseline.medianCycleDays * 0.5 ||
        flag === 'low'  && avgCT > baseline.medianCycleDays * 2
      ) {
        const dir = avgCT < baseline.medianCycleDays ? 'shorter' : 'longer';
        reasons.push({
          code:   'size-shift',
          detail: `Average cycle time this week (${avgCT}d) is ${dir} than the overall median ` +
                  `(${baseline.medianCycleDays}d) — items were ${avgCT < baseline.medianCycleDays ? 'smaller' : 'larger'} than usual.`,
        });
      }
    }
  }

  // ── Build headline ────────────────────────────────────────────────────────
  let headline;
  if (reasons.length === 0) {
    if (flag === 'high') {
      headline = `${n} items completed — ${ratio}× the median. No specific pattern detected; ` +
                 `check team calendar for holidays, PTO, or sprint-end effects.`;
    } else {
      headline = 'Only ' + n + ' items completed. No specific pattern detected; ' +
                 'check for holidays, PTO, or carry-over from a prior week.';
    }
  } else {
    // Lead with the first (highest-priority) reason
    headline = reasons[0].detail;
  }

  return { headline, reasons };
}

// ─── UMD export ───────────────────────────────────────────────────────────────────────────────
(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.Outliers = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  return { detectOutliers, computeBaseline, summarizeBucket, explainOutlier };
}));
