// Drawing a question and its answers, streaming text, and asking/retrying.
import { $, STATE_LABEL, h, nameOf, state, toast } from './shared.js';
import { enabledModels } from './appearance.js';
import { answerNode, copyMenu, discussionMarkdown, ensureRendered, linksNode } from './answers.js';
import { maybeAutoSpeak, speak, stopSpeaking } from './speech.js';
import { refreshHistory } from './history.js';

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
    if (rv.length) {
      const round = Math.max(...rv.map((r) => r.round));
      const inRound = rv.filter((r) => r.round === round);
      const total = run.reviewRounds || round;
      items.push(badge(`Review${total > 1 ? ` round ${round} of ${total}` : ''}: ${inRound.filter((r) => r.state === 'done').length} of ${inRound.length} done`, inRound.some((r) => r.state === 'running' || r.state === 'queued') ? 'running' : 'done'));
    }
    if (run.final) items.push(badge(`Final answer: ${STATE_LABEL[run.final.state] || run.final.state}`, run.final.state));
  }
  if (run.status === 'stopped') items.push(badge('Stopped by you', 'stopped'));
  return h('div', { class: 'progress', 'aria-label': 'Progress' }, items);
}

function retryButton(run, id) {
  return h('button', { type: 'button', class: 'btn btn-small', text: `Retry ${nameOf(id)}`, disabled: state.busy, onclick: () => retryModel(run, id) });
}

/**
 * A box that shows a model's text as it is written. Plain text only (the finished answer is
 * rendered as Markdown); aria-busy keeps screen readers from reading every new word.
 */
function streamBox(run, key) {
  const k = `${run.id}|${key}`;
  const text = state.partials.get(k) || '';
  return h('div', { class: 'answer streaming', 'data-stream': k, 'aria-busy': 'true', hidden: !text, text });
}

function modelBody(run, id) {
  const a = run.answers[id];
  if (!a || a.state === 'queued' || a.state === 'running') return h('div', {}, h('p', { class: 'muted' }, badge(`${nameOf(id)} is ${a?.state === 'running' ? 'answering' : 'waiting'}…`, a?.state || 'queued')), streamBox(run, `answer:${id}`));
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
    body = run.status === 'running' ? h('div', {}, h('p', { class: 'muted' }, badge(phase, 'running')), f?.state === 'running' && f.by ? streamBox(run, `final:${f.by}`) : null) : h('p', { class: 'muted', text: 'No final answer was produced.' });
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
        : r.state === 'running' || r.state === 'queued' ? [badge('Reviewing…', 'running'), streamBox(run, `review:${r.id}:${r.round}`)] : h('div', { class: 'error-box', text: r.error || 'This review did not finish.' }))));
  return det;
}

function textsOf(run) {
  const t = Object.values(run.answers).map((a) => a.text);
  (run.reviews || []).forEach((r) => t.push(r.review || r.text, r.revised));
  if (run.final?.text) t.push(run.final.text);
  return t.filter(Boolean);
}

const renderSeq = new Map();
export async function renderRun(run) {
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

/** Partial text from a model that is still writing: update just that box, no full redraw. */
export function onPartial({ runId, key, text }) {
  const k = `${runId}|${key}`;
  state.partials.set(k, text);
  const el = document.querySelector(`[data-stream="${CSS.escape(k)}"]`);
  if (el) { el.textContent = text; el.hidden = false; }
}

export function onRunUpdate(run) {
  state.runs.set(run.id, run);
  if (run.status !== 'running') for (const k of state.partials.keys()) if (k.startsWith(`${run.id}|`)) state.partials.delete(k);
  if (run.conversationId && !state.conversationId) state.conversationId = run.conversationId;
  if (run.conversationId !== state.conversationId) return;
  renderRun(run);
  maybeAutoSpeak(run);
}

// ---------- asking ----------
export function setBusy(busy) {
  state.busy = busy;
  $('#btn-stop').hidden = !busy;
  $('#btn-ask').disabled = busy;
  $('#btn-ask').textContent = busy ? 'Answering…' : 'Ask';
}

export async function ask(question, mode = state.settings.mode, models = enabledModels()) {
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
export function cleanError(e) { return String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
