// Entry point: wires buttons and keys, then starts the app.
import { $, $$, state, toast } from './shared.js';
import { applyAppearance, enabledModels, refreshConnections, renderChips, saveSettings } from './appearance.js';
import { openLink } from './answers.js';
import { ask, onPartial, onRunUpdate, setBusy } from './runs.js';
import { speak, speaking, stopSpeaking } from './speech.js';
import { newConversation, refreshHistory } from './history.js';
import { openSettings, wireSettings } from './settings.js';
import { wireUpdates } from './updates.js';

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
  ron.onPartial(onPartial);
  ron.onRun((run) => { if (run.status === 'running') setBusy(true); });
  refreshConnections();
  document.body.dataset.ready = '1';
  $('#question').focus();
}

init();
