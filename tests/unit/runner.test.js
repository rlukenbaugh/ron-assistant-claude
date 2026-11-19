'use strict';
// The code that starts model programs and talks to local servers, run against stand-ins:
// a small Node script posing as the Codex CLI, and a fake fetch posing as LM Studio.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setPathOverrides } = require('../../src/core/adapters');
const { runCli, runHttp } = require('../../src/core/runner');

// Behaves like `codex exec --json -`: reads the prompt on stdin, prints JSON events.
// The prompt steers it: "SLOW" never answers, "LIMIT" fails with a usage-limit message.
const FAKE_CODEX = `
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (input.includes('SLOW')) { setInterval(() => {}, 1000); return; }
  if (input.includes('LIMIT')) { process.stderr.write('You have hit your usage limit. Try again later.'); process.exit(1); }
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  say({ type: 'thread.started' });
  say({ type: 'item.completed', item: { type: 'agent_message', text: 'echo: ' + input.trim() } });
  say({ type: 'turn.completed' });
});
`;

function withFakeCodex(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ron-fake-codex-'));
    const script = path.join(dir, 'codex.js');
    fs.writeFileSync(script, FAKE_CODEX);
    setPathOverrides({ codex: script });
    try { await fn(dir); } finally { setPathOverrides({}); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

test('a CLI model gets the question on stdin and its answer is parsed', withFakeCodex(async (dir) => {
  const answer = await runCli('codex', 'What is 2 + 2?', { timeoutSec: 20, cwd: path.join(dir, 'work') });
  assert.equal(answer, 'echo: What is 2 + 2?');
  assert.ok(fs.existsSync(path.join(dir, 'work')), 'the empty working folder is created');
}));

test('a usage-limit failure is reported as rate-limited, not as an answer', withFakeCodex(async () => {
  await assert.rejects(runCli('codex', 'LIMIT please', { timeoutSec: 20 }), (e) => e.code === 'rate-limited');
}));

test('a CLI model that does not answer in time is stopped and reported as a time-out', withFakeCodex(async () => {
  const started = Date.now();
  await assert.rejects(runCli('codex', 'SLOW please', { timeoutSec: 1 }), (e) => e.code === 'timeout' && /within 1 seconds/.test(e.message));
  assert.ok(Date.now() - started < 10000);
}));

test('Stop cancels a running CLI model', withFakeCodex(async () => {
  const controller = new AbortController();
  const pending = runCli('codex', 'SLOW please', { timeoutSec: 30, signal: controller.signal });
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(pending, (e) => e.code === 'cancelled');
}));

test('a missing CLI is reported as not installed', async () => {
  setPathOverrides({ codex: path.join(os.tmpdir(), 'does-not-exist', 'codex.js') });
  const saved = { APPDATA: process.env.APPDATA, PATH: process.env.PATH };
  process.env.APPDATA = path.join(os.tmpdir(), 'no-appdata'); process.env.PATH = '';
  try { await assert.rejects(runCli('codex', 'hi', { timeoutSec: 5 }), (e) => e.code === 'missing'); } finally { Object.assign(process.env, saved); setPathOverrides({}); }
});

/** A fetch stand-in for an OpenAI-compatible local server. */
function fakeServer({ stream = null, status = 200, json = null, down = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (down) throw new TypeError('fetch failed');
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'text-embedding-x' }, { id: 'local-llm' }] }), { headers: { 'content-type': 'application/json' } });
    if (status !== 200) return new Response('{}', { status });
    if (stream) return new Response(new Blob([stream]).stream(), { headers: { 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify(json), { headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

test('a local server answer is read, skipping embedding models when picking one', async () => {
  const s = fakeServer({ json: { choices: [{ message: { content: 'Local answer' } }] } });
  assert.equal(await runHttp('lmstudio', 'Hi', { fetchImpl: s.fetchImpl }), 'Local answer');
  assert.equal(s.calls[1].body.model, 'local-llm');
  assert.equal(s.calls[1].body.stream, false);
});

test('a local server streams when the window wants partial text', async () => {
  const s = fakeServer({ stream: 'data: {"choices":[{"delta":{"content":"Str"}}]}\n\ndata: {"choices":[{"delta":{"content":"eamed"}}]}\n\ndata: [DONE]\n\n' });
  const seen = [];
  assert.equal(await runHttp('ollama', 'Hi', { fetchImpl: s.fetchImpl, onText: (t) => seen.push(t) }), 'Streamed');
  assert.equal(s.calls[1].body.stream, true);
  assert.deepEqual(seen, ['Str', 'Streamed']);
});

test('local server failures are classified', async () => {
  await assert.rejects(runHttp('lmstudio', 'Hi', { fetchImpl: fakeServer({ status: 429 }).fetchImpl }), (e) => e.code === 'rate-limited');
  await assert.rejects(runHttp('lmstudio', 'Hi', { fetchImpl: fakeServer({ status: 500 }).fetchImpl }), (e) => e.code === 'failed');
  await assert.rejects(runHttp('lmstudio', 'Hi', { fetchImpl: fakeServer({ down: true }).fetchImpl }), (e) => e.code === 'missing');
});
