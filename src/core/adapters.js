'use strict';
// Model adapters: how each locally signed-in agent CLI (or local model server) is asked a
// text-only question. Command lines were checked against the installed versions on
// 2026-11-18 (Claude Code 2.1.322, Codex CLI 0.170.0, Antigravity agy 1.5.11, Hermes 0.22.7).
// Prompts always travel on stdin, never through a shell, so question text cannot become a command.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_PROMPT = 60000;
const MAX_ANSWER = 60000;

function env() { return process.env; }
function localAppData() { return env().LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'); }
function appData() { return env().APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'); }

/** Known providers. `kind: 'cli'` runs a signed-in agent; `kind: 'http'` a local model server. */
const PROVIDERS = [
  {
    id: 'claude', name: 'Claude', vendor: 'Anthropic · Claude Code sign-in', kind: 'cli', defaultEnabled: true,
    destination: 'Anthropic (through your Claude Code sign-in)',
    command: () => path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    // Tools, MCP servers, plugins and session history are all switched off for answering.
    args: ({ model }) => ['-p', '--output-format', 'json', '--safe-mode', '--restricted', '--tools', '',
      '--strict-mcp-config', '--no-session-persistence', ...(model ? ['--model', model] : [])],
    statusArgs: ['auth', 'status'],
    parseStatus: (out) => { try { const s = JSON.parse(out); return s.loggedIn ? { ok: true, detail: `Signed in (${s.authMethod || 'account'})` } : { ok: false, detail: 'Not signed in. Run: claude auth login' }; } catch { return { ok: false, detail: 'Could not read Claude sign-in status.' }; } },
    parse: (stdout) => {
      const data = JSON.parse(stdout);
      if (data.is_error || !String(data.result || '').trim()) throw new AdapterError('failed', String(data.result || 'Claude did not return an answer.'));
      return String(data.result).trim();
    },
  },
  {
    id: 'codex', name: 'Codex', vendor: 'OpenAI · Codex CLI ChatGPT sign-in', kind: 'cli', defaultEnabled: true,
    destination: 'OpenAI (through your Codex/ChatGPT sign-in)',
    command: () => resolveNode(),
    script: () => path.join(appData(), 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    // Read-only sandbox, no shell tool, no sub-agents, no web search, no user MCP config.
    args: ({ model }) => ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
      '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-c', 'features.shell_tool=false',
      '-c', 'agents.enabled=false', '-c', 'web_search="disabled"', ...(model ? ['-m', model] : []), '--json', '-'],
    statusArgs: ['login', 'status'],
    parseStatus: (out) => (/logged in/i.test(out) ? { ok: true, detail: out.trim().split(/\r?\n/)[0] } : { ok: false, detail: 'Not signed in. Run: codex login' }),
    parse: (stdout) => {
      const events = stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const failed = events.find((e) => e.type === 'turn.failed' || e.type === 'error');
      if (failed) throw new AdapterError('failed', String(failed.error?.message || failed.message || 'Codex did not complete.'));
      const answers = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item.text);
      if (!answers.length || !events.some((e) => e.type === 'turn.completed')) throw new AdapterError('failed', 'Codex returned no completed answer.');
      return String(answers.at(-1)).trim();
    },
  },
  {
    id: 'gemini', name: 'Gemini', vendor: 'Google · Antigravity (agy) sign-in', kind: 'cli', defaultEnabled: false,
    destination: 'Google (through your Antigravity sign-in)',
    command: () => path.join(localAppData(), 'agy', 'bin', 'agy.exe'),
    // Plan mode + terminal sandbox, and no auto-approval: tool requests are not granted.
    args: ({ model, timeoutSec }) => ['--mode', 'plan', '--sandbox', '--print-timeout', `${Math.max(30, timeoutSec - 10)}s`,
      '--output-format', 'json', ...(model ? ['--model', model] : [])],
    statusArgs: ['models'],
    parseStatus: (out) => (/gemini/i.test(out) ? { ok: true, detail: 'Signed in (models listed)' } : { ok: false, detail: 'Antigravity did not list models. Open agy and sign in.' }),
    parse: (stdout) => {
      const start = stdout.indexOf('{');
      const data = JSON.parse(stdout.slice(start));
      if (data.status !== 'SUCCESS' || !String(data.response || '').trim()) throw new AdapterError('failed', `Gemini ended with status ${data.status || 'unknown'}.`);
      return String(data.response).trim();
    },
  },
  {
    id: 'hermes', name: 'Hermes', vendor: 'Nous · Hermes Agent', kind: 'cli', defaultEnabled: false,
    destination: 'The provider configured in Hermes (Nous Portal by default)',
    command: () => path.join(localAppData(), 'hermes', 'bin', 'hermes.exe'),
    args: () => ['chat', '--query-file', '-', '-Q', '--safe-mode', '--ignore-rules', '--max-turns', '1'],
    statusArgs: null, // Hermes has no quota-free sign-in check; "Test" sends a tiny question.
    parse: (stdout) => {
      const text = stdout.replace(/\n?(session[_ ]id|Session:).*$/is, '').trim();
      if (!text) throw new AdapterError('failed', 'Hermes returned no answer.');
      if (/no access token|re-authenticate|hermes model/i.test(text)) throw new AdapterError('signin', 'Hermes is not signed in. Run: hermes model');
      return text;
    },
  },
  {
    id: 'lmstudio', name: 'LM Studio (local)', vendor: 'Local model server · 127.0.0.1:1234', kind: 'http', defaultEnabled: false,
    destination: 'Stays on this computer (LM Studio)', baseUrl: 'http://127.0.0.1:1234/v1',
  },
  {
    id: 'ollama', name: 'Ollama (local)', vendor: 'Local model server · 127.0.0.1:11434', kind: 'http', defaultEnabled: false,
    destination: 'Stays on this computer (Ollama)', baseUrl: 'http://127.0.0.1:11434/v1',
  },
];

/** Node.js for script-based CLIs (Codex). Inside Electron, process.execPath is the app itself. */
function resolveNode(source = process.env) {
  if (!/electron|ron assistant/i.test(path.basename(process.execPath))) return process.execPath;
  const dirs = String(source.PATH || source.Path || '').split(path.delimiter).filter(Boolean);
  const candidates = [path.join(source.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'), ...dirs.map((d) => path.join(d, 'node.exe'))];
  return candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || 'node.exe';
}

class AdapterError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Classify a failure so the UI can say "rate-limited" or "sign-in needed" instead of a stack trace. */
function classifyFailure(text) {
  const t = String(text || '');
  if (/rate.?limit|usage limit|quota|429|too many requests|limit reached|try again (later|in)/i.test(t)) return 'rate-limited';
  if (/not (logged|signed) in|log ?in again|login required|unauthori[sz]ed|401|access token|authenticate|expired/i.test(t)) return 'signin';
  return 'failed';
}

/**
 * Environment for child agents: drop anything that looks like a secret (so keys this app or
 * Jarvis may hold are never inherited) and mark the process as a child, which this app and the
 * existing jarvis-agent-bridge both refuse to re-enter. The CLIs use their own saved sign-ins.
 */
function childEnvironment(source = process.env) {
  const out = Object.fromEntries(Object.entries(source).filter(([k]) => !/(API_?KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|^CSC_)/i.test(k)));
  out.RON_ASSISTANT_CHILD = '1';
  out.JARVIS_REVIEW_CHILD = '1';
  delete out.CLAUDECODE;
  delete out.ELECTRON_RUN_AS_NODE;
  delete out.NODE_OPTIONS;
  return out;
}

function getProvider(id) {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new AdapterError('failed', `Unknown model: ${id}`);
  return p;
}

/** Concrete spawn spec for a CLI provider. */
function spawnSpec(id, { model = '', timeoutSec = 180, nodePath } = {}) {
  const p = getProvider(id);
  if (p.kind !== 'cli') throw new AdapterError('failed', `${p.name} is not a command-line agent.`);
  const args = p.args({ model, timeoutSec });
  if (p.script) return { command: nodePath || p.command(), args: [p.script(), ...args] };
  return { command: p.command(), args };
}

function installedPath(id) {
  const p = getProvider(id);
  if (p.kind !== 'cli') return null;
  const file = p.script ? p.script() : p.command();
  return fs.existsSync(file) ? file : null;
}

function checkedPrompt(text) {
  if (typeof text !== 'string' || !text.trim()) throw new AdapterError('failed', 'The question is empty.');
  if (text.length > MAX_PROMPT) throw new AdapterError('failed', `The question and context exceed ${MAX_PROMPT.toLocaleString()} characters.`);
  return text;
}

function checkedAnswer(text) {
  const t = String(text || '').trim();
  if (!t) throw new AdapterError('failed', 'The model returned an empty answer.');
  return t.length > MAX_ANSWER ? `${t.slice(0, MAX_ANSWER)}\n\n_(Answer shortened: it exceeded ${MAX_ANSWER.toLocaleString()} characters.)_` : t;
}

module.exports = { PROVIDERS, AdapterError, classifyFailure, childEnvironment, getProvider, spawnSpec, installedPath, checkedPrompt, checkedAnswer, MAX_PROMPT };
