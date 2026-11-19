'use strict';
const { app, BrowserWindow, ipcMain, shell, clipboard, Menu, nativeTheme, session, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createStore } = require('../core/store');
const { createOrchestrator } = require('../core/orchestrator');
const runner = require('../core/runner');
const markdown = require('../core/markdown');
const jarvis = require('../core/jarvis');
const { PROVIDERS, setPathOverrides, getProvider } = require('../core/adapters');
const { createFakeAsk } = require('../core/fakeAgents');
const { createUpdater } = require('./updater');

// A model answering a question must never be able to start this app (no recursive delegation).
if (process.env.RON_ASSISTANT_CHILD) { process.stderr.write('Ron Assistant refuses to start inside one of its own model sessions.\n'); app.exit(2); }

// Separate data folder from the original Jarvis (%APPDATA%\Jarvis) and its server data.
const dataDir = process.env.RON_ASSISTANT_DATA_DIR || path.join(app.getPath('appData'), 'ron-assistant-claude');
app.setPath('userData', dataDir);
app.setAppUserModelId('com.rlukenbaugh.ronassistant.claude');

const fake = process.env.RON_ASSISTANT_FAKE === '1';
const store = createStore(dataDir);
setPathOverrides(store.getSettings().paths);
const logFile = path.join(dataDir, 'logs', 'app.log');
const LOG_LIMIT = 1_000_000; // bytes; one older file (app.log.1) is kept
function log(line) {
  // Status only: never question text, answers, or keys.
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    try { if (fs.statSync(logFile).size > LOG_LIMIT) fs.renameSync(logFile, `${logFile}.1`); } catch { /* no log yet */ }
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging is best effort */ }
}
function errorLine(e) {
  // Error name, message and the first stack frames. Messages from adapters are already redacted.
  if (!(e instanceof Error)) return String(e).slice(0, 300);
  const frames = String(e.stack || '').split('\n').slice(1, 5).map((l) => l.trim()).join(' | ');
  return `${e.name}: ${String(e.message).slice(0, 300)}${frames ? ` | ${frames}` : ''}`;
}
process.on('uncaughtException', (e) => log(`ERROR uncaught exception: ${errorLine(e)}`));
process.on('unhandledRejection', (e) => log(`ERROR unhandled rejection: ${errorLine(e)}`));
app.on('child-process-gone', (_e, d) => log(`ERROR ${d.type} process gone: ${d.reason} (exit ${d.exitCode})`));

let win = null;
const runs = new Map(); // run id → latest run (for Retry), this session only
const sessionContext = new Map(); // conversation id → [{question, answer}] when history is off
const updater = createUpdater({
  log,
  send: (status) => { if (win && !win.isDestroyed()) win.webContents.send('update:status', status); },
  fakeVersion: fake ? (process.env.RON_ASSISTANT_FAKE_UPDATE || '') : '',
});

const ask = fake ? createFakeAsk({ logFile: process.env.RON_ASSISTANT_FAKE_LOG }) : runner.ask;
const orchestrator = createOrchestrator({
  ask,
  emit: (event) => {
    if (event.type === 'run') {
      runs.set(event.run.id, event.run);
      if (win && !win.isDestroyed()) win.webContents.send('run:update', event.run);
    }
  },
});

function runSettings() {
  const s = store.getSettings();
  return { ...s, instructions: store.getInstructions().text, workDir: path.join(dataDir, 'work') };
}

function contextFor(conversationId) {
  if (!conversationId) return [];
  const convo = store.getSettings().keepHistory ? store.getConversation(conversationId) : null;
  const turns = convo ? convo.runs.map((r) => ({ question: r.question, answer: r.final?.text || Object.values(r.answers || {}).find((a) => a.state === 'done')?.text || '' })) : (sessionContext.get(conversationId) || []);
  return turns.filter((t) => t.answer);
}

function remember(run) {
  const answer = run.final?.text || Object.values(run.answers).find((a) => a.state === 'done')?.text || '';
  const list = sessionContext.get(run.conversationId) || [];
  const i = list.findIndex((t) => t.id === run.id);
  const entry = { id: run.id, question: run.question, answer };
  if (i >= 0) list[i] = entry; else list.push(entry);
  sessionContext.set(run.conversationId, list.slice(-10));
  if (store.getSettings().keepHistory && run.status !== 'running') store.saveRun(run);
  log(`run ${run.id.slice(0, 8)} mode=${run.mode} status=${run.status} models=${Object.values(run.answers).map((a) => `${a.id}:${a.state}`).join(',')}`);
}

function providerInfo() {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name, vendor: p.vendor, kind: p.kind, destination: p.destination }));
}

function createWindow() {
  const s = store.getSettings();
  nativeTheme.themeSource = s.theme;
  win = new BrowserWindow({
    width: 1280, height: 900, minWidth: 760, minHeight: 560, show: false,
    title: 'Ron Assistant', backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#f6f7f9',
    icon: path.join(__dirname, '..', '..', 'build', 'icons', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // If the page crashes, log it and reload rather than leaving a blank window. Give up after
  // three crashes in a minute so a page that crashes on load does not loop forever.
  let crashes = [];
  win.webContents.on('render-process-gone', (_e, d) => {
    log(`ERROR window process gone: ${d.reason} (exit ${d.exitCode})`);
    if (d.reason === 'clean-exit' || win.isDestroyed()) return;
    crashes = crashes.filter((t) => Date.now() - t < 60000).concat(Date.now());
    if (crashes.length <= 3) win.webContents.reload();
  });
  win.on('unresponsive', () => log('window became unresponsive'));
  win.on('responsive', () => log('window responsive again'));
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') log(`ERROR page: ${String(details.message).slice(0, 300)} (${path.basename(String(details.sourceId || ''))}:${details.lineNumber})`);
  });
  // Nothing inside the window may navigate away or open windows; links go to the default browser.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('context-menu', (_e, params) => {
    const items = [];
    if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
    else if (params.selectionText) items.push({ role: 'copy' }, { type: 'separator' }, { role: 'selectAll' });
    else items.push({ role: 'selectAll' });
    if (params.misspelledWord && params.dictionarySuggestions.length) items.unshift(...params.dictionarySuggestions.slice(0, 4).map((w) => ({ label: w, click: () => win.webContents.replaceMisspelling(w) })), { type: 'separator' });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function openExternal(url) {
  const safe = markdown.safeUrl(url);
  if (!safe) { log('blocked unsafe link scheme'); return false; }
  shell.openExternal(safe);
  return true;
}

async function checkLink(url) {
  const safe = markdown.safeUrl(url);
  if (!safe || !/^https?:/i.test(safe)) return { ok: false, detail: 'Not a web link.' };
  for (const method of ['HEAD', 'GET']) {
    try {
      const r = await fetch(safe, { method, redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'RonAssistant-LinkCheck/0.1' } });
      if (method === 'HEAD' && (r.status === 405 || r.status === 403)) continue;
      return { ok: r.ok, status: r.status, finalUrl: r.url, detail: r.ok ? `Page responded (HTTP ${r.status}). Its content was not reviewed.` : `Page returned HTTP ${r.status}.` };
    } catch (e) { if (method === 'GET') return { ok: false, detail: `Could not reach the page (${e.name === 'TimeoutError' ? 'timed out' : 'connection failed'}).` }; }
  }
  return { ok: false, detail: 'Could not check this link.' };
}

function registerIpc() {
  ipcMain.handle('app:init', () => ({
    settings: store.getSettings(), instructions: store.getInstructions(), providers: providerInfo(),
    conversations: store.getSettings().keepHistory ? store.listConversations() : [], version: app.getVersion(), fake, dataDir,
  }));
  ipcMain.handle('settings:save', (_e, patch) => {
    // Program locations can only be changed through the file picker below, never by the page.
    const safePatch = { ...(patch || {}) };
    delete safePatch.paths;
    const s = store.saveSettings(safePatch);
    nativeTheme.themeSource = s.theme;
    if ('autoUpdate' in safePatch) updater.schedule(s.autoUpdate);
    return s;
  });
  ipcMain.handle('instructions:save', (_e, text) => store.saveInstructions(text));
  ipcMain.handle('connections:check', async () => (fake ? Object.fromEntries(PROVIDERS.map((p) => [p.id, ['claude', 'codex', 'gemini'].includes(p.id) ? { state: 'ready', detail: 'Test double' } : { state: 'unavailable', detail: 'Not installed on this computer.' }])) : runner.checkAll()));
  ipcMain.handle('connections:choosePath', async (_e, id) => {
    const p = getProvider(id);
    if (p.kind !== 'cli') throw new Error(`${p.name} is not a program on this computer.`);
    const picked = await dialog.showOpenDialog(win, {
      title: `Where is ${p.name} installed?`, properties: ['openFile'],
      filters: [{ name: p.runsOnNode ? 'Program or script' : 'Program', extensions: p.runsOnNode ? ['js', 'cmd'] : ['exe'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const file = picked.filePaths[0];
    const s = store.saveSettings({ paths: { ...store.getSettings().paths, [id]: file } });
    setPathOverrides(s.paths);
    log(`program location set for ${id}`);
    return { settings: s, connection: fake ? { state: 'ready', detail: 'Test double' } : await runner.checkConnection(id) };
  });
  ipcMain.handle('connections:resetPath', async (_e, id) => {
    const paths = { ...store.getSettings().paths };
    delete paths[id];
    // saveSettings merges, so write the whole object without this entry.
    const s = store.saveSettings({ paths });
    setPathOverrides(s.paths);
    return { settings: s, connection: fake ? { state: 'ready', detail: 'Test double' } : await runner.checkConnection(id) };
  });
  ipcMain.handle('connections:test', async (_e, id) => {
    const started = Date.now();
    try {
      const text = await ask(id, 'Reply with exactly: CONNECTED', { timeoutSec: 120, cwd: path.join(dataDir, 'work') });
      return { state: 'ready', detail: `Answered in ${Math.round((Date.now() - started) / 1000)} s${/CONNECTED/.test(text) ? '' : ' (unexpected wording)'}.` };
    } catch (e) { return { state: e.code === 'signin' ? 'signin' : e.code === 'rate-limited' ? 'rate-limited' : 'unavailable', detail: e.message }; }
  });
  ipcMain.handle('ask:start', async (_e, { question, mode, models, conversationId }) => {
    const run = await orchestrator.start({ question, mode, models, conversationId, settings: runSettings(), context: contextFor(conversationId) });
    remember(run);
    return run;
  });
  ipcMain.handle('ask:retry', async (_e, { runId, modelId }) => {
    const previous = runs.get(runId) || findStoredRun(runId);
    if (!previous) throw new Error('That answer is no longer available to retry. Ask again instead.');
    const run = await orchestrator.retry({ ...previous, context: contextFor(previous.conversationId).filter((t) => t.question !== previous.question) }, modelId, runSettings());
    remember(run);
    return run;
  });
  ipcMain.handle('ask:stop', () => orchestrator.stop());
  ipcMain.handle('history:list', () => (store.getSettings().keepHistory ? store.listConversations() : []));
  ipcMain.handle('history:get', (_e, id) => store.getConversation(id));
  ipcMain.handle('history:delete', (_e, id) => { store.deleteConversation(id); return true; });
  ipcMain.handle('history:clear', () => { store.clearHistory(); return true; });
  ipcMain.handle('md:render', (_e, texts) => (Array.isArray(texts) ? texts : [texts]).map((t) => ({ html: markdown.render(t), links: markdown.extractLinks(t) })));
  ipcMain.handle('md:plain', (_e, text) => markdown.toPlainText(text));
  ipcMain.handle('md:speech', (_e, text) => markdown.toSpeech(text));
  ipcMain.handle('link:open', (_e, url) => openExternal(url));
  ipcMain.handle('link:check', (_e, url) => checkLink(url));
  ipcMain.handle('clipboard:write', (_e, { text, html }) => {
    clipboard.write(html ? { text: String(text || ''), html: String(html) } : { text: String(text || '') });
    return true;
  });
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('jarvis:status', () => jarvis.status());
  ipcMain.handle('jarvis:speak', async (_e, text) => {
    const speech = markdown.toSpeech(text);
    const r = await jarvis.speak(speech);
    log('jarvis avatar accepted final answer');
    return r;
  });
  ipcMain.handle('app:openDataFolder', () => shell.openPath(dataDir));
  ipcMain.handle('update:status', () => updater.status());
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:install', () => updater.install());
}

function findStoredRun(runId) {
  for (const c of store.listConversations()) {
    const convo = store.getConversation(c.id);
    const run = convo?.runs.find((r) => r.id === runId);
    if (run) return run;
  }
  return null;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    // Deny camera, microphone, notifications and similar requests: this app does not need them.
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }));
    registerIpc();
    createWindow();
    updater.schedule(store.getSettings().autoUpdate);
    log(`started v${app.getVersion()}${fake ? ' (test models)' : ''}`);
  });
  app.on('before-quit', () => orchestrator.stop());
  app.on('window-all-closed', () => app.quit());
}
