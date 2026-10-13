/**
 * tests/unit/explainPrompt.test.js — the packet gives the model the facts it
 * was previously guessing at: the current period's place in the series and
 * the per-day close tally.
 */
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildPrompt, PayloadSchema, closesPerDay } from '../../lib/explain.js';

const load = id => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../evals/cases', id + '.json'), 'utf8')).payload;

describe('buildPrompt packet facts', () => {
  test('marks the current period in the series', () => {
    const p = PayloadSchema.parse(load('batch-close-high'));
    const { user } = buildPrompt(p);
    expect(user).toMatch(/oldest to newest: (\d+, )*\[16\](, \d+)*/);
    expect(user).toContain('later periods already observed');
  });
  test('lists closes per day in date order and the tally sums to the item count', () => {
    const p = PayloadSchema.parse(load('batch-close-high'));
    const tally = closesPerDay(p.bucket.items);
    expect(tally.reduce((a, [, n]) => a + n, 0)).toBe(p.bucket.count);
    expect(tally.map(t => t[0])).toEqual([...tally.map(t => t[0])].sort());
    expect(buildPrompt(p).user).toContain('closes per day: ' + tally.map(([d, n]) => d + ' ×' + n).join(', '));
  });
  test('averages are shown to two decimals', () => {
    const p = PayloadSchema.parse(load('contributor-dip-low'));
    expect(buildPrompt(p).user).toContain('average story points per item: ' + Number(p.baseline.avgPointsBaseline.toFixed(2)));
  });
});
