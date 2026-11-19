// Theme, text size and the model chips at the top of the window.
import { $, $$, h, nameOf, state, toast } from './shared.js';
import { renderConnections } from './settings.js';

// ---------- appearance ----------
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
export function applyAppearance() {
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

export async function saveSettings(patch) {
  state.settings = await ron.saveSettings(patch);
  applyAppearance();
  renderChips();
  return state.settings;
}

// ---------- models ----------
export function usable(id) { const c = state.connections[id]; return !c || c.state !== 'unavailable'; }
export function enabledModels() { return state.providers.map((p) => p.id).filter((id) => state.settings.enabled[id] && usable(id)); }

export function renderChips() {
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

export async function refreshConnections() {
  state.connections = await ron.checkConnections();
  renderChips(); renderConnections(); applyAppearance();
}
