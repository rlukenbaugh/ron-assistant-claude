'use strict';
// Runs one question against one provider with a hard timeout and a Stop signal.
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const { AdapterError, classifyFailure, childEnvironment, getProvider, spawnSpec, installedPath, checkedPrompt, checkedAnswer, PROVIDERS } = require('./adapters');

function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  else child.kill('SIGTERM');
}

/** Ask a CLI agent. Resolves with answer text; rejects with AdapterError(code: failed|rate-limited|signin|timeout|cancelled). */
function runCli(id, prompt, { signal, timeoutSec = 180, model = '', cwd } = {}) {
  const provider = getProvider(id);
  checkedPrompt(prompt);
  if (!installedPath(id)) return Promise.reject(new AdapterError('missing', `${provider.name} is not installed on this computer.`));
  const spec = spawnSpec(id, { model, timeoutSec });
  if (cwd) fs.mkdirSync(cwd, { recursive: true });
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AdapterError('cancelled', 'Stopped.'));
    const child = spawn(spec.command, spec.args, { cwd, env: childEnvironment(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let ended = null;
    const finish = (code, message) => { if (!ended) { ended = { code, message }; killTree(child); } };
    const timer = setTimeout(() => finish('timeout', `${provider.name} did not answer within ${timeoutSec} seconds.`), timeoutSec * 1000);
    const onAbort = () => finish('cancelled', 'Stopped.');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => { out += d; if (out.length > 4_000_000) finish('failed', `${provider.name} produced too much output.`); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-20000); });
    child.stdin.on('error', () => {});
    child.on('error', (e) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(new AdapterError('missing', `${provider.name} could not start: ${e.message}`)); });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (ended) return reject(new AdapterError(ended.code, ended.message));
      try {
        if (exitCode !== 0 && !out.trim()) throw new AdapterError(classifyFailure(err), summarizeError(provider.name, err, exitCode));
        resolve(checkedAnswer(provider.parse(out)));
      } catch (e) {
        const code = e instanceof AdapterError && e.code !== 'failed' ? e.code : classifyFailure(`${e.message}\n${err}\n${out.slice(-2000)}`);
        reject(new AdapterError(code, e instanceof SyntaxError ? summarizeError(provider.name, err || out, exitCode) : e.message));
      }
    });
    child.stdin.end(prompt);
  });
}

function summarizeError(name, text, exitCode) {
  const line = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((l) => !/^at |^\s*\^/.test(l)).slice(-2).join(' ');
  const safe = line.replace(/(sk|key|token)[-_A-Za-z0-9]{12,}/gi, '[redacted]').slice(0, 300);
  return `${name} stopped (exit ${exitCode})${safe ? `: ${safe}` : '.'}`;
}

/** Ask a local OpenAI-compatible server (LM Studio / Ollama). */
async function runHttp(id, prompt, { signal, timeoutSec = 180, model = '', fetchImpl = fetch } = {}) {
  const provider = getProvider(id);
  checkedPrompt(prompt);
  const timeout = AbortSignal.timeout(timeoutSec * 1000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const chosen = model || (await listLocalModels(provider, fetchImpl))[0];
    if (!chosen) throw new AdapterError('missing', `${provider.name} has no model loaded.`);
    const r = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: combined,
      body: JSON.stringify({ model: chosen, messages: [{ role: 'user', content: prompt }], stream: false }),
    });
    if (!r.ok) throw new AdapterError(r.status === 429 ? 'rate-limited' : 'failed', `${provider.name} returned HTTP ${r.status}.`);
    const body = await r.json();
    return checkedAnswer(body.choices?.[0]?.message?.content);
  } catch (e) {
    if (signal?.aborted) throw new AdapterError('cancelled', 'Stopped.');
    if (timeout.aborted) throw new AdapterError('timeout', `${provider.name} did not answer within ${timeoutSec} seconds.`);
    if (e instanceof AdapterError) throw e;
    throw new AdapterError('missing', `${provider.name} is not running.`);
  }
}

async function listLocalModels(provider, fetchImpl = fetch) {
  const r = await fetchImpl(`${provider.baseUrl}/models`, { signal: AbortSignal.timeout(2500) });
  if (!r.ok) return [];
  const body = await r.json();
  return (body.data || []).map((m) => m.id).filter((m) => m && !/embed/i.test(m));
}

function ask(id, prompt, opts) {
  return getProvider(id).kind === 'http' ? runHttp(id, prompt, opts) : runCli(id, prompt, opts);
}

function execText(command, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(command, args, { env: childEnvironment(), windowsHide: true, timeout: timeoutMs, maxBuffer: 1_000_000 }, (error, stdout, stderr) => resolve({ ok: !error, out: `${stdout || ''}${stderr || ''}` }));
  });
}

/** Quota-free connection check: installed? signed in? (Hermes can only be checked with a real question.) */
async function checkConnection(id, { fetchImpl = fetch } = {}) {
  const p = getProvider(id);
  if (p.kind === 'http') {
    try {
      const models = await listLocalModels(p, fetchImpl);
      return models.length ? { state: 'ready', detail: `Running · ${models.length} model(s): ${models.slice(0, 3).join(', ')}` } : { state: 'unavailable', detail: 'Running, but no model is loaded.' };
    } catch { return { state: 'unavailable', detail: 'Not running on this computer.' }; }
  }
  if (!installedPath(id)) return { state: 'unavailable', detail: 'Not installed on this computer.' };
  if (!p.statusArgs) return { state: 'unknown', detail: 'Installed. Sign-in can only be confirmed with “Test”.' };
  const spec = spawnSpec(id);
  const args = p.script ? [p.script(), ...p.statusArgs] : p.statusArgs;
  const { out } = await execText(spec.command, args, 45000);
  const s = p.parseStatus(out);
  return { state: s.ok ? 'ready' : 'signin', detail: s.detail };
}

async function checkAll(opts) {
  const entries = await Promise.all(PROVIDERS.map(async (p) => [p.id, await checkConnection(p.id, opts).catch((e) => ({ state: 'unavailable', detail: e.message }))]));
  return Object.fromEntries(entries);
}

module.exports = { ask, runCli, runHttp, checkConnection, checkAll, killTree, summarizeError };
