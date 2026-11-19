'use strict';
// Deterministic stand-in models used only by automated UI tests (RON_ASSISTANT_FAKE=1).
// Markers in the question steer behaviour: [fail:<id>] rate-limits a model, [slow] waits 60 s,
// [html] returns hostile HTML/script content to prove it is rendered inert.
const fs = require('node:fs');
const { AdapterError } = require('./adapters');

/** @typedef {import("./runner").AskOptions} AskOptions */

/** @param {{ logFile?: string }} [opts] */
function createFakeAsk({ logFile } = {}) {
  const attempts = {};
  /** @param {string} id @param {string} prompt @param {AskOptions} [opts] */
  return function fakeAsk(id, prompt, { signal, onText } = {}) {
    if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ id, prompt })}\n`);
    const question = (prompt.match(/THE USER'S QUESTION:\n([\s\S]*?)(\n\n[A-Z ]{6,}|$)/) || [])[1] || '';
    attempts[id] = (attempts[id] || 0) + 1;
    const isFinal = /writing the single final answer/.test(prompt);
    const isReview = /REVIEW ROUND/.test(prompt);
    return new Promise((resolve, reject) => {
      const streaming = question.includes('[stream]');
      const delay = question.includes('[slow]') ? 60000 : streaming ? 2500 : 150 + (id.length * 40);
      // [stream]: send growing partial text for a while before the answer is complete.
      let ticker = null;
      if (streaming && onText) {
        let n = 0;
        ticker = setInterval(() => { n += 1; onText(`Streaming from ${id}: ${'word '.repeat(n * 3)}`); }, 200);
      }
      signal?.addEventListener('abort', () => clearInterval(ticker), { once: true });
      const timer = setTimeout(() => {
        clearInterval(ticker);
        const failOnce = question.includes(`[failonce:${id}]`) && attempts[id] === 1;
        if (question.includes(`[fail:${id}]`) || failOnce) return reject(new AdapterError('rate-limited', `${id} usage limit reached. Try again later.`));
        if (isFinal) return resolve(`**Final combined answer** for: ${question.trim()}\n\nBoth models agree the answer is 4.\n\n## Where the models disagreed\nFakeCodex preferred a shorter explanation.`);
        if (isReview) return resolve('## Review\nThe other answer is correct but terse.\n\n## Revised answer\nThe answer is **4** (revised by ' + id + ').');
        if (question.includes('[html]')) return resolve('<script>window.__pwned = true</script><img src=x onerror="window.__pwned=true">\n\n[bad](javascript:alert(1)) and [file](file:///C:/Windows/win.ini)\n\nSafe text.');
        return resolve(`### Answer from ${id}\n\nThe answer is **4**.\n\n- point one\n- point two\n\n| Item | Value |\n|---|---|\n| a | 1 |\n\n\`\`\`js\nconsole.log(2 + 2); // a very long line ${'x'.repeat(200)}\n\`\`\`\n\nSee [Example site](https://example.com/) for more.`);
      }, delay);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new AdapterError('cancelled', 'Stopped.')); }, { once: true });
    });
  };
}

module.exports = { createFakeAsk };
