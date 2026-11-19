// The saved-conversations sidebar.
import { $, h, state, toast } from './shared.js';
import { renderRun } from './runs.js';

// ---------- history ----------
export async function refreshHistory() {
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

export function newConversation(refresh = true) {
  state.conversationId = null;
  $('#thread').replaceChildren(h('section', { id: 'welcome', class: 'welcome' }, h('h1', { text: 'New conversation' }), h('p', { class: 'muted', text: 'Ask a question below.' })));
  if (refresh) refreshHistory();
  $('#question').focus();
}

export function confirmBox(text) {
  const d = $('#confirm');
  $('#confirm-text').textContent = text;
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}
