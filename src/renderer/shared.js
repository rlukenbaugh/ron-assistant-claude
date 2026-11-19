// Small DOM helpers, shared app state, model names and the toast message.

// ---------- small helpers ----------
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function h(tag, attrs = {}, ...children) {
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

export const state = {
  settings: null, instructions: '', providers: [], connections: {}, conversationId: null,
  runs: new Map(), partials: new Map(), ui: new Map(), md: new Map(), busy: false, spoken: new Set(), lastFinal: '', fake: false,
};
export const nameOf = (id) => state.providers.find((p) => p.id === id)?.name || id;
export const STATE_LABEL = { queued: 'Waiting', running: 'Thinking…', done: 'Answered', failed: 'Failed', stopped: 'Stopped', 'rate-limited': 'Rate-limited' };

let toastTimer = null;
export function toast(message) {
  const t = $('#toast');
  t.textContent = message; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}
