'use strict';

/**
 * lib/montecarlo.js
 *
 * Pure, dependency-free Monte Carlo forecasting module.
 * Works in Node.js (CommonJS require) and in the browser (UMD global).
 *
 * EXPORTS
 *   forecastHowLong(samples, itemCount, trials, rng?)
 *     → { p50, p70, p85, p95, mean, rawIntervals }
 *     Answers: "how many intervals will it take to complete N items?"
 *     Each element of rawIntervals is the number of intervals drawn in that trial.
 *
 *   forecastHowMany(samples, intervals, trials, rng?)
 *     → { p50, p70, p85, p95, atLeast50, atLeast70, atLeast85, atLeast95, mean, rawCounts }
 *     Answers: "how many items can we complete in a fixed number of intervals?"
 *     atLeastXX = lower bound we're XX% confident of reaching (inverted percentile).
 *
 *   percentile(sortedAsc, p)
 *     → number
 *     Returns the p-th percentile (0–100) of a pre-sorted ascending array.
 *
 * TESTING
 *   A degenerate sample set of [5] should give rawIntervals where every element
 *   equals exactly ceil(itemCount / 5). Verify with a seeded rng for reproducibility.
 */

// ─── Core math ────────────────────────────────────────────────────────────────

/**
 * Return the p-th percentile (0–100) of a pre-sorted ascending numeric array.
 * Uses the nearest-rank method (floors the index).
 *
 * @param {number[]} sortedAsc  Pre-sorted ascending array (mutates nothing).
 * @param {number}   p          Percentile, 0–100 inclusive.
 * @returns {number}
 */
function percentile(sortedAsc, p) {
  if (!sortedAsc || !sortedAsc.length) return 0;
  if (p <= 0)   return sortedAsc[0];
  if (p >= 100) return sortedAsc[sortedAsc.length - 1];
  const idx = Math.min(
    Math.floor((p / 100) * sortedAsc.length),
    sortedAsc.length - 1
  );
  return sortedAsc[idx];
}

// ─── Simulation helpers ────────────────────────────────────────────────────────

/**
 * Draw a random element from an array using the provided rng function.
 * @param {number[]} arr
 * @param {function} rng   () → [0, 1)  (defaults to Math.random)
 */
function draw(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

// ─── Exported functions ────────────────────────────────────────────────────────

/**
 * Monte Carlo forecast: how many intervals to complete `itemCount` items?
 *
 * Algorithm: repeat `trials` times —
 *   draw random samples from `samples` until the cumulative total reaches
 *   `itemCount`, counting how many draws were needed. The resulting distribution
 *   of draw counts is the forecast.
 *
 * @param {number[]} samples    Historical throughput (items per interval). May include zeros.
 * @param {number}   itemCount  Number of items to forecast for.
 * @param {number}   [trials=10000]
 * @param {function} [rng]      Optional seeded RNG for testing.
 * @returns {{ p50:number, p70:number, p85:number, p95:number, mean:number,
 *             rawIntervals:number[] }}
 */
function forecastHowLong(samples, itemCount, trials, rng) {
  trials = trials || 10000;
  rng    = rng    || Math.random;

  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('samples must be a non-empty array');
  }
  if (itemCount < 1) {
    throw new Error('itemCount must be >= 1');
  }

  // Ensure all samples are non-negative numbers
  const safe = samples.map(s => Math.max(0, Number(s) || 0));

  // Safety: if every sample is 0, we can never finish → return Infinity-like values
  const hasPositive = safe.some(s => s > 0);
  if (!hasPositive) {
    const inf = Number.MAX_SAFE_INTEGER;
    return { p50: inf, p70: inf, p85: inf, p95: inf, mean: inf, rawIntervals: [] };
  }

  const rawIntervals = new Array(trials);
  const SAFETY = 100000; // prevent infinite loop on near-zero throughput

  for (let t = 0; t < trials; t++) {
    let total = 0, intervals = 0;
    while (total < itemCount && intervals < SAFETY) {
      total += draw(safe, rng);
      intervals++;
    }
    rawIntervals[t] = intervals;
  }

  rawIntervals.sort((a, b) => a - b);

  const sum  = rawIntervals.reduce((s, v) => s + v, 0);

  return {
    p50:  percentile(rawIntervals, 50),
    p70:  percentile(rawIntervals, 70),
    p85:  percentile(rawIntervals, 85),
    p95:  percentile(rawIntervals, 95),
    mean: Math.round(sum / trials),
    rawIntervals,
  };
}

/**
 * Monte Carlo forecast: how many items completed within `intervals` intervals?
 *
 * Algorithm: repeat `trials` times —
 *   draw exactly `intervals` samples from `samples`, sum them. The resulting
 *   distribution of totals is the forecast.
 *
 * For "how many are we X% confident of completing?", use atLeastXX:
 *   atLeast85 = 15th percentile of the distribution → 85% of trials exceeded it.
 *
 * @param {number[]} samples    Historical throughput (items per interval). May include zeros.
 * @param {number}   intervals  Number of future intervals available (deadline).
 * @param {number}   [trials=10000]
 * @param {function} [rng]      Optional seeded RNG for testing.
 * @returns {{ p50:number, p70:number, p85:number, p95:number,
 *             atLeast50:number, atLeast70:number, atLeast85:number, atLeast95:number,
 *             mean:number, rawCounts:number[] }}
 */
function forecastHowMany(samples, intervals, trials, rng) {
  trials = trials || 10000;
  rng    = rng    || Math.random;

  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('samples must be a non-empty array');
  }
  if (intervals < 1) {
    throw new Error('intervals must be >= 1');
  }

  const safe = samples.map(s => Math.max(0, Number(s) || 0));

  const rawCounts = new Array(trials);
  for (let t = 0; t < trials; t++) {
    let total = 0;
    for (let i = 0; i < intervals; i++) {
      total += draw(safe, rng);
    }
    rawCounts[t] = Math.round(total);
  }

  rawCounts.sort((a, b) => a - b);

  const sum = rawCounts.reduce((s, v) => s + v, 0);

  return {
    // Standard percentiles (XX% of trials completed <= this many)
    p50:  percentile(rawCounts, 50),
    p70:  percentile(rawCounts, 70),
    p85:  percentile(rawCounts, 85),
    p95:  percentile(rawCounts, 95),

    // Inverted: "XX% confident of completing AT LEAST this many"
    atLeast50: percentile(rawCounts, 50), // median → 50% above, 50% below
    atLeast70: percentile(rawCounts, 30), // 70% of trials >= this
    atLeast85: percentile(rawCounts, 15), // 85% of trials >= this
    atLeast95: percentile(rawCounts, 5),  // 95% of trials >= this

    mean: Math.round(sum / trials),
    rawCounts,
  };
}

// ─── UMD export ───────────────────────────────────────────────────────────────
(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.MonteCarlo = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  return { forecastHowLong, forecastHowMany, percentile };
}));
