/* global ron */
'use strict';

// ---------- small helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v; // only ever Markdown rendered and sanitised by the main process
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

const state = {
  settings: null, instructions: '', providers: [], connections: {}, conversationId: null,
  runs: new Map(), ui: new Map(), md: new Map(), busy: false, spoken: new Set(), lastFinal: '', fake: false,
};
const nameOf = (id) => state.providers.find((p) => p.id === id)?.name || id;
const STATE_LABEL = { queued: 'Waiting', running: 'Thinking…', done: 'Answered', failed: 'Failed', stopped: 'Stopped', 'rate-limited': 'Rate-limited' };

let toastTimer = null;
function toast(message) {
  const t = $('#toast');
  t.textContent = message; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

// ---------- appearance ----------
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyAppearance() {
  const s = state.settings;
  const dark = s.theme === 'dark' || (s.theme === 'system' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.setProperty('--reading-size', `${s.fontSize}px`);
  document.documentElement.style.setProperty('--reading-width', { narrow: '64ch', comfortable: '78ch', wide: '104ch' }[s.readingWidth] || '78ch');
  $$('.mode-switch button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === s.mode)));
  $('#btn-mute').setAttribute('aria-pressed', String(s.speech.muted));
  $('#btn-mute').textContent = s.speech.muted ? '🔇' : '🔊';
  $('#btn-mute').title = s.speech.muted ? 'Unmute spoken answers' : 'Mute spoken answers';
  $('#composer-hint').textContent = `${s.mode === 'review' ? 'Review together' : 'Compare'} · ${enabledModels().map(nameOf).join(', ') || 'no models on'} · Ctrl+Enter to ask`;
}
darkQuery.addEventListener('change', () => state.settings && applyAppearance());

async function saveSettings(patch) {
  state.settings = await ron.saveSettings(patch);
  applyAppearance();
  renderChips();
  return state.settings;
}

// ---------- models ----------
function usable(id) { const c = state.connections[id]; return !c || c.state !== 'unavailable'; }
function enabledModels() { return state.providers.map((p) => p.id).filter((id) => state.settings.enabled[id] && usable(id)); }

function renderChips() {
  const box = $('#model-chips');
  box.replaceChildren(...state.providers.filter((p) => usable(p.id) || state.settings.enabled[p.id] || p.kind === 'cli').map((p) => {
    const c = state.connections[p.id] || { state: 'checking', detail: 'Checking…' };
    const on = Boolean(state.settings.enabled[p.id]) && c.state !== 'unavailable';
    return h('button', {
      type: 'button', class: `chip${c.state === 'unavailable' ? ' unavailable' : ''}`, 'aria-pressed': String(on), 'data-model': p.id,
      title: `${p.name}: ${c.detail}${c.state === 'unavailable' ? ' (cannot be used)' : ''}`,
      onclick: () => {
        if (c.state === 'unavailable') { toast(`${p.name} is unavailable: ${c.detail}`); return; }
        if (c.state === 'signin') toast(`${p.name} may need signing in: ${c.detail}`);
        saveSettings({ enabled: { ...state.settings.enabled, [p.id]: !state.settings.enabled[p.id] } });
      },
    }, h('span', { class: `dot ${c.state}`, 'aria-hidden': 'true' }), p.name, c.state === 'unavailable' ? h('span', { class: 'sr-only', text: '(unavailable)' }) : null);
  }));
}

async function refreshConnections() {
  state.connections = await ron.checkConnections();
  renderChips(); renderConnections(); applyAppearance();
}

// ---------- markdown ----------
async function ensureRendered(texts) {
  const missing = [...new Set(texts.filter((t) => t && !state.md.has(t)))];
  if (!missing.length) return;
  const out = await ron.render(missing);
  missing.forEach((t, i) => state.md.set(t, out[i]));
}
function answerNode(text) {
  const r = state.md.get(text) || { html: '', links: [] };
  return h('div', { class: 'answer', html: r.html });
}
function linksNode(text, who) {
  const links = state.md.get(text)?.links || [];
  if (!links.length) return null;
  return h('div', { class: 'links' },
    h('h4', { text: `Links suggested by ${who} — not checked` }),
    h('ul', {}, links.map((url) => {
      const result = h('span', { class: 'check-result small' });
      return h('li', {},
        h('button', { type: 'button', class: 'url', text: url, title: 'Open in your browser', onclick: () => openLink(url) }),
        h('button', { type: 'button', class: 'btn btn-small', text: 'Check link', onclick: async (e) => {
          e.target.disabled = true; result.textContent = 'Checking…'; result.className = 'check-result small';
          const r = await ron.checkLink(url);
          result.textContent = r.detail; result.classList.add(r.ok ? 'ok' : 'bad'); e.target.disabled = false;
        } }), result);
    })));
}
async function openLink(url) {
  const ok = await ron.openLink(url);
  toast(ok ? 'Opened in your default browser' : 'That link type is blocked for safety');
}

// ---------- copy ----------
async function copyAs(markdown, format, label) {
  const text = format === 'markdown' ? markdown : await ron.plain(markdown);
  await ron.copy({ text });
  toast(`Copied ${label} as ${format === 'markdown' ? 'Markdown' : 'plain text'}`);
}
function copyMenu(label, getMarkdown, buttonText = 'Copy') {
  const wrap = h('span', { class: 'menu-wrap' });
  const menu = h('div', { class: 'menu', role: 'menu', hidden: true },
    h('button', { type: 'button', role: 'menuitem', text: 'Copy as plain text', onclick: () => { menu.hidden = true; copyAs(getMarkdown(), 'plain', label); } }),
    h('button', { type: 'button', role: 'menuitem', text: 'Copy as Markdown', onclick: () => { menu.hidden = true; copyAs(getMarkdown(), 'markdown', label); } }));
  const btn = h('button', { type: 'button', class: 'btn btn-small', 'aria-haspopup': 'menu', text: `${buttonText} ▾`, onclick: (e) => {
    e.stopPropagation();
    $$('.menu').forEach((m) => { if (m !== menu) m.hidden = true; });
    menu.hidden = !menu.hidden;
  } });
  wrap.append(btn, menu);
  return wrap;
}
document.addEventListener('click', () => $$('.menu').forEach((m) => { m.hidden = true; }));

function discussionMarkdown(run) {
  const parts = [`# Question\n\n${run.question}`];
  if (run.final?.state === 'done') parts.push(`## Final answer (written by ${nameOf(run.final.by)})\n\n${run.final.text}${run.final.note ? `\n\n_${run.final.note}_` : ''}`);
  for (const id of run.models) {
    const a = run.answers[id];
    parts.push(`## ${nameOf(id)}'s independent answer\n\n${a?.state === 'done' ? a.text : `_(${a?.error || 'No answer'})_`}`);
  }
  if (run.reviews?.length) {
    parts.push('## Review discussion');
    for (const r of run.reviews) parts.push(`### Round ${r.round} — ${r.name}\n\n${r.state === 'done' ? r.text : `_(${r.error || 'No review'})_`}`);
  }
  return parts.join('\n\n');
}

// ---------- run rendering ----------
function uiFor(run) {
  if (!state.ui.has(run.id)) state.ui.set(run.id, { tab: run.models[0], grid: run.mode === 'compare', discussionOpen: false });
  return state.ui.get(run.id);
}

function badge(label, st) {
  return h('span', { class: `badge ${st}` }, st === 'running' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null, label);
}

function progressNode(run) {
  const items = run.models.map((id) => {
    const a = run.answers[id] || { state: 'queued' };
    const st = a.code === 'rate-limited' ? 'rate-limited' : a.state;
    return badge(`${nameOf(id)}: ${STATE_LABEL[st] || st}${a.ms && a.state === 'done' ? ` (${Math.round(a.ms / 1000)} s)` : ''}`, st);
  });
  if (run.mode === 'review') {
    const rv = run.reviews || [];
    if (rv.length) items.push(badge(`Review: ${rv.filter((r) => r.state === 'done').length}/${rv.length}`, rv.some((r) => r.state === 'running') ? 'running' : 'done'));
    if (run.final) items.push(badge(`Final answer: ${STATE_LABEL[run.final.state] || run.final.state}`, run.final.state));
  }
  if (run.status === 'stopped') items.push(badge('Stopped by you', 'stopped'));
  return h('div', { class: 'progress', 'aria-label': 'Progress' }, items);
}

function retryButton(run, id) {
  return h('button', { type: 'button', class: 'btn btn-small', text: `Retry ${nameOf(id)}`, disabled: state.busy, onclick: () => retryModel(run, id) });
}

function modelBody(run, id) {
  const a = run.answers[id];
  if (!a || a.state === 'queued' || a.state === 'running') return h('p', { class: 'muted' }, badge(`${nameOf(id)} is ${a?.state === 'running' ? 'thinking' : 'waiting'}…`, a?.state || 'queued'));
  if (a.state !== 'done') {
    const why = a.code === 'rate-limited' ? 'hit a usage or rate limit' : a.code === 'signin' ? 'needs signing in' : a.code === 'timeout' ? 'ran out of time' : a.code === 'cancelled' ? 'was stopped' : 'could not answer';
    const hint = a.code === 'failed' && state.connections[id]?.warning ? h('p', { class: 'small muted', text: state.connections[id].warning }) : null;
    return h('div', {}, h('div', { class: 'error-box', role: 'alert' }, h('strong', { text: `${nameOf(id)} ${why}. ` }), a.error || ''), hint, run.status !== 'running' ? retryButton(run, id) : null);
  }
  return h('div', {}, answerNode(a.text), linksNode(a.text, nameOf(id)));
}

function modelActions(run, id) {
  const a = run.answers[id];
  if (!a || a.state !== 'done') return [];
  return [copyMenu(`${nameOf(id)}'s answer`, () => a.text), h('button', { type: 'button', class: 'btn btn-small', text: 'Read aloud', onclick: () => speak(a.text, { manual: true }) })];
}

function modelsPanel(run) {
  const ui = uiFor(run);
  const head = h('div', { class: 'panel-head' },
    h('h3', { text: run.mode === 'compare' ? 'Answers from each model' : 'Each model’s own answer' }), h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn btn-small', 'aria-pressed': String(ui.grid), text: ui.grid ? 'Show as tabs' : 'Show side by side', onclick: () => { ui.grid = !ui.grid; renderRun(run); } }));
  if (ui.grid) {
    return h('section', { class: 'panel models' }, head, h('div', { class: 'grid' }, run.models.map((id) => h('div', { class: 'model-col', 'data-model-panel': id },
      h('h3', {}, h('span', { class: `dot ${run.answers[id]?.state === 'done' ? 'ready' : run.answers[id]?.state === 'running' ? 'unknown' : 'unavailable'}` }), nameOf(id), h('span', { class: 'spacer' })),
      h('div', { class: 'row' }, modelActions(run, id)), modelBody(run, id)))));
  }
  if (!run.models.includes(ui.tab)) ui.tab = run.models[0];
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Model answers' }, run.models.map((id) => {
    const a = run.answers[id];
    return h('button', { type: 'button', role: 'tab', class: 'tab', id: `tab-${run.id}-${id}`, 'aria-selected': String(ui.tab === id), 'aria-controls': `panel-${run.id}`, 'data-model-tab': id,
      onclick: () => { ui.tab = id; renderRun(run); },
      onkeydown: (e) => {
        const i = run.models.indexOf(ui.tab);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { ui.tab = run.models[(i + (e.key === 'ArrowRight' ? 1 : run.models.length - 1)) % run.models.length]; renderRun(run).then(() => $(`#tab-${run.id}-${ui.tab}`)?.focus()); }
      } },
    h('span', { class: `dot ${a?.state === 'done' ? 'ready' : a?.state === 'running' || a?.state === 'queued' ? 'unknown' : 'unavailable'}`, 'aria-hidden': 'true' }), nameOf(id));
  }));
  const body = h('div', { class: 'panel-body', role: 'tabpanel', id: `panel-${run.id}`, 'aria-labelledby': `tab-${run.id}-${ui.tab}`, 'data-model-panel': ui.tab },
    h('div', { class: 'row' }, modelActions(run, ui.tab)), modelBody(run, ui.tab));
  return h('section', { class: 'panel models' }, head, tabs, body);
}

function contributors(run) {
  return run.models.map((id) => {
    const roles = [];
    if (run.answers[id]?.state === 'done') roles.push('answered');
    if ((run.reviews || []).some((r) => r.id === id && r.state === 'done')) roles.push('reviewed');
    if (run.final?.by === id && run.final.state === 'done') roles.push('wrote the final answer');
    return `${nameOf(id)}: ${roles.length ? roles.join(', ') : 'did not contribute'}`;
  }).join(' · ');
}

function finalPanel(run) {
  const f = run.final;
  let body;
  if (!f || f.state === 'queued' || f.state === 'running') {
    const phase = run.phase === 'review' ? 'The models are reviewing each other’s answers…' : f?.state === 'running' ? `${nameOf(f.by)} is writing the final answer…` : 'Waiting for the models to answer…';
    body = run.status === 'running' ? h('p', { class: 'muted' }, badge(phase, 'running')) : h('p', { class: 'muted', text: 'No final answer was produced.' });
  } else if (f.state === 'failed') {
    body = h('div', { class: 'error-box', role: 'alert', text: f.error || 'No final answer could be produced.' });
  } else {
    body = h('div', {}, answerNode(f.text), f.note ? h('p', { class: 'note', text: f.note }) : null, linksNode(f.text, nameOf(f.by)));
  }
  const done = f?.state === 'done';
  return h('section', { class: 'panel final', 'aria-label': 'Final answer' },
    h('div', { class: 'panel-head' },
      h('h2', { text: 'Final answer' }),
      done ? h('span', { class: 'byline', text: `Written by ${nameOf(f.by)}${run.models.length > 1 ? ' after the review' : ''}` }) : null,
      h('span', { class: 'spacer' }),
      done ? copyMenu('final answer', () => f.text) : null,
      done ? h('button', { type: 'button', class: 'btn btn-small', text: 'Read aloud', onclick: () => speak(f.text, { manual: true, final: true }) }) : null),
    h('div', { class: 'panel-body' }, body, done ? h('p', { class: 'byline', text: `Contributions — ${contributors(run)}` }) : null));
}

function discussionPanel(run) {
  const reviews = run.reviews || [];
  if (run.mode !== 'review' || !reviews.length) return null;
  const ui = uiFor(run);
  const det = h('details', { class: 'panel discussion', open: ui.discussionOpen || undefined, ontoggle: (e) => { ui.discussionOpen = e.target.open; } },
    h('summary', { text: `Review discussion (${reviews.filter((r) => r.state === 'done').length} of ${reviews.length} reviews)` }),
    reviews.map((r) => h('div', { class: 'turn' },
      h('h4', { text: `Round ${r.round} · ${r.name} reviewed the other answers` }),
      r.state === 'done' ? [answerNode(r.review || r.text), r.revised ? h('details', {}, h('summary', { text: `${r.name}'s revised answer` }), answerNode(r.revised)) : null]
        : r.state === 'running' || r.state === 'queued' ? badge('Reviewing…', 'running') : h('div', { class: 'error-box', text: r.error || 'This review did not finish.' }))));
  return det;
}

function textsOf(run) {
  const t = Object.values(run.answers).map((a) => a.text);
  (run.reviews || []).forEach((r) => t.push(r.review || r.text, r.revised));
  if (run.final?.text) t.push(run.final.text);
  return t.filter(Boolean);
}

const renderSeq = new Map();
async function renderRun(run) {
  const seq = (renderSeq.get(run.id) || 0) + 1;
  renderSeq.set(run.id, seq);
  await ensureRendered(textsOf(run));
  if (renderSeq.get(run.id) !== seq) return;
  $('#welcome')?.remove();
  let el = document.getElementById(`run-${run.id}`);
  const fresh = !el;
  if (fresh) { el = h('article', { class: 'run', id: `run-${run.id}`, 'data-run': run.id }); $('#thread').append(el); }
  const running = run.status === 'running';
  el.classList.toggle('wide', uiFor(run).grid && run.models.length > 1);
  el.replaceChildren(...[
    h('div', { class: 'question' }, h('span', { class: 'label', text: `You asked · ${run.mode === 'review' ? 'Review together' : 'Compare'}` }), run.question),
    progressNode(run),
    run.mode === 'review' ? finalPanel(run) : null,
    modelsPanel(run),
    discussionPanel(run),
    h('div', { class: 'run-actions' },
      copyMenu('complete discussion', () => discussionMarkdown(run), 'Copy complete discussion'),
      h('button', { type: 'button', class: 'btn btn-small', text: 'Regenerate', disabled: state.busy || running, title: 'Ask the same question again', onclick: () => ask(run.question, run.mode, run.models) })),
  ].filter(Boolean));
  if (fresh) el.scrollIntoView({ block: 'start' });
}

function onRunUpdate(run) {
  state.runs.set(run.id, run);
  if (run.conversationId && !state.conversationId) state.conversationId = run.conversationId;
  if (run.conversationId !== state.conversationId) return;
  renderRun(run);
  maybeAutoSpeak(run);
}

// ---------- asking ----------
function setBusy(busy) {
  state.busy = busy;
  $('#btn-stop').hidden = !busy;
  $('#btn-ask').disabled = busy;
  $('#btn-ask').textContent = busy ? 'Answering…' : 'Ask';
}

async function ask(question, mode = state.settings.mode, models = enabledModels()) {
  if (state.busy) { toast('Still answering. Press Stop first.'); return; }
  if (!question.trim()) { toast('Type a question first.'); $('#question').focus(); return; }
  if (!models.length) { toast('Turn on at least one model above.'); return; }
  stopSpeaking();
  setBusy(true);
  try {
    const run = await ron.ask({ question, mode, models, conversationId: state.conversationId });
    state.conversationId = run.conversationId;
    onRunUpdate(run);
    refreshHistory();
  } catch (e) {
    toast(cleanError(e));
    if (!$('#question').value) $('#question').value = question;
  } finally { setBusy(false); rerenderAll(); }
}

async function retryModel(run, id) {
  if (state.busy) return;
  setBusy(true);
  try { onRunUpdate(await ron.retry({ runId: run.id, modelId: id })); refreshHistory(); } catch (e) { toast(cleanError(e)); } finally { setBusy(false); rerenderAll(); }
}

function rerenderAll() { for (const run of state.runs.values()) if (run.conversationId === state.conversationId && document.getElementById(`run-${run.id}`)) renderRun(run); }
function cleanError(e) { return String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }

// ---------- speech ----------
let speaking = false;
function setSpeaking(on) { speaking = on; $('#btn-stop-speech').disabled = !on; }
function stopSpeaking() { window.speechSynthesis.cancel(); setSpeaking(false); }

function chunks(text) {
  const out = []; let cur = '';
  for (const s of text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]*\s*/g) || []) {
    if ((cur + s).length > 220 && cur) { out.push(cur); cur = ''; }
    cur += s;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

async function windowsSpeak(text) {
  stopSpeaking();
  const voices = window.speechSynthesis.getVoices();
  const voice = voices.find((v) => v.name === state.settings.speech.voice) || voices.find((v) => /en[-_]US/i.test(v.lang)) || null;
  const parts = chunks(text);
  if (!parts.length) return;
  setSpeaking(true);
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p);
    if (voice) u.voice = voice;
    u.rate = Number(state.settings.speech.rate) || 1;
    if (i === parts.length - 1) { u.onend = () => setSpeaking(false); u.onerror = () => setSpeaking(false); }
    window.speechSynthesis.speak(u);
  });
}

async function speak(markdown, { manual = false, final = false } = {}) {
  const s = state.settings.speech;
  if (s.muted) { if (manual) toast('Voice is muted. Press 🔇 to unmute.'); return; }
  if (s.output === 'off' && !manual) return;
  if (final) { state.lastFinal = markdown; $('#btn-replay').disabled = false; }
  const text = await ron.speechText(markdown);
  if (s.output === 'jarvis' && final) {
    try {
      const r = await ron.jarvisSpeak(markdown);
      toast(r.clipped ? 'Sent to the JARVIS avatar (long answer shortened for speech)' : 'Sent to the JARVIS avatar');
      return;
    } catch (e) { toast(`JARVIS avatar unavailable — using Windows voice. ${cleanError(e)}`); }
  }
  windowsSpeak(text);
}

function maybeAutoSpeak(run) {
  if (run.status === 'running' || state.spoken.has(run.id)) return;
  if (run.mode !== 'review' || run.final?.state !== 'done') return;
  state.spoken.add(run.id);
  state.lastFinal = run.final.text; $('#btn-replay').disabled = false;
  if (state.settings.speech.autoSpeak) speak(run.final.text, { final: true });
}

// ---------- history ----------
async function refreshHistory() {
  const list = state.settings.keepHistory ? await ron.listHistory() : [];
  $('#history-note').textContent = state.settings.keepHistory ? (list.length ? '' : 'Saved conversations will appear here.') : 'History is off. Conversations are forgotten when you close the app.';
  $('#history-list').replaceChildren(...list.map((c) => h('li', { class: c.id === state.conversationId ? 'active' : '' },
    h('button', { type: 'button', class: 'open', text: c.title || 'Untitled', title: `${c.title}\n${new Date(c.updatedAt).toLocaleString()}`, onclick: () => openConversation(c.id) }),
    h('button', { type: 'button', class: 'icon-btn del', 'aria-label': `Delete conversation ${c.title}`, text: '🗑', onclick: async () => {
      if (!(await confirmBox(`Delete “${c.title}”? This cannot be undone.`))) return;
      await ron.deleteConversation(c.id);
      if (c.id === state.conversationId) newConversation();
      refreshHistory();
    } }))));
}

async function openConversation(id) {
  if (state.busy) { toast('Wait for the current answer or press Stop.'); return; }
  const convo = await ron.getConversation(id);
  if (!convo) return;
  newConversation(false);
  state.conversationId = id;
  for (const run of convo.runs) { state.runs.set(run.id, run); state.spoken.add(run.id); await renderRun(run); }
  refreshHistory();
}

function newConversation(refresh = true) {
  state.conversationId = null;
  $('#thread').replaceChildren(h('section', { id: 'welcome', class: 'welcome' }, h('h1', { text: 'New conversation' }), h('p', { class: 'muted', text: 'Ask a question below.' })));
  if (refresh) refreshHistory();
  $('#question').focus();
}

function confirmBox(text) {
  const d = $('#confirm');
  $('#confirm-text').textContent = text;
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}

// ---------- settings ----------
function showTab(name) {
  $$('.settings-tabs [role=tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $$('.settings-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
}

function renderConnections() {
  const list = $('#connection-list');
  if (!list) return;
  const label = { ready: 'Ready', signin: 'Needs sign-in', unknown: 'Installed', unavailable: 'Unavailable', 'rate-limited': 'Rate-limited', checking: 'Checking…' };
  list.replaceChildren(...state.providers.map((p) => {
    const c = state.connections[p.id] || { state: 'checking', detail: 'Checking…' };
    const result = h('span', { class: 'small muted' });
    return h('div', { class: 'conn', 'data-conn': p.id },
      h('span', { class: `dot ${c.state}`, 'aria-hidden': 'true' }),
      h('span', {}, h('span', { class: 'name', text: p.name }), ' ', h('span', { class: 'small muted', text: `· ${label[c.state] || c.state}` })),
      h('span', { class: 'detail' }, `${p.vendor}. ${c.detail}`,
        c.version ? h('span', { class: 'block', text: `Version ${c.version}${c.testedVersion && c.testedVersion !== c.version ? ` (checked with ${c.testedVersion})` : ''}` }) : null,
        c.path ? h('span', { class: 'block path', text: `${state.settings.paths?.[p.id] ? 'Location (chosen by you)' : 'Location'}: ${c.path}` }) : null,
        c.warning ? h('span', { class: 'block warning', role: 'note', text: c.warning }) : null),
      h('span', { class: 'actions' },
        p.kind === 'cli' ? h('button', { type: 'button', class: 'btn btn-small', text: 'Choose location…', title: `Pick the ${p.name} program if it is installed somewhere this app does not look`, onclick: () => choosePath(p.id) }) : null,
        p.kind === 'cli' && state.settings.paths?.[p.id] ? h('button', { type: 'button', class: 'btn btn-small', text: 'Use automatic location', onclick: () => resetPath(p.id) }) : null,
        c.state !== 'unavailable' ? h('button', { type: 'button', class: 'btn btn-small', text: 'Test', title: 'Sends a one-line test question (uses a little of your plan quota)', onclick: async (e) => {
          e.target.disabled = true; result.textContent = 'Testing…';
          const r = await ron.testConnection(p.id);
          state.connections[p.id] = r; result.textContent = ''; renderConnections(); renderChips();
        } }) : null, result));
  }));
  const sel = $('#final-model');
  sel.replaceChildren(h('option', { value: 'auto', text: 'Automatic (first model that answered)' }), ...state.providers.filter((p) => usable(p.id)).map((p) => h('option', { value: p.id, text: p.name })));
  sel.value = state.settings.finalModel;
}

async function choosePath(id) {
  try {
    const out = await ron.choosePath(id);
    if (!out) return;
    const r = out.connection;
    state.settings = out.settings; state.connections[id] = r; renderConnections(); renderChips();
    toast(r.state === 'unavailable' ? `${nameOf(id)} was not found there` : `${nameOf(id)} location saved`);
  } catch (e) { toast(cleanError(e)); }
}
async function resetPath(id) {
  const out = await ron.resetPath(id);
  state.settings = out.settings; state.connections[id] = out.connection; renderConnections(); renderChips();
  toast(`${nameOf(id)} will be found automatically`);
}

function renderPrivacy() {
  const rows = state.providers.map((p) => h('tr', {}, h('td', { text: p.name }), h('td', { text: p.destination }),
    h('td', { text: state.settings.enabled[p.id] && usable(p.id) ? 'On' : 'Off' })));
  $('#privacy-table').replaceChildren(
    h('p', { class: 'small', text: 'When a model is on, it receives: your question; your saved instructions; up to three earlier questions and final answers from the same conversation; and, in Review together, the other models’ answers and reviews. Nothing else from your computer is attached. Models are asked not to use tools, files or the web, and Claude and Codex run with tools disabled.' }),
    h('table', { class: 'privacy-table' }, h('thead', {}, h('tr', {}, h('th', { text: 'Model' }), h('th', { text: 'Where it is processed' }), h('th', { text: 'Currently' }))), h('tbody', {}, rows)),
    h('p', { class: 'small muted', text: 'Speech: the Windows voice runs on this computer. The JARVIS avatar option sends only the final answer to your Jarvis app, which passes it to its avatar service. Update checks (if on) contact github.com only to look for a newer version of this app.' }));
}

function loadVoices() {
  const voices = window.speechSynthesis.getVoices();
  const sel = $('#voice-select');
  sel.replaceChildren(h('option', { value: '', text: 'Default English voice' }), ...voices.map((v) => h('option', { value: v.name, text: `${v.name} (${v.lang})` })));
  sel.value = state.settings.speech.voice || '';
}
window.speechSynthesis.addEventListener('voiceschanged', () => state.settings && loadVoices());

function openSettings(tab = 'instructions') {
  const s = state.settings;
  $('#instructions').value = state.instructions;
  $$('input[name=speech-output]').forEach((r) => { r.checked = r.value === s.speech.output; });
  $('#auto-speak').checked = s.speech.autoSpeak;
  $('#voice-rate').value = s.speech.rate;
  $('#keep-history').checked = s.keepHistory;
  $('#auto-update').checked = s.autoUpdate;
  $('#theme-select').value = s.theme;
  $('#font-size').value = s.fontSize; $('#font-size-label').textContent = `${s.fontSize}px`;
  $('#reading-width').value = s.readingWidth;
  $('#review-rounds').value = String(s.reviewRounds);
  $('#timeout').value = String([90, 180, 300].includes(s.timeoutSec) ? s.timeoutSec : 180);
  renderConnections(); renderPrivacy(); loadVoices(); showTab(tab);
  $('#settings').showModal();
}

function wireSettings() {
  $$('.settings-tabs [role=tab]').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  $('#btn-save-instructions').addEventListener('click', async () => {
    const saved = await ron.saveInstructions($('#instructions').value);
    state.instructions = saved.text;
    $('#instructions-saved').textContent = `Saved ${new Date(saved.updatedAt).toLocaleTimeString()}`;
    toast('Instructions saved');
  });
  $$('input[name=speech-output]').forEach((r) => r.addEventListener('change', () => saveSettings({ speech: { ...state.settings.speech, output: r.value } })));
  $('#auto-speak').addEventListener('change', (e) => saveSettings({ speech: { ...state.settings.speech, autoSpeak: e.target.checked } }));
  $('#voice-select').addEventListener('change', (e) => saveSettings({ speech: { ...state.settings.speech, voice: e.target.value } }));
  $('#voice-rate').addEventListener('change', (e) => saveSettings({ speech: { ...state.settings.speech, rate: Number(e.target.value) } }));
  $('#btn-voice-test').addEventListener('click', () => windowsSpeak('This is how final answers will sound.'));
  $('#btn-jarvis-status').addEventListener('click', async () => {
    $('#jarvis-status').textContent = 'Checking…';
    const r = await ron.jarvisStatus();
    $('#jarvis-status').textContent = r.reachable ? `Jarvis is running. Avatar: ${r.avatarAvailable ? 'available' : 'not available'}${r.message ? ` (${r.message})` : ''}. Start an avatar conversation in Jarvis (Command → Avatar) before asking.` : r.message;
  });
  $('#keep-history').addEventListener('change', async (e) => { await saveSettings({ keepHistory: e.target.checked }); refreshHistory(); toast(e.target.checked ? 'Conversations will be kept' : 'New conversations will not be saved'); });
  $('#btn-clear-history').addEventListener('click', async () => {
    if (!(await confirmBox('Delete every saved conversation? Your saved instructions are kept. This cannot be undone.'))) return;
    await ron.clearHistory(); newConversation(); toast('All saved conversations deleted');
  });
  $('#btn-data-folder').addEventListener('click', () => ron.openDataFolder());
  $('#theme-select').addEventListener('change', (e) => saveSettings({ theme: e.target.value }));
  $('#font-size').addEventListener('input', (e) => { $('#font-size-label').textContent = `${e.target.value}px`; saveSettings({ fontSize: Number(e.target.value) }); });
  $('#reading-width').addEventListener('change', (e) => saveSettings({ readingWidth: e.target.value }));
  $('#final-model').addEventListener('change', (e) => saveSettings({ finalModel: e.target.value }));
  $('#review-rounds').addEventListener('change', (e) => saveSettings({ reviewRounds: Number(e.target.value) }));
  $('#timeout').addEventListener('change', (e) => saveSettings({ timeoutSec: Number(e.target.value) }));
  $('#btn-recheck').addEventListener('click', async () => { state.connections = {}; renderConnections(); await refreshConnections(); toast('Connections checked'); });
}

// ---------- updates ----------
function updateStatusText(u) {
  switch (u?.state) {
    case 'checking': return 'Checking for updates…';
    case 'current': return `You have the latest version (${u.current}).`;
    case 'downloading': return `Downloading version ${u.version}… ${u.percent || 0}%`;
    case 'ready': return `Version ${u.version} is ready to install.`;
    case 'error': return u.detail || 'Could not check for updates.';
    case 'unsupported': return u.detail || '';
    default: return u?.current ? `Version ${u.current}.` : '';
  }
}
function onUpdate(u) {
  state.update = u;
  $('#update-status').textContent = updateStatusText(u);
  const banner = $('#update-banner');
  if (u?.state === 'ready' && !state.updateDismissed) {
    $('#update-text').textContent = `Ron Assistant ${u.version} is ready. It will be installed when you close the app.`;
    banner.hidden = false;
  } else if (u?.state !== 'ready') banner.hidden = true;
}
function wireUpdates() {
  $('#auto-update').addEventListener('change', (e) => { saveSettings({ autoUpdate: e.target.checked }); toast(e.target.checked ? 'Will check for updates automatically' : 'Automatic update checks are off'); });
  $('#btn-check-update').addEventListener('click', async () => { onUpdate({ ...state.update, state: 'checking' }); onUpdate(await ron.checkUpdate()); });
  $('#btn-update-later').addEventListener('click', () => { state.updateDismissed = true; $('#update-banner').hidden = true; });
  $('#btn-update-now').addEventListener('click', async () => {
    if (state.busy) { toast('Wait for the current answer or press Stop, then restart.'); return; }
    if (await ron.installUpdate()) $('#update-text').textContent = 'Restarting to install the update…';
  });
  ron.onUpdate(onUpdate);
  ron.updateStatus().then(onUpdate);
}

// ---------- wiring ----------
function wire() {
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#question').value;
    if (q.trim() && !state.busy && enabledModels().length) $('#question').value = '';
    ask(q);
  });
  $('#question').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); $('#composer').requestSubmit(); } });
  $('#btn-stop').addEventListener('click', async () => { await ron.stop(); toast('Stopping…'); });
  $$('.mode-switch button').forEach((b) => b.addEventListener('click', () => saveSettings({ mode: b.dataset.mode })));
  $('#btn-mute').addEventListener('click', () => { const muted = !state.settings.speech.muted; if (muted) stopSpeaking(); saveSettings({ speech: { ...state.settings.speech, muted } }); toast(muted ? 'Voice muted' : 'Voice on'); });
  $('#btn-stop-speech').addEventListener('click', stopSpeaking);
  $('#btn-replay').addEventListener('click', () => state.lastFinal && speak(state.lastFinal, { manual: true, final: true }));
  $('#btn-smaller').addEventListener('click', () => saveSettings({ fontSize: state.settings.fontSize - 1 }));
  $('#btn-larger').addEventListener('click', () => saveSettings({ fontSize: state.settings.fontSize + 1 }));
  $('#btn-theme').addEventListener('click', () => saveSettings({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }));
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#btn-new').addEventListener('click', () => { if (state.busy) { toast('Wait for the current answer or press Stop.'); return; } newConversation(); });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); saveSettings({ fontSize: state.settings.fontSize + 1 }); }
    if (e.ctrlKey && e.key === '-') { e.preventDefault(); saveSettings({ fontSize: state.settings.fontSize - 1 }); }
    if (e.key === 'Escape' && speaking) stopSpeaking();
  });
  // Links inside answers open in the default browser; code blocks get a copy button.
  $('#thread').addEventListener('click', (e) => {
    const a = e.target.closest('a.ext-link');
    if (a) { e.preventDefault(); openLink(a.dataset.href); return; }
    const copy = e.target.closest('.copy-code');
    if (copy) { const code = copy.closest('.code-block').querySelector('code').textContent; ron.copy({ text: code }).then(() => toast('Copied code')); }
  });
  $('#thread').addEventListener('auxclick', (e) => { if (e.target.closest('a')) e.preventDefault(); });
  wireSettings();
  wireUpdates();
}

async function init() {
  const data = await ron.init();
  Object.assign(state, { settings: data.settings, instructions: data.instructions.text, providers: data.providers, fake: data.fake });
  applyAppearance(); renderChips(); wire(); refreshHistory();
  ron.onRun(onRunUpdate);
  ron.onRun((run) => { if (run.status === 'running') setBusy(true); });
  refreshConnections();
  document.body.dataset.ready = '1';
  $('#question').focus();
}

init();
