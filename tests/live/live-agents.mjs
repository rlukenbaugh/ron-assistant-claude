// Real integration check against the signed-in CLIs on this computer. Uses a little plan quota.
//   npm run test:live              Claude + Codex (connection check, Compare, Review together)
//   npm run test:live -- gemini    also include Gemini (Antigravity)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const runner = require('../../src/core/runner.js');
const { createOrchestrator } = require('../../src/core/orchestrator.js');

const models = ['claude', 'codex', ...(process.argv.includes('gemini') ? ['gemini'] : [])];
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ron-assistant-live-'));
const settings = { instructions: 'Keep answers under 80 words.', timeoutSec: 240, reviewRounds: 1, finalModel: 'auto', workDir };
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

const status = await runner.checkAll();
for (const id of models) check(`${id} connection check`, status[id].state === 'ready', status[id].detail);
console.log('Other connections:', Object.fromEntries(Object.entries(status).filter(([id]) => !models.includes(id)).map(([id, s]) => [id, `${s.state}: ${s.detail}`])));

const seen = [];
const ask = (id, prompt, opts) => { seen.push({ id, stage: /final answer after a review/.test(prompt) ? 'final' : /REVIEW ROUND/.test(prompt) ? 'review' : 'answer', hasQuestion: prompt.includes('MARKER-7193') }); return runner.ask(id, prompt, opts); };
const o = createOrchestrator({ ask });

let t = Date.now();
const compare = await o.start({ question: 'MARKER-7193: What is 17 × 19? Give the number and one sentence of working.', mode: 'compare', models, settings });
for (const id of models) check(`compare: ${id} answered`, compare.answers[id].state === 'done' && /323/.test(compare.answers[id].text), compare.answers[id].error || `${Math.round(compare.answers[id].ms / 1000)} s`);
check('compare: every model received the question', models.every((id) => seen.some((s) => s.id === id && s.hasQuestion)));
console.log(`Compare took ${Math.round((Date.now() - t) / 1000)} s`);

seen.length = 0; t = Date.now();
const review = await o.start({ question: 'MARKER-7193: Is a tomato a fruit or a vegetable? Answer briefly and note any disagreement.', mode: 'review', models, settings });
for (const id of models) check(`review: ${id} independent answer`, review.answers[id].state === 'done', review.answers[id].error || '');
check('review: each model reviewed exactly once', models.every((id) => seen.filter((s) => s.id === id && s.stage === 'review').length === 1), JSON.stringify(seen.map((s) => `${s.id}:${s.stage}`)));
check('review: exactly one final answer call', seen.filter((s) => s.stage === 'final').length === 1);
check('review: final answer produced', review.final?.state === 'done' && review.final.text.length > 20, `by ${review.final?.by}`);
check('review: run completed', review.status === 'complete', review.status);
console.log(`Review took ${Math.round((Date.now() - t) / 1000)} s\n--- Final answer (${review.final?.by}) ---\n${review.final?.text}\n---`);

// Cancellation of real processes.
const p = o.start({ question: 'Write a 400-word essay about rivers.', mode: 'compare', models: ['claude'], settings });
setTimeout(() => o.stop(), 2500);
const stopped = await p;
check('Stop ends a real running model', stopped.status === 'stopped' && stopped.answers.claude.state === 'stopped');

fs.writeFileSync(path.join(workDir, 'live-result.json'), JSON.stringify({ compare, review, results }, null, 2));
console.log(`Saved transcript: ${path.join(workDir, 'live-result.json')}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} live checks passed`);
process.exitCode = failed ? 1 : 0;
