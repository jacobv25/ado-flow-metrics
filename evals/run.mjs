#!/usr/bin/env node
/**
 * evals/run.mjs — run the "Explain this week" eval.
 *
 *   npm run eval              live: Claude under test + LLM judge  (needs ANTHROPIC_API_KEY)
 *   npm run eval:stub         offline self-test of the harness on the deterministic stub
 *   node evals/run.mjs --reps 2 --no-judge --filter holiday
 *
 * Pass criteria (exit code 1 otherwise):
 *   • every deterministic check passes on every case and rep
 *   • judge pass rate (all three properties >= 4) is at least JUDGE_PASS_RATE (default 0.8)
 *
 * Writes evals/results/latest.json and latest.md. The headline numbers are
 * recomputed from the per-case rows at the end, never read from an aggregate.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { explain, buildPrompt } = require('../lib/explain.js');
const { runChecks } = require('./checks.js');
const { judge, judgePassed, JUDGE_MODEL } = require('./judge.js');

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? true) : dflt; };
const STUB      = args.includes('--stub');
const NO_JUDGE  = args.includes('--no-judge');
const REPS      = parseInt(flag('--reps', '1'), 10);
const FILTER    = flag('--filter', null);
const THRESHOLD = parseFloat(process.env.JUDGE_PASS_RATE || '0.8');

const caseDir = path.join(here, 'cases');
const cases = fs.readdirSync(caseDir).filter(f => f.endsWith('.json')).sort()
  .map(f => JSON.parse(fs.readFileSync(path.join(caseDir, f), 'utf8')))
  .filter(c => !FILTER || c.id.includes(FILTER));
if (!cases.length) { console.error('no cases'); process.exit(2); }

const mode = STUB ? 'stub' : 'claude';
console.log(`\nExplain-this-week eval — ${cases.length} cases × ${REPS} rep(s) — model under test: ${mode}${NO_JUDGE ? '' : ' — judge: ' + JUDGE_MODEL}\n`);

const rows = [];
let usage = { input: 0, output: 0, judgeInput: 0, judgeOutput: 0 };
const t0 = Date.now();
for (const c of cases) {
  for (let rep = 0; rep < REPS; rep++) {
    const started = Date.now();
    let result, error = null;
    try { result = await explain(c.payload, { mode }); }
    catch (err) { error = err.message; }
    const row = { id: c.id, tags: c.tags, rep, ms: Date.now() - started, error, source: result?.source, model: result?.model };
    if (result) {
      usage.input += result.usage?.input || 0; usage.output += result.usage?.output || 0;
      row.explanation = result.explanation;
      row.checks = runChecks(result.explanation, c.payload);
      row.deterministicPass = row.checks.every(x => x.pass);
      if (!NO_JUDGE) {
        try {
          const j = await judge(result.explanation, buildPrompt(c.payload).user);
          usage.judgeInput += j.usage.input; usage.judgeOutput += j.usage.output;
          row.judge = j; row.judgePass = judgePassed(j);
        } catch (err) { row.judge = { error: err.message }; row.judgePass = false; }
      }
    } else { row.deterministicPass = false; row.judgePass = false; }
    const det = row.deterministicPass ? 'PASS' : 'FAIL';
    const jd  = NO_JUDGE ? '' : row.judgePass ? '  judge PASS' : '  judge FAIL';
    console.log(`  ${det}  ${c.id}${REPS > 1 ? ' #' + rep : ''}${jd}  (${row.ms} ms)`);
    for (const x of (row.checks || []).filter(x => !x.pass)) console.log(`         ✗ ${x.name}: ${x.detail}`);
    if (row.judge && !row.judgePass && !row.judge.error) console.log(`         judge: f=${row.judge.faithfulness} a=${row.judge.actionability} t=${row.judge.tone} — ${row.judge.rationale}`);
    if (error) console.log(`         error: ${error}`);
    rows.push(row);
  }
}

// Headline numbers, recomputed from rows.
const n = rows.length;
const detPass = rows.filter(r => r.deterministicPass).length;
const judged  = rows.filter(r => r.judge && !r.judge.error);
const judgePassCount = judged.filter(r => r.judgePass).length;
const judgeRate = judged.length ? judgePassCount / judged.length : null;
const failedChecks = {};
for (const r of rows) for (const x of r.checks || []) if (!x.pass) failedChecks[x.name] = (failedChecks[x.name] || 0) + 1;
const avg = k => judged.length ? (judged.reduce((s, r) => s + r.judge[k], 0) / judged.length).toFixed(2) : null;

const summary = {
  ranAt: new Date().toISOString(), mode, reps: REPS, cases: cases.length, rows: n,
  modelUnderTest: rows.find(r => r.model)?.model || mode, judgeModel: NO_JUDGE ? null : JUDGE_MODEL,
  deterministic: { pass: detPass, total: n, failedChecks },
  judge: NO_JUDGE ? null : { pass: judgePassCount, total: judged.length, rate: judgeRate, avg: { faithfulness: avg('faithfulness'), actionability: avg('actionability'), tone: avg('tone') }, threshold: THRESHOLD },
  usage, wallMs: Date.now() - t0,
};
const ok = detPass === n && (NO_JUDGE || (judgeRate !== null && judgeRate >= THRESHOLD));
summary.verdict = ok ? 'PASS' : 'FAIL';

fs.mkdirSync(path.join(here, 'results'), { recursive: true });
fs.writeFileSync(path.join(here, 'results', 'latest.json'), JSON.stringify({ summary, rows }, null, 2));
const md = [
  `# Explain-this-week eval — ${summary.verdict}`, '',
  `- Ran: ${summary.ranAt}`, `- Model under test: ${summary.modelUnderTest}${NO_JUDGE ? '' : ` · judge: ${JUDGE_MODEL}`}`,
  `- Deterministic checks: ${detPass}/${n} rows passed${Object.keys(failedChecks).length ? ' — failures: ' + JSON.stringify(failedChecks) : ''}`,
  NO_JUDGE ? '- Judge: skipped' : `- Judge: ${judgePassCount}/${judged.length} passed (${(judgeRate * 100).toFixed(0)}%, threshold ${THRESHOLD * 100}%) · avg faithfulness ${summary.judge.avg.faithfulness}, actionability ${summary.judge.avg.actionability}, tone ${summary.judge.avg.tone}`,
  `- Tokens: ${usage.input} in / ${usage.output} out under test; ${usage.judgeInput} in / ${usage.judgeOutput} out judge`, '',
  '| case | deterministic | judge f/a/t | headline |', '|---|---|---|---|',
  ...rows.map(r => `| ${r.id}${REPS > 1 ? ' #' + r.rep : ''} | ${r.deterministicPass ? '✅' : '❌ ' + (r.checks || []).filter(x => !x.pass).map(x => x.name).join(',')} | ${r.judge && !r.judge.error ? `${r.judge.faithfulness}/${r.judge.actionability}/${r.judge.tone}` : '—'} | ${(r.explanation?.headline || r.error || '').replace(/\|/g, '/')} |`),
].join('\n') + '\n';
fs.writeFileSync(path.join(here, 'results', 'latest.md'), md);

console.log(`\n${summary.verdict} — deterministic ${detPass}/${n}${NO_JUDGE ? '' : `, judge ${judgePassCount}/${judged.length} (${(judgeRate * 100).toFixed(0)}% ≥ ${THRESHOLD * 100}%)`} — ${(summary.wallMs / 1000).toFixed(1)}s`);
console.log(`results: evals/results/latest.md\n`);
process.exit(ok ? 0 : 1);
