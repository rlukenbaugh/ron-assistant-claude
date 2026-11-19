'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSpec, childEnvironment, getProvider, classifyFailure, checkedPrompt } = require('../../src/core/adapters');
const { createOrchestrator } = require('../../src/core/orchestrator');
const { render, extractLinks, toPlainText, toSpeech, safeUrl } = require('../../src/core/markdown');
const { createStore } = require('../../src/core/store');
const { splitReview, answerPrompt } = require('../../src/core/prompts');
const jarvis = require('../../src/core/jarvis');
const { summarizeError } = require('../../src/core/runner');

const settings = { instructions: 'Use plain English.', timeoutSec: 5, reviewRounds: 1, finalModel: 'auto' };

test('answering sessions are text-only and cannot reach MCP tools or the shell', () => {
  const claude = spawnSpec('claude').args;
  for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config', '--no-session-persistence']) assert.ok(claude.includes(flag), flag);
  assert.equal(claude[claude.indexOf('--tools') + 1], '');
  const codex = spawnSpec('codex').args;
  for (const flag of ['--ignore-user-config', '--ephemeral', 'features.shell_tool=false', 'agents.enabled=false', 'web_search="disabled"']) assert.ok(codex.includes(flag), flag);
  assert.equal(codex[codex.indexOf('--sandbox') + 1], 'read-only');
  const gemini = spawnSpec('gemini').args;
  assert.ok(gemini.includes('--sandbox') && gemini.includes('plan'));
  assert.ok(!gemini.includes('--dangerously-skip-permissions'));
  // Prompts go on stdin, never into argv.
  for (const id of ['claude', 'codex', 'gemini', 'hermes']) assert.ok(!spawnSpec(id).args.some((a) => /QUESTION/.test(a)));
});

test('secrets are not inherited by model processes and children are marked against recursion', () => {
  const env = childEnvironment({ PATH: 'x', API_KEY: 'a', GEMINI_API_KEY: 'b', JARVIS_CLOUD_TOKEN: 'c', CSC_LINK: 'd', CLAUDECODE: '1', NODE_OPTIONS: '--inspect' });
  assert.deepEqual(env, { PATH: 'x', RON_ASSISTANT_CHILD: '1', JARVIS_REVIEW_CHILD: '1' });
});

test('CLI output parsing never turns a failure into an answer', () => {
  assert.throws(() => getProvider('claude').parse('{"is_error":true,"result":"Usage limit reached"}'));
  assert.equal(getProvider('claude').parse('{"is_error":false,"result":" Hi "}'), 'Hi');
  assert.throws(() => getProvider('codex').parse('{"type":"turn.failed","error":{"message":"rate limit"}}'));
  assert.equal(getProvider('codex').parse('{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n{"type":"turn.completed"}'), 'OK');
  assert.equal(getProvider('gemini').parse('warning: x\n{"status":"SUCCESS","response":"AGY-OK\\n"}'), 'AGY-OK');
  assert.throws(() => getProvider('gemini').parse('{"status":"TIMEOUT","response":""}'));
  assert.throws(() => getProvider('hermes').parse('No access token found for Nous Portal login. Run `hermes model` to re-authenticate.'), /not signed in/);
  assert.equal(classifyFailure('Error 429: Too Many Requests'), 'rate-limited');
  assert.equal(classifyFailure('You are not logged in'), 'signin');
  assert.throws(() => checkedPrompt('   '));
  assert.match(summarizeError('Codex', 'boom key-ABCDEFGHIJKLMNOPQRS', 1), /\[redacted\]/);
});

function fakeAsk(behaviour = {}) {
  const calls = [];
  const ask = (id, prompt, { signal } = {}) => {
    calls.push({ id, prompt });
    const kind = /writing the single final answer/.test(prompt) ? 'final' : /REVIEW ROUND/.test(prompt) ? 'review' : 'answer';
    const b = behaviour[`${id}:${kind}`];
    return new Promise((resolve, reject) => {
      if (b === 'hang') { signal?.addEventListener('abort', () => reject(Object.assign(new Error('Stopped.'), { code: 'cancelled' }))); return; }
      if (b === 'fail') return reject(Object.assign(new Error(`${id} usage limit`), { code: 'rate-limited' }));
      if (kind === 'review') return resolve(`## Review\n${id} reviewed.\n\n## Revised answer\n${id} revised`);
      return resolve(`${id} ${kind}`);
    });
  };
  return { ask, calls };
}

test('review mode: independent answers, one bounded review each, one final answer', async () => {
  const { ask, calls } = fakeAsk();
  const o = createOrchestrator({ ask });
  const run = await o.start({ question: 'Q?', mode: 'review', models: ['claude', 'codex'], settings });
  assert.equal(run.status, 'complete');
  assert.deepEqual(calls.map((c) => c.id), ['claude', 'codex', 'claude', 'codex', 'claude']);
  assert.ok(calls.slice(0, 2).every((c) => c.prompt.includes('Q?') && c.prompt.includes('Use plain English.')));
  assert.ok(calls[2].prompt.includes('codex answer') && !calls[2].prompt.includes('<<<ANSWER FROM CLAUDE>>>')); // reviews the other answer
  assert.ok(calls[4].prompt.includes('codex revised'));
  assert.equal(run.final.text, 'claude final');
  assert.equal(run.final.by, 'claude');
  assert.equal(run.reviews.length, 2);
});

test('two review rounds is the hard maximum', async () => {
  const { ask, calls } = fakeAsk();
  const o = createOrchestrator({ ask });
  await o.start({ question: 'Q', mode: 'review', models: ['claude', 'codex', 'gemini'], settings: { ...settings, reviewRounds: 99 } });
  assert.equal(calls.filter((c) => /REVIEW ROUND/.test(c.prompt)).length, 6);
  assert.equal(calls.length, 3 + 6 + 1);
});

test('one failed model does not stop the others; failed combiner falls back to the next model', async () => {
  const { ask } = fakeAsk({ 'codex:answer': 'fail' });
  const run = await createOrchestrator({ ask }).start({ question: 'Q', mode: 'review', models: ['claude', 'codex'], settings });
  assert.equal(run.status, 'partial');
  assert.equal(run.answers.codex.code, 'rate-limited');
  assert.match(run.final.note, /Only Claude answered/);

  const second = await createOrchestrator({ ask: fakeAsk({ 'claude:final': 'fail' }).ask }).start({ question: 'Q', mode: 'review', models: ['claude', 'codex'], settings });
  assert.equal(second.final.by, 'codex');
  assert.match(second.final.note, /Claude could not write the final answer/);
});

test('Stop cancels every running model and a busy orchestrator refuses a second question', async () => {
  const { ask } = fakeAsk({ 'claude:answer': 'hang', 'codex:answer': 'hang' });
  const o = createOrchestrator({ ask });
  const p = o.start({ question: 'Q', mode: 'review', models: ['claude', 'codex'], settings });
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(o.start({ question: 'again', mode: 'compare', models: ['claude'], settings }), /already/);
  assert.equal(o.stop(), true);
  const run = await p;
  assert.equal(run.status, 'stopped');
  assert.equal(run.answers.claude.state, 'stopped');
  assert.equal(o.isBusy(), false);
});

test('Retry re-asks only the failed model and redoes the review', async () => {
  const first = fakeAsk({ 'codex:answer': 'fail' });
  const o = createOrchestrator({ ask: first.ask });
  const run = await o.start({ question: 'Q', mode: 'review', models: ['claude', 'codex'], settings });
  const second = fakeAsk();
  const o2 = createOrchestrator({ ask: second.ask });
  const retried = await o2.retry(run, 'codex', settings);
  assert.equal(second.calls[0].id, 'codex');
  assert.equal(second.calls.filter((c) => !/REVIEW|final answer/.test(c.prompt)).length, 1);
  assert.equal(retried.status, 'complete');
  assert.equal(retried.answers.claude.text, 'claude answer');
});

test('compare mode makes exactly one call per model and no final answer', async () => {
  const { ask, calls } = fakeAsk();
  const run = await createOrchestrator({ ask }).start({ question: 'Q', mode: 'compare', models: ['claude', 'codex', 'claude'], settings });
  assert.equal(calls.length, 2);
  assert.equal(run.final, null);
});

test('Markdown rendering is inert and only allows web and mail links', () => {
  const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) [y](file:///C:/x) [z](https://user:pw@evil.example/) [ok](https://example.com/a?b=1)\n\n![pic](https://example.com/p.png)');
  assert.ok(!/<script|<img|<[^>]*\son\w+=/i.test(html)); // escaped text is fine; real tags/handlers are not
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs.filter((h) => !/^https:\/\/example\.com\//.test(h)), []);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.match(html, /class="ext-link" data-href="https:\/\/example.com\/a\?b=1"/);
  assert.ok(!/href="[^"]*user:pw/.test(html));
  assert.match(html, /Image not loaded/);
  assert.deepEqual(extractLinks('[a](https://a.example/) and https://b.example/x and [a again](https://a.example/)'), ['https://a.example/', 'https://b.example/x']);
  assert.equal(safeUrl('vbscript:x'), null);
  assert.match(render('| a | b |\n|---|---|\n| 1 | 2 |'), /class="table-wrap"/);
  assert.match(render('```js\nx()\n```'), /class="copy-code"/);
});

test('plain-text and speech conversions are readable', () => {
  assert.equal(toPlainText('## Title\n\n**Bold** and `code` [link](https://x.example/)\n\n- one'), 'Title\n\nBold and code link (https://x.example/)\n\n• one');
  const speech = toSpeech('Hello [site](https://x.example/).\n\n```\nrm -rf /\n```\nVisit https://y.example now.');
  assert.ok(!/https?:|rm -rf/.test(speech));
  assert.match(speech, /code omitted/);
});

test('review responses are split into review and revised answer', () => {
  assert.deepEqual(splitReview('## Review\nGood.\n\n## Revised answer\nBetter.'), { review: 'Good.', revised: 'Better.' });
  assert.deepEqual(splitReview('Just text'), { review: 'Just text', revised: '' });
  assert.match(answerPrompt({ question: 'Q', instructions: '', history: [{ question: 'Old', answer: 'Older' }] }), /Earlier question 1: Old/);
});

test('settings, instructions and history persist separately; clearing history keeps instructions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-store-'));
  const s1 = createStore(dir);
  s1.saveSettings({ fontSize: 22, theme: 'dark', enabled: { gemini: true } });
  s1.saveInstructions('Lead with the answer.');
  const id = '11111111-2222-3333-4444-555555555555';
  s1.saveRun({ id: 'r1', conversationId: id, question: 'Hello?', createdAt: 'now', context: [{ secret: true }], answers: {}, final: null });
  const s2 = createStore(dir); // a fresh process reading the same folder
  assert.equal(s2.getSettings().fontSize, 22);
  assert.equal(s2.getSettings().enabled.gemini, true);
  assert.equal(s2.getSettings().enabled.claude, true);
  assert.equal(s2.getInstructions().text, 'Lead with the answer.');
  assert.equal(s2.listConversations()[0].title, 'Hello?');
  assert.equal(s2.getConversation(id).runs[0].context, undefined);
  s2.clearHistory();
  assert.deepEqual(s2.listConversations(), []);
  assert.equal(s2.getInstructions().text, 'Lead with the answer.');
  assert.equal(s2.saveSettings({ fontSize: 400, reviewRounds: 9 }).fontSize, 28);
  assert.throws(() => s2.getConversation('../../etc'));
});

test('Jarvis avatar speech uses the local key only for the localhost request and reports honestly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-jarvis-'));
  const keyFile = path.join(dir, '.env');
  fs.writeFileSync(keyFile, 'OTHER=1\nAPI_KEY="test-key-123"\n');
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  const r = await jarvis.speak('Final **answer**', { fetchImpl, keyFile });
  assert.deepEqual(r, { accepted: true, playbackVerified: false, clipped: false });
  assert.equal(seen[0].url, 'http://127.0.0.1:4000/api/avatar/text');
  assert.equal(seen[0].init.headers['x-api-key'], 'test-key-123');
  assert.ok(!seen[0].init.body.includes('test-key-123'));
  const down = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(jarvis.speak('x', { fetchImpl: down, keyFile }), (e) => /not running/.test(e.message) && !e.message.includes('test-key'));
  await assert.rejects(jarvis.speak('x', { fetchImpl, keyFile: path.join(dir, 'missing') }), /not set up/);
});

test('CLI programs are found in the usual folder, then on PATH, and a chosen location wins when it exists', () => {
  const { locate, candidatePaths, setPathOverrides } = require('../../src/core/adapters');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ron-cli-'));
  const onPath = path.join(dir, 'bin');
  fs.mkdirSync(path.join(onPath, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(onPath, 'claude.exe'), '');
  fs.writeFileSync(path.join(onPath, 'codex.cmd'), '');
  fs.writeFileSync(path.join(onPath, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '');
  const env = { PATH: onPath };
  try {
    setPathOverrides({});
    // The usual install folder comes before PATH.
    const claude = candidatePaths(getProvider('claude'), env);
    assert.equal(claude.at(-1), path.join(onPath, 'claude.exe'));
    // The npm codex.cmd shim on PATH resolves to the real script beside it.
    assert.ok(candidatePaths(getProvider('codex'), env).includes(path.join(onPath, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')));
    // A chosen location is tried first; one that no longer exists falls through to the others.
    const chosen = path.join(dir, 'chosen-claude.exe');
    fs.writeFileSync(chosen, '');
    setPathOverrides({ claude: chosen });
    assert.equal(locate('claude', env), chosen);
    setPathOverrides({ claude: path.join(dir, 'gone.exe') });
    assert.notEqual(locate('claude', env), path.join(dir, 'gone.exe'));
    assert.equal(locate('lmstudio'), null);
  } finally { setPathOverrides({}); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI versions are compared with the tested ones; only meaningful differences warn', () => {
  const { parseVersion, compareVersions, versionNote } = require('../../src/core/adapters');
  assert.equal(parseVersion('2.1.322 (Claude Code)'), '2.1.322');
  assert.equal(parseVersion('codex-cli 0.170.0\n'), '0.170.0');
  assert.equal(parseVersion('no version here'), '');
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  const tested = getProvider('claude').testedVersion;
  const [maj, min, patch] = tested.split('.').map(Number);
  assert.equal(versionNote('claude', tested), '');
  assert.equal(versionNote('claude', `${maj}.${min}.${patch + 5}`), '', 'a newer patch release is not worth a warning');
  assert.match(versionNote('claude', `${maj}.${min + 1}.0`), /newer than the version this app was checked with/);
  assert.match(versionNote('claude', `${maj}.${min}.${Math.max(0, patch - 1)}`), /older/);
  assert.equal(versionNote('claude', ''), '');
});

test('settings keep only program locations for CLI models, and update checks default to on', () => {
  const { mergeSettings } = require('../../src/core/store');
  const s = mergeSettings({ paths: { claude: 'C:/x/claude.exe', lmstudio: 'C:/x.exe', bogus: 'y', codex: '' } });
  assert.deepEqual(s.paths, { claude: 'C:/x/claude.exe' });
  assert.equal(s.autoUpdate, true);
  assert.equal(mergeSettings({ autoUpdate: false }).autoUpdate, false);
});
