'use strict';
// Model adapters: how each locally signed-in agent CLI (or local model server) is asked a
// text-only question. Command lines were checked against the installed versions on
// 2026-11-18 (Claude Code 2.1.322, Codex CLI 0.170.0, Hermes 0.22.7).
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
    defaultPath: () => path.join(os.homedir(), '.local', 'bin', 'claude.exe'), pathNames: ['claude.exe'], testedVersion: '2.1.322',
    // Tools, MCP servers, plugins and session history are all switched off for answering.
    // stream-json (which needs --verbose) delivers the answer piece by piece; its closing
    // "result" event has the same fields the plain json format had.
    args: ({ model }) => ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--safe-mode', '--restricted', '--tools', '',
      '--strict-mcp-config', '--no-session-persistence', ...(model ? ['--model', model] : [])],
    statusArgs: ['auth', 'status'],
    parseStatus: (out) => { try { const s = JSON.parse(out); return s.loggedIn ? { ok: true, detail: `Signed in (${s.authMethod || 'account'})` } : { ok: false, detail: 'Not signed in. Run: claude auth login' }; } catch { return { ok: false, detail: 'Could not read Claude sign-in status.' }; } },
    /** Text added by one stream event, or '' for events that carry no answer text. */
    streamDelta: (event) => (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta' ? String(event.event.delta.text || '') : ''),
    parse: (stdout) => {
      const events = jsonLines(stdout);
      // The closing "result" event; a lone object without a type is the older single-json format.
      const data = events.findLast((e) => e.type === 'result') || (events.length === 1 && !events[0].type && 'result' in events[0] ? events[0] : null);
      if (!data) throw new AdapterError('failed', 'Claude returned no completed answer.');
      if (data.is_error || !String(data.result || '').trim()) throw new AdapterError('failed', String(data.result || 'Claude did not return an answer.'));
      return String(data.result).trim();
    },
  },
  {
    id: 'codex', name: 'Codex', vendor: 'OpenAI · Codex CLI ChatGPT sign-in', kind: 'cli', defaultEnabled: true,
    destination: 'OpenAI (through your Codex/ChatGPT sign-in)',
    runsOnNode: true, testedVersion: '0.170.0',
    defaultPath: () => path.join(appData(), 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    // npm puts a codex.cmd shim on PATH; the real script sits next to it in node_modules.
    pathNames: ['codex.cmd', 'codex'],
    normalize: (file) => (/\.js$/i.test(file) ? file : path.join(path.dirname(file), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')),
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
    id: 'hermes', name: 'Hermes', vendor: 'Nous · Hermes Agent', kind: 'cli', defaultEnabled: false,
    destination: 'The provider configured in Hermes (Nous Portal by default)',
    defaultPath: () => path.join(localAppData(), 'hermes', 'bin', 'hermes.exe'), pathNames: ['hermes.exe'], testedVersion: '0.22.7',
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

/** Every output line that is a JSON object; other lines are ignored. SyntaxError when there is none. */
function jsonLines(stdout) {
  const events = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!events.length) throw new SyntaxError('No JSON in output.');
  return events;
}

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

/** Locations chosen by the user in Settings (provider id → file). Set by the main process. */
const pathOverrides = new Map();
function setPathOverrides(map = {}) {
  pathOverrides.clear();
  for (const [id, file] of Object.entries(map || {})) if (typeof file === 'string' && file.trim()) pathOverrides.set(id, file.trim());
}

function isFile(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }

/** Every place a CLI's program could be, in order: the user's choice, the usual install folder, then PATH. */
function candidatePaths(p, source = process.env) {
  const dirs = String(source.PATH || source.Path || '').split(path.delimiter).filter(Boolean);
  const raw = [pathOverrides.get(p.id), p.defaultPath(), ...dirs.flatMap((d) => (p.pathNames || []).map((n) => path.join(d, n)))].filter(Boolean);
  return [...new Set(raw.map((f) => (p.normalize ? p.normalize(f) : f)))];
}

/** The program (or, for Codex, the script) that will actually run, or null when none is found. */
function locate(id, source = process.env) {
  const p = getProvider(id);
  if (p.kind !== 'cli') return null;
  return candidatePaths(p, source).find(isFile) || null;
}

/** Concrete spawn spec for a CLI provider. */
/** @param {string} id @param {{ model?: string, nodePath?: string }} [opts] */
function spawnSpec(id, { model = '', nodePath } = {}) {
  const p = getProvider(id);
  if (p.kind !== 'cli') throw new AdapterError('failed', `${p.name} is not a command-line agent.`);
  const args = p.args({ model });
  const file = locate(id) || p.defaultPath();
  if (p.runsOnNode) return { command: nodePath || resolveNode(), args: [file, ...args] };
  return { command: file, args };
}

/** Spawn spec for an extra command (status, version) that bypasses the answering arguments. */
function commandSpec(id, extraArgs) {
  const p = getProvider(id);
  const file = locate(id) || p.defaultPath();
  return p.runsOnNode ? { command: resolveNode(), args: [file, ...extraArgs] } : { command: file, args: extraArgs };
}

function installedPath(id) { return locate(id); }

/** First x.y.z in a --version output. */
function parseVersion(text) { return String(text || '').match(/(\d+)\.(\d+)\.(\d+)/)?.[0] || ''; }

/** -1, 0 or 1. Missing parts count as 0. */
function compareVersions(a, b) {
  const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) { const d = (x[i] || 0) - (y[i] || 0); if (d) return Math.sign(d); }
  return 0;
}

/** A plain-English note when the installed CLI differs from the version this app was checked with. */
function versionNote(id, installed) {
  const p = getProvider(id);
  if (!installed || !p.testedVersion) return '';
  const c = compareVersions(installed, p.testedVersion);
  // Patch releases ship often and rarely change command-line switches, so only a newer
  // major or minor version is worth a warning.
  const [maj, min] = installed.split('.').map(Number); const [tMaj, tMin] = p.testedVersion.split('.').map(Number);
  if (c > 0 && (maj > tMaj || (maj === tMaj && min > tMin))) return `${p.name} ${installed} is newer than the version this app was checked with (${p.testedVersion}). If its answers start failing, an update to ${p.name} may have changed how it is started.`;
  if (c < 0) return `${p.name} ${installed} is older than the version this app was checked with (${p.testedVersion}). Some switches this app relies on may be missing; consider updating ${p.name}.`;
  return '';
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

module.exports = {
  PROVIDERS, AdapterError, classifyFailure, childEnvironment, getProvider, spawnSpec, commandSpec, installedPath, locate, candidatePaths,
  setPathOverrides, parseVersion, compareVersions, versionNote, checkedPrompt, checkedAnswer, MAX_PROMPT,
};
