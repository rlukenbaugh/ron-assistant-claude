'use strict';
// Local JSON storage under this app's own data folder. Settings, saved instructions and
// conversation history are separate files so each can be kept or cleared independently.
const fs = require('node:fs');
const path = require('node:path');
const { PROVIDERS } = require('./adapters');

/** Shown and sent until the user saves their own. Kept out of the built-in prompt so it can be edited. */
const DEFAULT_INSTRUCTIONS = 'I am Ron, a retired Windows 11 user. Please use plain English and lead with the answer.';

const DEFAULT_SETTINGS = {
  theme: 'system', // system | light | dark
  fontSize: 18,
  readingWidth: 'comfortable', // narrow | comfortable | wide
  mode: 'review', // compare | review
  enabled: Object.fromEntries(PROVIDERS.map((p) => [p.id, p.defaultEnabled])),
  models: {},
  finalModel: 'auto',
  reviewRounds: 1,
  contextTurns: 3, // earlier questions and final answers sent with a new question (0–10)
  timeoutSec: 180,
  speech: { output: 'windows', autoSpeak: true, muted: false, voice: '', rate: 1 },
  keepHistory: true,
  autoUpdate: true,
  paths: {}, // provider id → program location chosen in Settings (CLI models only)
};

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function mergeSettings(saved) {
  const s = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  // Only models this version knows (Gemini was removed in 0.3.1; an old saved switch is dropped).
  s.enabled = { ...DEFAULT_SETTINGS.enabled, ...Object.fromEntries(Object.entries(saved?.enabled || {}).filter(([id]) => id in DEFAULT_SETTINGS.enabled)) };
  s.speech = { ...DEFAULT_SETTINGS.speech, ...(saved?.speech || {}) };
  // provider id → { model, provider } typed in Settings; only short plain strings are kept.
  const clean = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
  s.models = Object.fromEntries(Object.entries(saved?.models || {}).filter(([, v]) => v && typeof v === 'object')
    .map(([id, v]) => [id, { model: clean(v.model), provider: clean(v.provider) }]));
  s.paths = Object.fromEntries(Object.entries(saved?.paths || {}).filter(([id, v]) => PROVIDERS.some((p) => p.id === id && p.kind === 'cli') && typeof v === 'string' && v.trim()));
  s.autoUpdate = s.autoUpdate !== false;
  s.fontSize = Math.min(28, Math.max(14, Number(s.fontSize) || 18));
  s.reviewRounds = Math.min(2, Math.max(1, Number(s.reviewRounds) || 1));
  const turns = Math.round(Number(s.contextTurns));
  s.contextTurns = Number.isFinite(turns) ? Math.min(10, Math.max(0, turns)) : 3;
  s.timeoutSec = Math.min(600, Math.max(30, Number(s.timeoutSec) || 180));
  if (!['system', 'light', 'dark'].includes(s.theme)) s.theme = 'system';
  if (!['compare', 'review'].includes(s.mode)) s.mode = 'review';
  if (!['windows', 'jarvis', 'off'].includes(s.speech.output)) s.speech.output = 'windows';
  return s;
}

function createStore(dir) {
  const files = {
    settings: path.join(dir, 'settings.json'),
    instructions: path.join(dir, 'instructions.json'),
    history: path.join(dir, 'history'),
  };
  const safeId = (id) => { if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error('Invalid conversation id.'); return id; };

  return {
    dir,
    files,
    getSettings: () => mergeSettings(readJson(files.settings, {})),
    saveSettings(patch) {
      const next = mergeSettings({ ...readJson(files.settings, {}), ...patch });
      writeAtomic(files.settings, JSON.stringify(next, null, 2));
      return next;
    },
    // Until instructions are first saved, the defaults stand in (they describe Ron, who this app is for).
    getInstructions: () => readJson(files.instructions, { text: DEFAULT_INSTRUCTIONS, updatedAt: null }),
    saveInstructions(text) {
      const value = { text: String(text || '').slice(0, 20000), updatedAt: new Date().toISOString() };
      writeAtomic(files.instructions, JSON.stringify(value, null, 2));
      return value;
    },
    listConversations() {
      let names;
      try { names = fs.readdirSync(files.history).filter((n) => n.endsWith('.json')); } catch { return []; }
      return names.map((n) => readJson(path.join(files.history, n), null)).filter(Boolean)
        .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, turns: c.runs?.length || 0 }))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },
    getConversation: (id) => readJson(path.join(files.history, `${safeId(id)}.json`), null),
    saveRun(run) {
      const id = safeId(run.conversationId);
      const file = path.join(files.history, `${id}.json`);
      const convo = readJson(file, { id, title: run.question.slice(0, 80), createdAt: run.createdAt, runs: [] });
      const stored = { ...run };
      delete stored.context;
      const i = convo.runs.findIndex((r) => r.id === run.id);
      if (i >= 0) convo.runs[i] = stored; else convo.runs.push(stored);
      convo.updatedAt = new Date().toISOString();
      writeAtomic(file, JSON.stringify(convo, null, 2));
      return convo;
    },
    deleteConversation(id) { fs.rmSync(path.join(files.history, `${safeId(id)}.json`), { force: true }); },
    clearHistory() { fs.rmSync(files.history, { recursive: true, force: true }); },
  };
}

module.exports = { createStore, mergeSettings, DEFAULT_SETTINGS, DEFAULT_INSTRUCTIONS };
