// Markdown display, suggested links, and the copy menus.
import { $$, h, nameOf, state, toast } from './shared.js';

// ---------- markdown ----------
export async function ensureRendered(texts) {
  const missing = [...new Set(texts.filter((t) => t && !state.md.has(t)))];
  if (!missing.length) return;
  const out = await ron.render(missing);
  missing.forEach((t, i) => state.md.set(t, out[i]));
}
export function answerNode(text) {
  const r = state.md.get(text) || { html: '', links: [] };
  return h('div', { class: 'answer', html: r.html });
}
export function linksNode(text, who) {
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
export async function openLink(url) {
  const ok = await ron.openLink(url);
  toast(ok ? 'Opened in your default browser' : 'That link type is blocked for safety');
}

// ---------- copy ----------
async function copyAs(markdown, format, label) {
  const text = format === 'markdown' ? markdown : await ron.plain(markdown);
  await ron.copy({ text });
  toast(`Copied ${label} as ${format === 'markdown' ? 'Markdown' : 'plain text'}`);
}
export function copyMenu(label, getMarkdown, buttonText = 'Copy') {
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

export function discussionMarkdown(run) {
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
