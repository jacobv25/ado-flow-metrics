/**
 * tests/unit/explain.test.js — the "Explain this week" module with a fake
 * Anthropic client: prompt construction, privacy guarantees, routing, and
 * the error paths the server maps to HTTP statuses.
 */
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { explain, explainWithClaude, stubExplanation, buildPrompt, ExplanationSchema, PayloadSchema } from '../../lib/explain.js';

const caseDir = path.resolve(__dirname, '../../evals/cases');
const load = id => JSON.parse(fs.readFileSync(path.join(caseDir, id + '.json'), 'utf8')).payload;
const base = () => load('contributor-dip-low');

function fakeClient(reply) {
  const calls = [];
  return {
    calls,
    messages: { parse: async req => { calls.push(req); return typeof reply === 'function' ? reply(req) : reply; } },
  };
}
const okResponse = parsed => ({ stop_reason: 'end_turn', parsed_output: parsed, model: 'claude-test', usage: { input_tokens: 10, output_tokens: 5 } });

describe('payload validation', () => {
  test('every golden case validates', () => {
    for (const f of fs.readdirSync(caseDir).filter(f => f.endsWith('.json'))) {
      const { payload } = JSON.parse(fs.readFileSync(path.join(caseDir, f), 'utf8'));
      expect(PayloadSchema.safeParse(payload).success, f).toBe(true);
    }
  });
  test('rejects oversized titles and unknown flags', () => {
    const p = base(); p.bucket.items[0].title = 'x'.repeat(201);
    expect(PayloadSchema.safeParse(p).success).toBe(false);
    const q = base(); q.flag = 'sideways';
    expect(PayloadSchema.safeParse(q).success).toBe(false);
  });
  test('explain() surfaces validation failures with code "invalid"', async () => {
    await expect(explain({ flag: 'low' }, { mode: 'stub' })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('prompt construction', () => {
  test('never includes assignee names', () => {
    const p = base();
    const { system, user } = buildPrompt(PayloadSchema.parse(p));
    for (const it of p.bucket.items) expect(user).not.toContain(it.assignedTo);
    expect(system).not.toContain('Rosa');
  });
  test('carries the direction, the count vs median, and fenced titles', () => {
    const p = PayloadSchema.parse(base());
    const { system, user } = buildPrompt(p);
    expect(system).toContain('LOW versus the median');
    expect(user).toContain(`Items completed: ${p.bucket.count} (team median ${p.baseline.medianCount}`);
    expect(user).toMatch(/<items>[\s\S]*<\/items>/);
    expect(user).toContain(p.bucket.items[0].title);
  });
  test('flags a partial period loudly', () => {
    const p = PayloadSchema.parse(load('demo-partial-current-week'));
    expect(buildPrompt(p).user).toContain('STILL IN PROGRESS');
  });
  test('caps the item list at 40 and says how many were omitted', () => {
    const p = PayloadSchema.parse(base());
    p.bucket.items = Array.from({ length: 55 }, (_, i) => ({ id: i, title: 't' + i, type: 'Bug' }));
    const { user } = buildPrompt(p);
    expect(user).toContain('- #39 ');
    expect(user).not.toContain('- #40 ');
    expect(user).toContain('and 15 more items');
  });
});

describe('stub explanation', () => {
  test('is deterministic and schema-valid for every case', () => {
    for (const f of fs.readdirSync(caseDir).filter(f => f.endsWith('.json'))) {
      const p = PayloadSchema.parse(JSON.parse(fs.readFileSync(path.join(caseDir, f), 'utf8')).payload);
      const a = stubExplanation(p), b = stubExplanation(p);
      expect(a).toEqual(b);
      expect(ExplanationSchema.safeParse(a).success, f).toBe(true);
    }
  });
  test('leads with the partial-period caveat when the week is in progress', () => {
    const e = stubExplanation(PayloadSchema.parse(load('demo-partial-current-week')));
    expect(e.headline).toMatch(/in progress/i);
    expect(e.caveats.join(' ')).toMatch(/in progress/i);
  });
});

describe('routing', () => {
  test('mode "stub" returns source stub without touching a client', async () => {
    const r = await explain(base(), { mode: 'stub' });
    expect(r.source).toBe('stub');
    expect(r.model).toBeNull();
  });
  test('mode "off" throws code "off"', async () => {
    await expect(explain(base(), { mode: 'off' })).rejects.toMatchObject({ code: 'off' });
  });
});

describe('Claude path (fake client)', () => {
  test('sends a structured-output request and returns the parsed explanation', async () => {
    const parsed = stubExplanation(PayloadSchema.parse(base()));
    const client = fakeClient(okResponse(parsed));
    const r = await explainWithClaude(PayloadSchema.parse(base()), { client, model: 'claude-test' });
    expect(r).toMatchObject({ source: 'claude', model: 'claude-test', explanation: parsed, usage: { input: 10, output: 5 } });
    const req = client.calls[0];
    expect(req.model).toBe('claude-test');
    expect(req.output_config.format).toBeTruthy();
    expect(req.output_config.effort).toBe('low');
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].role).toBe('user');
  });
  test('maps a refusal to code "refusal"', async () => {
    const client = fakeClient({ stop_reason: 'refusal', stop_details: { explanation: 'nope' }, parsed_output: null, usage: {} });
    await expect(explainWithClaude(PayloadSchema.parse(base()), { client })).rejects.toMatchObject({ code: 'refusal' });
  });
  test('maps a truncated or unparseable reply to code "incomplete"', async () => {
    const client = fakeClient({ stop_reason: 'max_tokens', parsed_output: null, usage: {} });
    await expect(explainWithClaude(PayloadSchema.parse(base()), { client })).rejects.toMatchObject({ code: 'incomplete' });
  });
  test('lets SDK errors propagate untouched so the server can map status codes', async () => {
    const client = fakeClient(() => { throw Object.assign(new Error('rate limited'), { status: 429 }); });
    await expect(explainWithClaude(PayloadSchema.parse(base()), { client })).rejects.toMatchObject({ status: 429 });
  });
});
