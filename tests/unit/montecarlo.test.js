/**
 * tests/unit/montecarlo.test.js
 * Contract tests for lib/montecarlo.js — the forecasting engine behind the
 * Forecast page. All randomness goes through an injected seeded RNG so every
 * assertion is deterministic.
 */
import { describe, test, expect } from 'vitest';
import MonteCarlo from '../../lib/montecarlo.js';

const { forecastHowLong, forecastHowMany, percentile } = MonteCarlo;

/** mulberry32 — tiny seeded RNG so trials are reproducible. */
function seeded(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('percentile (nearest-rank)', () => {
  test('returns bounds at p=0 and p=100', () => {
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
  });
  test('floors the rank index', () => {
    // 50% of 10 → index 5 → sixth element
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(6);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 85)).toBe(9);
  });
  test('empty input yields 0', () => {
    expect(percentile([], 50)).toBe(0);
  });
});

describe('forecastHowLong', () => {
  test('degenerate samples [5] → every trial takes exactly ceil(N/5) intervals', () => {
    const r = forecastHowLong([5], 23, 500, seeded(1));
    expect(r.rawIntervals).toHaveLength(500);
    expect(r.rawIntervals.every(v => v === 5)).toBe(true);
    expect(r).toMatchObject({ p50: 5, p70: 5, p85: 5, p95: 5, mean: 5 });
  });

  test('percentiles are monotonic and rawIntervals is sorted ascending', () => {
    const r = forecastHowLong([2, 5, 7, 9, 11, 0, 8], 40, 2000, seeded(7));
    expect(r.p50).toBeLessThanOrEqual(r.p70);
    expect(r.p70).toBeLessThanOrEqual(r.p85);
    expect(r.p85).toBeLessThanOrEqual(r.p95);
    for (let i = 1; i < r.rawIntervals.length; i++) {
      expect(r.rawIntervals[i]).toBeGreaterThanOrEqual(r.rawIntervals[i - 1]);
    }
  });

  test('same seed → identical forecast; different seed → same shape', () => {
    const a = forecastHowLong([3, 6, 9], 30, 1000, seeded(42));
    const b = forecastHowLong([3, 6, 9], 30, 1000, seeded(42));
    const c = forecastHowLong([3, 6, 9], 30, 1000, seeded(43));
    expect(a.rawIntervals).toEqual(b.rawIntervals);
    expect(a.p85).toBe(b.p85);
    expect(c.rawIntervals).toHaveLength(1000);
  });

  test('more items never forecasts fewer intervals at p85', () => {
    const rng1 = seeded(3), rng2 = seeded(3);
    const small = forecastHowLong([4, 6, 8], 20, 1000, rng1);
    const big   = forecastHowLong([4, 6, 8], 60, 1000, rng2);
    expect(big.p85).toBeGreaterThanOrEqual(small.p85);
  });

  test('zero-throughput history returns the sentinel instead of looping forever', () => {
    const r = forecastHowLong([0, 0, 0], 10, 100, seeded(1));
    expect(r.p85).toBe(Number.MAX_SAFE_INTEGER);
    expect(r.rawIntervals).toEqual([]);
  });

  test('negative or non-numeric samples are clamped to 0, not thrown', () => {
    const r = forecastHowLong([5, -3, 'x', null], 10, 200, seeded(9));
    expect(r.p95).toBeGreaterThanOrEqual(2);
    expect(Number.isFinite(r.mean)).toBe(true);
  });

  test('rejects empty samples and itemCount < 1', () => {
    expect(() => forecastHowLong([], 5)).toThrow(/non-empty/);
    expect(() => forecastHowLong([5], 0)).toThrow(/itemCount/);
  });
});

describe('forecastHowMany', () => {
  test('degenerate samples [4] over 3 intervals → always 12', () => {
    const r = forecastHowMany([4], 3, 300, seeded(5));
    expect(r.rawCounts.every(v => v === 12)).toBe(true);
    expect(r).toMatchObject({ p50: 12, atLeast85: 12, atLeast95: 12, mean: 12 });
  });

  test('atLeastXX is the inverted percentile: higher confidence → fewer items', () => {
    const r = forecastHowMany([1, 4, 7, 10, 13], 6, 3000, seeded(11));
    expect(r.atLeast95).toBeLessThanOrEqual(r.atLeast85);
    expect(r.atLeast85).toBeLessThanOrEqual(r.atLeast70);
    expect(r.atLeast70).toBeLessThanOrEqual(r.atLeast50);
    expect(r.atLeast50).toBe(r.p50);
  });

  test('totals stay inside [intervals·min, intervals·max]', () => {
    const r = forecastHowMany([2, 5, 9], 4, 1000, seeded(2));
    expect(Math.min(...r.rawCounts)).toBeGreaterThanOrEqual(8);
    expect(Math.max(...r.rawCounts)).toBeLessThanOrEqual(36);
  });

  test('rejects empty samples and intervals < 1', () => {
    expect(() => forecastHowMany([], 2)).toThrow(/non-empty/);
    expect(() => forecastHowMany([3], 0)).toThrow(/intervals/);
  });
});
