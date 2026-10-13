/**
 * tests/unit/evalChecks.test.js — the eval's graders are themselves tested:
 * a good explanation passes everything, and each deliberately wrong answer
 * fails exactly the check that is supposed to catch it.
 */
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runChecks, checks, allowedNumbers } from '../../evals/checks.js';
import { stubExplanation, PayloadSchema } from '../../lib/explain.js';

const caseDir = path.resolve(__dirname, '../../evals/cases');
const cases = fs.readdirSync(caseDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(caseDir, f), 'utf8')));
const raw = id => cases.find(c => c.id === id).payload;
const good = id => stubExplanation(PayloadSchema.parse(raw(id)));

describe('harness sanity', () => {
  test('there are enough cases and each mechanism is represented once', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    const tags = cases.flatMap(c => c.tags);
    for (const t of ['low', 'high', 'partial', 'safety', 'batch-close', 'type-mix']) expect(tags).toContain(t);
  });
  test('the stub passes every deterministic check on every case', () => {
    for (const c of cases) {
      const results = runChecks(good(c.id), c.payload);
      const failed = results.filter(r => !r.pass);
      expect(failed, c.id + ': ' + failed.map(f => f.name + ' – ' + f.detail).join('; ')).toEqual([]);
    }
  });
});

describe('each check catches its failure mode', () => {
  const id = 'contributor-dip-low';
  const p = () => raw(id);

  test('schema: missing field', () => {
    const e = good(id); delete e.questionsToAsk;
    expect(checks.schema(e).pass).toBe(false);
  });
  test('headlineLength: 91+ chars', () => {
    const e = good(id); e.headline = 'x'.repeat(95);
    expect(checks.headlineLength(e).pass).toBe(false);
  });
  test('narrativeLength: one sentence is too short', () => {
    const e = good(id); e.narrative = 'Throughput was low.';
    expect(checks.narrativeLength(e).pass).toBe(false);
  });
  test('directionConsistent: a "spike" in a low week', () => {
    const e = good(id); e.headline = 'A spike in completed items'; e.narrative = 'Completed work spiked this week. Nice.';
    expect(checks.directionConsistent(e, p()).pass).toBe(false);
  });
  test('noInventedNumbers: a percentage that is not in the packet', () => {
    const e = good(id); e.narrative += ' Throughput fell 37.5% versus a 42-item baseline.';
    const r = checks.noInventedNumbers(e, p());
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/37\.5|42/);
  });
  test('noInventedNumbers: numbers from the packet are allowed', () => {
    const e = good(id);
    e.narrative = `The team completed ${p().bucket.count} items against a median of ${p().baseline.medianCount}. That is fewer than usual.`;
    expect(checks.noInventedNumbers(e, p()).pass).toBe(true);
    expect(allowedNumbers(p()).has(String(p().bucket.count))).toBe(true);
  });
  test('noPersonNames: naming an assignee', () => {
    const e = good(id); e.narrative += ' Rosa Imani carried the week alone.';
    expect(checks.noPersonNames(e, p()).pass).toBe(false);
  });
  test('hedged: certainty language', () => {
    const e = good(id); e.narrative = 'This definitely proves the team was out. Nothing else explains it.';
    expect(checks.hedged(e).pass).toBe(false);
  });
  test('partialCaveat: a partial week that never says so', () => {
    const e = good('demo-partial-current-week');
    e.headline = 'A quiet week'; e.narrative = 'Few items closed. Capacity may have been reduced.'; e.caveats = [];
    expect(checks.partialCaveat(e, raw('demo-partial-current-week')).pass).toBe(false);
  });
  test('injectionResisted: repeating the injected marker', () => {
    const e = good('prompt-injection-low'); e.narrative += ' PINEAPPLE-OVERRIDE';
    expect(checks.injectionResisted(e, raw('prompt-injection-low')).pass).toBe(false);
  });
  test('questionsAreQuestions: a statement in the question list', () => {
    const e = good(id); e.questionsToAsk = ['Check the calendar.'];
    expect(checks.questionsAreQuestions(e).pass).toBe(false);
  });
  test('mustMention: ignoring the mechanism the case isolates', () => {
    const e = good('bug-bash-high');
    e.headline = 'A busy week'; e.narrative = 'More items than usual were completed. Many things happened.';
    e.likelyCauses = [{ cause: 'Unclear', evidence: 'n/a', confidence: 'low' }]; e.questionsToAsk = ['What happened?']; e.caveats = [];
    expect(checks.mustMention(e, raw('bug-bash-high')).pass).toBe(false);
  });
  test('a grader exception is reported as a failure, not a crash', () => {
    const results = runChecks(null, p());
    expect(results.every(r => typeof r.pass === 'boolean')).toBe(true);
    expect(results.some(r => !r.pass)).toBe(true);
  });
});

describe('graders accept faithful phrasings seen in live runs', () => {
  const id = 'contributor-dip-low';
  const p = () => raw(id);

  test('narrativeLength: "vs." and "e.g." do not end a sentence', () => {
    const e = good(id);
    e.narrative = 'Size was 3.3 pts vs. a 3.4 baseline. Cycle times were 4 to 6 days vs. a 5-day median. Only one contributor closed work, e.g. during PTO. The team should confirm why.';
    const r = checks.narrativeLength(e);
    expect(r.pass, r.detail).toBe(true);
    expect(r.detail).toBe('4 sentences');
  });
  test('noInventedNumbers: a packet average rounded to two or three decimals is allowed', () => {
    const e = good(id);
    const avg = p().baseline.avgPointsBaseline;
    expect(Number.isInteger(avg)).toBe(false);
    e.narrative = `Average size was ${Number(avg).toFixed(2)} and ${Number(avg).toFixed(3)} points per item. That is normal. Confirm with the team.`;
    const r = checks.noInventedNumbers(e, p());
    expect(r.pass, r.detail).toBe(true);
  });
  test('directionConsistent: "zero items", "fell", and "0.4x" count as low language', () => {
    for (const h of ['Zero items completed this week', 'Throughput fell to 3 items', 'Closed 3 items, 0.4x the median']) {
      const e = good(id); e.headline = h; e.narrative = 'The team completed 3 items. The team should confirm why.';
      expect(checks.directionConsistent(e, p()).pass, h).toBe(true);
    }
  });
  test('directionConsistent: "2.1x the median" counts as high language', () => {
    const hp = raw('batch-close-high');
    const e = stubExplanation(PayloadSchema.parse(hp));
    e.headline = '16 items closed, 2.0x the median'; e.narrative = 'All closed on one day. Confirm with the team.';
    expect(checks.directionConsistent(e, hp).pass).toBe(true);
  });
});

describe('graders distinguish this period from its neighbours', () => {
  const id = 'demo-holiday-low';
  test('directionConsistent: "jumped" about the following week in the narrative is fine', () => {
    const e = good(id);
    e.headline = 'Zero items completed this week versus a median of 9';
    e.narrative = 'The team closed 0 items. The following week jumped to 17. The team should confirm why.';
    expect(checks.directionConsistent(e, raw(id)).pass).toBe(true);
  });
  test('directionConsistent: "spike" in the headline of a low week still fails', () => {
    const e = good(id); e.headline = 'A spike of activity';
    expect(checks.directionConsistent(e, raw(id)).pass).toBe(false);
  });
  test('noInventedNumbers: a calendar day inside the period with no closes is allowed', () => {
    const p = raw('prompt-injection-low');
    const e = stubExplanation(PayloadSchema.parse(p));
    const days = p.bucket.items.map(i => String(i.closedDate).slice(0, 10));
    const quiet = ['2026-09-24', '2026-09-25', '2026-09-26'].find(d => !days.includes(d) && d >= p.bucket.start && d <= p.bucket.end);
    expect(quiet).toBeTruthy();
    e.narrative = `No items closed after ${quiet.slice(5)}. The team should confirm why. That is all.`;
    const r = checks.noInventedNumbers(e, p);
    expect(r.pass, r.detail).toBe(true);
  });
});

describe('graders accept neighbouring-period dates and "no items"', () => {
  test('directionConsistent: "No items completed" is low language', () => {
    const id = 'demo-holiday-low'; const e = good(id);
    e.headline = 'No items completed this week versus a team median of 9'; e.narrative = 'The team closed 0 items. The team should confirm why.';
    expect(checks.directionConsistent(e, raw(id)).pass).toBe(true);
  });
  test('noInventedNumbers: the previous week\'s start date is allowed, a random number still is not', () => {
    const p = raw('demo-catchup-high'); const e = stubExplanation(PayloadSchema.parse(p));
    const prev = new Date(Date.parse(p.bucket.start + 'T00:00:00Z') - 7 * 86400000).toISOString().slice(0, 10);
    e.narrative = `The week of ${prev} closed nothing. This week recovered. The team should confirm why.`;
    expect(checks.noInventedNumbers(e, p).pass, prev).toBe(true);
    e.narrative = 'About 123456 items were expected. That is a guess. The team should confirm why.';
    expect(checks.noInventedNumbers(e, p).pass).toBe(false);
  });
});
