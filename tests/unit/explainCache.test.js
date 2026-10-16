import { describe, test, expect } from 'vitest';
import { createCache, keyFor, canonical } from '../../lib/explainCache.js';

describe('explain cache key', () => {
  test('is independent of key order and nesting order', () => {
    const a = { flag: 'low', bucket: { start: '2026-09-01', count: 1 }, counts: [1, 2] };
    const b = { counts: [1, 2], bucket: { count: 1, start: '2026-09-01' }, flag: 'low' };
    expect(keyFor(a, 'm')).toBe(keyFor(b, 'm'));
    expect(canonical(a)).toBe(canonical(b));
  });
  test('changes when any value or the model changes', () => {
    const a = { flag: 'low', counts: [1, 2] };
    expect(keyFor(a, 'm')).not.toBe(keyFor({ ...a, counts: [1, 3] }, 'm'));
    expect(keyFor(a, 'm')).not.toBe(keyFor(a, 'other-model'));
  });
  test('array order still matters (the series is ordered data)', () => {
    expect(keyFor({ counts: [1, 2] }, 'm')).not.toBe(keyFor({ counts: [2, 1] }, 'm'));
  });
});

describe('explain cache store', () => {
  test('returns what was stored and misses on unknown keys', () => {
    const c = createCache();
    c.set('k', { x: 1 });
    expect(c.get('k')).toEqual({ x: 1 });
    expect(c.get('nope')).toBeUndefined();
  });
  test('expires entries after the TTL', () => {
    let t = 1000;
    const c = createCache({ ttlMs: 100, now: () => t });
    c.set('k', 'v');
    t = 1099; expect(c.get('k')).toBe('v');
    t = 1100; expect(c.get('k')).toBeUndefined();
    expect(c.size).toBe(0);
  });
  test('evicts the oldest entry past the cap', () => {
    const c = createCache({ max: 2 });
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
    expect(c.size).toBe(2);
  });
  test('re-setting a key makes it newest again', () => {
    const c = createCache({ max: 2 });
    c.set('a', 1); c.set('b', 2); c.set('a', 10); c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(10);
  });
});
