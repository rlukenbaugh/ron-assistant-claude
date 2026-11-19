// The Settings dialog.
import { $, $$, h, nameOf, state, toast } from './shared.js';
import { refreshConnections, renderChips, saveSettings, usable } from './appearance.js';
import { cleanError } from './runs.js';
import { windowsSpeak } from './speech.js';
import { confirmBox, newConversation, refreshHistory } from './history.js';

// ---------- settings ----------
function showTab(name) {
  $$('.settings-tabs [role=tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $$('.settings-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
}

export function renderConnections() {
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


function contextText() {
  const n = state.settings.contextTurns;
  return n === 0 ? 'no earlier questions (each question stands alone)' : `the last ${n === 1 ? 'earlier question and its final answer' : `${n} earlier questions and final answers`} from the same conversation`;
}

function renderPrivacy() {
  const rows = state.providers.map((p) => h('tr', {}, h('td', { text: p.name }), h('td', { text: p.destination }),
    h('td', { text: state.settings.enabled[p.id] && usable(p.id) ? 'On' : 'Off' })));
  $('#privacy-table').replaceChildren(
    h('p', { class: 'small', text: `When a model is on, it receives: your question; your saved instructions; ${contextText()}; and, in Review together, the other models’ answers and reviews. Nothing else from your computer is attached. Models are asked not to use tools, files or the web, and Claude and Codex run with tools disabled.` }),
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

export function openSettings(tab = 'instructions') {
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
  $('#context-turns').value = String([0, 1, 3, 5, 10].includes(s.contextTurns) ? s.contextTurns : 3);
  $('#timeout').value = String([90, 180, 300].includes(s.timeoutSec) ? s.timeoutSec : 180);
  renderConnections(); renderPrivacy(); loadVoices(); showTab(tab);
  $('#settings').showModal();
}

export function wireSettings() {
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
  $('#context-turns').addEventListener('change', (e) => { saveSettings({ contextTurns: Number(e.target.value) }).then(renderPrivacy); });
  $('#timeout').addEventListener('change', (e) => saveSettings({ timeoutSec: Number(e.target.value) }));
  $('#btn-recheck').addEventListener('click', async () => { state.connections = {}; renderConnections(); await refreshConnections(); toast('Connections checked'); });
}
