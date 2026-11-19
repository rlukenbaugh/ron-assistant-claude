'use strict';
// Safe Markdown → HTML. Raw HTML in model output is shown as text (html: false), images are
// never loaded, and only http(s)/mailto links survive. The renderer page additionally runs
// under a Content-Security-Policy that forbids inline script, so nothing embedded can execute.
const MarkdownIt = require('markdown-it');

const SAFE_SCHEMES = /^(https?:|mailto:)/i;

function safeUrl(raw) {
  try {
    const href = String(raw || '').trim();
    if (!SAFE_SCHEMES.test(href)) return null;
    const u = new URL(href);
    if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) return null;
    if (u.username || u.password) return null; // user:pass@host links are a common disguise
    // A one-word host ("https://user/") is never a real site a model should point to; it also
    // appears when auto-linking picks up the leftover text of a link that was blocked above.
    if (u.protocol !== 'mailto:' && u.hostname !== 'localhost' && !u.hostname.startsWith('[') && !u.hostname.includes('.')) return null;
    return u.href;
  } catch { return null; }
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
md.validateLink = (url) => Boolean(safeUrl(url));

const esc = md.utils.escapeHtml;

md.renderer.rules.link_open = (tokens, idx) => {
  const href = safeUrl(tokens[idx].attrGet('href'));
  if (!href) { tokens[idx].meta = { dropped: true }; return '<span class="link-blocked">'; }
  return `<a href="${esc(href)}" class="ext-link" data-href="${esc(href)}" title="Suggested by the model · not checked · opens in your browser">`;
};
md.renderer.rules.link_close = (tokens, idx) => {
  for (let i = idx; i >= 0; i -= 1) if (tokens[i].type === 'link_open') return tokens[i].meta?.dropped ? '</span>' : '<span class="link-flag" aria-hidden="true">↗</span></a>';
  return '</a>';
};
md.renderer.rules.image = (tokens, idx) => {
  const t = tokens[idx];
  const src = safeUrl(t.attrGet('src'));
  const alt = esc(t.content || 'image');
  return src ? `<span class="image-placeholder">[Image not loaded: ${alt}] <a href="${esc(src)}" class="ext-link" data-href="${esc(src)}" title="Suggested by the model · not checked">${esc(src)}<span class="link-flag" aria-hidden="true">↗</span></a></span>` : `<span class="image-placeholder">[Image: ${alt}]</span>`;
};
const defaultTable = md.renderer.rules.table_open || ((tokens, idx, opts, env, self) => self.renderToken(tokens, idx, opts));
md.renderer.rules.table_open = (tokens, idx, opts, env, self) => `<div class="table-wrap">${defaultTable(tokens, idx, opts, env, self)}`;
md.renderer.rules.table_close = () => '</table></div>';
md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx];
  const lang = esc(String(t.info || '').trim().split(/\s+/)[0] || '');
  return `<div class="code-block"><div class="code-head"><span>${lang || 'code'}</span><button type="button" class="copy-code">Copy code</button></div><pre><code>${esc(t.content)}</code></pre></div>`;
};
md.renderer.rules.code_block = md.renderer.rules.fence;

function render(markdown) {
  return md.render(String(markdown || ''));
}

/** Links a model mentioned, de-duplicated, in order. All are model suggestions, none verified. */
function extractLinks(markdown) {
  const tokens = md.parse(String(markdown || ''), {});
  const seen = new Set(); const out = [];
  const walk = (list) => list.forEach((t) => {
    if (t.type === 'link_open') { const h = safeUrl(t.attrGet('href')); if (h && !seen.has(h)) { seen.add(h); out.push(h); } }
    if (t.children) walk(t.children);
  });
  walk(tokens);
  return out;
}

/** Markdown → readable plain text for "Copy as plain text" and speech. */
function toPlainText(markdown) {
  return String(markdown || '')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '$1 ($2)')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '• ')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Text suited to reading aloud: no code blocks, URLs or table rules. */
function toSpeech(markdown) {
  return toPlainText(String(markdown || '').replace(/```[\s\S]*?```/g, ' (code omitted) '))
    .replace(/\(https?:[^)]+\)/g, '')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\|/g, ', ')
    .replace(/\s+\n/g, '\n')
    .trim();
}

module.exports = { render, extractLinks, toPlainText, toSpeech, safeUrl };
