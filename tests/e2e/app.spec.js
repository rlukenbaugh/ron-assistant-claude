'use strict';
// End-to-end checks of the real Electron app with deterministic stand-in models.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const shots = path.join(root, 'test-results', 'screens');

async function launch(dataDir, extraEnv = {}) {
  const log = path.join(dataDir, 'fake-calls.jsonl');
  const app = await electron.launch({
    args: [root],
    env: { ...process.env, RON_ASSISTANT_FAKE: '1', RON_ASSISTANT_DATA_DIR: dataDir, RON_ASSISTANT_FAKE_LOG: log, LOCALAPPDATA: path.join(dataDir, 'no-jarvis'), ...extraEnv },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('body[data-ready="1"]');
  // Record speech instead of making sound.
  await page.evaluate(() => { window.__spoken = []; window.speechSynthesis.speak = (u) => { window.__spoken.push(u.text); if (u.onend) setTimeout(() => u.onend(), 0); }; });
  await expect(page.locator('.chip[data-model="claude"] .dot.ready')).toBeVisible();
  return { app, page, log };
}
function calls(log) { return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ron-assistant-e2e-')); }
async function setModels(page, on) {
  for (const id of ['claude', 'codex', 'gemini']) {
    const chip = page.locator(`.chip[data-model="${id}"]`);
    if ((await chip.getAttribute('aria-pressed') === 'true') !== on.includes(id)) await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', String(on.includes(id)));
  }
}
async function askQuestion(page, text) {
  await page.locator('#question').fill(text);
  await page.locator('#question').press('Control+Enter');
}
async function clipboardText(app) { return app.evaluate(({ clipboard }) => clipboard.readText()); }
// The Windows clipboard is shared with every other program, so record what the app writes too.
async function recordCopies(app) {
  await app.evaluate(({ clipboard }) => { global.__clips = []; const write = clipboard.write.bind(clipboard); clipboard.write = (d) => { global.__clips.push(d.text); return write(d); }; });
}
async function lastCopy(app) { return app.evaluate(() => global.__clips.at(-1)); }

test.beforeAll(() => fs.mkdirSync(shots, { recursive: true }));

test('review mode: both models get the question, answer, review once each, and one final answer appears and is spoken', async () => {
  const dir = tmpDir();
  const { app, page, log } = await launch(dir);
  await setModels(page, ['claude', 'codex']);
  await page.locator('.mode-switch [data-mode="review"]').click();
  await askQuestion(page, 'What is 2 + 2?');
  const run = page.locator('article.run').last();
  await expect(run.locator('.final .answer')).toContainText('Final combined answer', { timeout: 20000 });
  await expect(run.locator('.final .byline').first()).toContainText('Written by');
  await expect(run.locator('.final')).toContainText('Where the models disagreed');
  await expect(run.locator('.final')).toContainText('Contributions');

  const c = calls(log);
  const answers = c.filter((x) => !/REVIEW ROUND|writing the single final answer/.test(x.prompt));
  expect(answers.map((x) => x.id).sort()).toEqual(['claude', 'codex']);
  for (const a of answers) expect(a.prompt).toContain('What is 2 + 2?');
  expect(c.filter((x) => /REVIEW ROUND/.test(x.prompt))).toHaveLength(2); // bounded: one review each
  expect(c.filter((x) => /writing the single final answer/.test(x.prompt))).toHaveLength(1);
  expect(c).toHaveLength(5); // no loops or extra calls

  // Independent answers are in separate tabs.
  await run.locator('[data-model-tab="codex"]').click();
  await expect(run.locator('[data-model-panel="codex"] .answer')).toContainText('Answer from codex');
  await run.locator('[data-model-tab="claude"]').click();
  await expect(run.locator('[data-model-panel="claude"] .answer')).toContainText('Answer from claude');
  // Tables and code render and code scrolls instead of overflowing.
  await expect(run.locator('[data-model-panel="claude"] table')).toBeVisible();
  const overflow = await run.locator('[data-model-panel="claude"] pre').evaluate((el) => getComputedStyle(el).overflowX);
  expect(overflow).toBe('auto');
  // Review discussion is expandable.
  await run.locator('details.discussion > summary').click();
  await expect(run.locator('details.discussion')).toContainText('Round 1 · Claude reviewed');
  // Only the final answer is spoken.
  await expect.poll(() => page.evaluate(() => window.__spoken.join(' '))).toContain('Final combined answer');
  const spoken = await page.evaluate(() => window.__spoken.join(' '));
  expect(spoken).not.toContain('Answer from');
  await page.screenshot({ path: path.join(shots, 'review-light.png'), fullPage: true });
  await app.close();
});

test('compare mode shows independent answers side by side without a final answer or speech', async () => {
  const { app, page, log } = await launch(tmpDir());
  await setModels(page, ['claude', 'codex', 'gemini']);
  await page.locator('.mode-switch [data-mode="compare"]').click();
  await askQuestion(page, 'Compare this');
  const run = page.locator('article.run').last();
  await expect(run.locator('.grid .model-col')).toHaveCount(3);
  await expect(run.locator('.grid [data-model-panel="gemini"] .answer')).toContainText('Answer from gemini', { timeout: 15000 });
  await expect(run.locator('.final')).toHaveCount(0);
  expect(await run.evaluate((el) => [...el.childNodes].filter((n) => n.nodeType === 3).length)).toBe(0); // no stray text such as "null"
  const tops = await run.locator('.grid .model-col').evaluateAll((cols) => cols.map((c) => Math.round(c.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1); // genuinely side by side at this window size
  expect(calls(log)).toHaveLength(3);
  expect(await page.evaluate(() => window.__spoken.length)).toBe(0);
  await page.locator('#btn-theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: path.join(shots, 'compare-dark.png'), fullPage: true });
  await app.close();
});

test('copy buttons, Ctrl+C, Ctrl+V and hyperlinks work', async () => {
  const { app, page } = await launch(tmpDir());
  await setModels(page, ['claude', 'codex']);
  await page.locator('.mode-switch [data-mode="review"]').click();
  await askQuestion(page, 'Copy test');
  const run = page.locator('article.run').last();
  await expect(run.locator('.final .answer')).toBeVisible({ timeout: 20000 });
  await recordCopies(app);

  await run.locator('.final .menu-wrap button').first().click();
  await run.locator('.final .menu button', { hasText: 'Copy as Markdown' }).click();
  expect(await lastCopy(app)).toContain('**Final combined answer**');
  await expect(page.locator('#toast')).toHaveText('Copied final answer as Markdown');

  await run.locator('.final .menu-wrap button').first().click();
  await run.locator('.final .menu button', { hasText: 'Copy as plain text' }).click();
  const plain = await lastCopy(app);
  expect(plain).toContain('Final combined answer');
  expect(plain).not.toContain('**');
  await expect(page.locator('#toast')).toHaveText('Copied final answer as plain text');

  await run.locator('.models .menu-wrap button').first().click();
  await run.locator('.models .menu button', { hasText: 'Copy as Markdown' }).click();
  expect(await lastCopy(app)).toContain('### Answer from claude');

  await run.locator('.run-actions .menu-wrap > button').click();
  await run.locator('.run-actions .menu button', { hasText: 'Copy as Markdown' }).click();
  const all = await lastCopy(app);
  for (const s of ['# Question', 'Final answer (written by', "Codex's independent answer", '## Review discussion']) expect(all).toContain(s);

  // Ordinary selection + Ctrl+C from an answer.
  await run.locator('.final .answer p').first().evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await expect.poll(async () => { await page.keyboard.press('Control+C'); return clipboardText(app); }, { timeout: 10000 }).toContain('Final combined answer');

  // Ctrl+V into the multiline question box.
  await app.evaluate(({ clipboard }) => clipboard.writeText('Pasted line one\nPasted line two'));
  await page.locator('#question').click();
  await page.keyboard.press('Control+V');
  await expect(page.locator('#question')).toHaveValue('Pasted line one\nPasted line two');

  // Hyperlinks go to the default browser (stubbed here) and are labelled as unverified.
  await app.evaluate(({ shell }) => { global.__opened = []; shell.openExternal = async (u) => { global.__opened.push(u); }; });
  const link = run.locator('[data-model-panel="claude"] a.ext-link').first();
  await expect(link).toHaveAttribute('title', /not checked/);
  await link.click();
  await expect.poll(() => app.evaluate(() => global.__opened)).toEqual(['https://example.com/']);
  await expect(run.locator('[data-model-panel="claude"] .links h4')).toContainText('not checked');
  expect(page.url()).toContain('index.html'); // the app window did not navigate
  await app.close();
});

test('model HTML, scripts and unsafe link schemes are not executed or linked', async () => {
  const { app, page } = await launch(tmpDir());
  await setModels(page, ['claude']);
  await page.locator('.mode-switch [data-mode="compare"]').click();
  await askQuestion(page, 'Hostile output [html]');
  const run = page.locator('article.run').last();
  await expect(run.locator('.answer')).toContainText('Safe text', { timeout: 15000 });
  await expect(run.locator('.answer')).toContainText('<script>');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await run.locator('.answer script, .answer img').count()).toBe(0);
  const hrefs = await run.locator('.answer a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  expect(hrefs.filter((x) => !/^https?:|^mailto:/.test(x))).toEqual([]);
  await app.close();
});

test('one rate-limited model fails gracefully, the other finishes, and Retry recovers it', async () => {
  const { app, page, log } = await launch(tmpDir());
  await setModels(page, ['claude', 'codex']);
  await page.locator('.mode-switch [data-mode="review"]').click();
  await askQuestion(page, 'Resilience [failonce:codex]');
  const run = page.locator('article.run').last();
  await expect(run.locator('.final .note')).toContainText('Only Claude answered', { timeout: 20000 });
  await run.locator('[data-model-tab="codex"]').click();
  await expect(run.locator('[data-model-panel="codex"] .error-box')).toContainText('rate limit');
  await run.locator('button', { hasText: 'Retry Codex' }).click();
  await expect(run.locator('.final .note')).toHaveCount(0, { timeout: 20000 });
  await expect(run.locator('.final .answer')).toContainText('Final combined answer');
  await run.locator('[data-model-tab="codex"]').click();
  await expect(run.locator('[data-model-panel="codex"] .answer')).toContainText('Answer from codex');
  expect(calls(log).filter((x) => /writing the single final answer/.test(x.prompt))).toHaveLength(1);
  await app.close();
});

test('Stop cancels a running question and the app is ready again', async () => {
  const { app, page } = await launch(tmpDir());
  await setModels(page, ['claude', 'codex']);
  await askQuestion(page, 'Take a while [slow]');
  await expect(page.locator('#btn-stop')).toBeVisible();
  await page.locator('#btn-stop').click();
  const run = page.locator('article.run').last();
  await expect(run.locator('.badge', { hasText: 'Stopped by you' })).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#btn-ask')).toBeEnabled();
  await expect(page.locator('#btn-stop')).toBeHidden();
  expect(await page.evaluate(() => window.__spoken.length)).toBe(0);
  await app.close();
});

test('JARVIS avatar failure falls back to the Windows voice and never blocks the printed answer', async () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ speech: { output: 'jarvis', autoSpeak: true } }));
  const { app, page } = await launch(dir);
  await setModels(page, ['claude', 'codex']);
  await page.locator('.mode-switch [data-mode="review"]').click();
  await askQuestion(page, 'Avatar test');
  const run = page.locator('article.run').last();
  await expect(run.locator('.final .answer')).toContainText('Final combined answer', { timeout: 20000 });
  await expect(page.locator('#toast')).toContainText('JARVIS avatar unavailable');
  await expect.poll(() => page.evaluate(() => window.__spoken.join(' '))).toContain('Final combined answer');
  // Mute, stop and replay controls.
  await page.locator('#btn-mute').click();
  await expect(page.locator('#btn-mute')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#btn-replay')).toBeEnabled();
  await app.close();
});

test('settings, instructions and history survive a full restart; history can be turned off', async () => {
  const dir = tmpDir();
  let { app, page } = await launch(dir);
  await setModels(page, ['claude', 'codex']);
  await page.locator('#btn-larger').click();
  await page.locator('#btn-larger').click();
  await page.locator('.mode-switch [data-mode="compare"]').click();
  await page.locator('#btn-settings').click();
  await page.locator('#instructions').fill('Always answer in plain English.\nI use Windows 11.');
  await page.locator('#btn-save-instructions').click();
  await page.locator('[data-tab="appearance"]').click();
  await page.locator('#theme-select').selectOption('dark');
  await page.screenshot({ path: path.join(shots, 'settings-dark.png') });
  await page.keyboard.press('Escape');
  await askQuestion(page, 'Remember me');
  await expect(page.locator('article.run .grid .answer').first()).toBeVisible({ timeout: 15000 });
  await app.close();

  ({ app, page } = await launch(dir));
  const fontSize = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--reading-size').trim());
  expect(fontSize).toBe('20px');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.mode-switch [data-mode="compare"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.chip[data-model="gemini"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#history-list li')).toHaveCount(1);
  await page.locator('#btn-settings').click();
  await expect(page.locator('#instructions')).toHaveValue('Always answer in plain English.\nI use Windows 11.');
  // Saved instructions are sent with questions.
  await page.locator('[data-tab="privacy"]').click();
  await page.locator('#keep-history').uncheck();
  await page.keyboard.press('Escape');
  await expect(page.locator('#history-note')).toContainText('History is off');
  await page.locator('#history-list li').count().then((n) => expect(n).toBe(0));
  await askQuestion(page, 'Do not keep this');
  await expect(page.locator('article.run .grid .answer').first()).toBeVisible({ timeout: 15000 });
  const log = path.join(dir, 'fake-calls.jsonl');
  expect(calls(log).at(-1).prompt).toContain('Always answer in plain English.');
  await app.close();

  ({ app, page } = await launch(dir));
  const files = fs.readdirSync(path.join(dir, 'history'));
  expect(files).toHaveLength(1); // only the first conversation, saved before history was turned off
  await expect(page.locator('#history-note')).toContainText('History is off');
  await app.close();
});

test('a downloaded update shows a banner with Restart now and Later, and settings show update status', async () => {
  const dir = tmpDir();
  const { app, page } = await launch(dir, { RON_ASSISTANT_FAKE_UPDATE: '9.9.9' });
  await expect(page.locator('#update-banner')).toBeHidden();
  await page.locator('#btn-settings').click();
  await page.locator('.settings-tabs [data-tab="privacy"]').click();
  await expect(page.locator('#auto-update')).toBeChecked();
  await page.locator('#btn-check-update').click();
  await expect(page.locator('#update-status')).toContainText('9.9.9 is ready');
  await page.locator('#settings .settings-head button').click();
  await expect(page.locator('#update-banner')).toBeVisible();
  await expect(page.locator('#update-text')).toContainText('9.9.9');
  await page.screenshot({ path: path.join(shots, 'update-banner.png') });
  await page.locator('#btn-update-later').click();
  await expect(page.locator('#update-banner')).toBeHidden();
  // Turning automatic checks off is saved.
  await page.locator('#btn-settings').click();
  await page.locator('.settings-tabs [data-tab="privacy"]').click();
  await page.locator('#auto-update').uncheck();
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).autoUpdate).toBe(false);
  await app.close();
});

test('program locations can only be set through the file picker, not by the page', async () => {
  const dir = tmpDir();
  const { app, page } = await launch(dir);
  await page.evaluate(() => window.ron.saveSettings({ paths: { claude: 'C:/evil.exe' }, fontSize: 20 }));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  expect(saved.fontSize).toBe(20);
  expect(saved.paths).toEqual({});
  await page.locator('#btn-settings').click();
  await page.locator('.settings-tabs [data-tab="models"]').click();
  await expect(page.locator('.conn[data-conn="claude"]')).toContainText('Choose location…');
  await page.screenshot({ path: path.join(shots, 'connections.png') });
  await app.close();
});

test('answers stream into the window while being written, then become the formatted answer', async () => {
  const dir = tmpDir();
  const { app, page } = await launch(dir);
  await setModels(page, ['claude', 'codex']);
  await page.locator('.mode-switch [data-mode="compare"]').click();
  await askQuestion(page, 'Count for me [stream]');
  const run = page.locator('article.run').last();
  const box = run.locator('.answer.streaming:visible').first();
  await expect(box).toContainText('Streaming from', { timeout: 5000 });
  const first = (await box.textContent()).length;
  await expect.poll(async () => (await run.locator('.answer.streaming:visible').first().textContent() || '').length, { timeout: 3000 }).toBeGreaterThan(first);
  await expect(box).toHaveAttribute('aria-busy', 'true');
  await page.screenshot({ path: path.join(shots, 'streaming.png') });
  // When the answer is complete the plain streaming box is replaced by rendered Markdown.
  await expect(run.locator('.answer strong').first()).toHaveText('4', { timeout: 10000 });
  await expect(run.locator('.answer.streaming')).toHaveCount(0);
  await app.close();
});

test('review progress names the round, and the context setting is saved and explained', async () => {
  const dir = tmpDir();
  const { app, page } = await launch(dir);
  await page.locator('#btn-settings').click();
  await page.locator('.settings-tabs [data-tab="models"]').click();
  await expect(page.locator('#context-turns')).toHaveValue('3');
  await page.locator('#review-rounds').selectOption('2');
  await page.locator('#context-turns').selectOption('0');
  await page.locator('.settings-tabs [data-tab="privacy"]').click();
  await expect(page.locator('#privacy-table')).toContainText('no earlier questions');
  await page.locator('#settings .settings-head button').click();
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).contextTurns).toBe(0);
  await setModels(page, ['claude', 'codex']);
  await page.locator('.mode-switch [data-mode="review"]').click();
  await askQuestion(page, 'What is 2 + 2?');
  const run = page.locator('article.run').last();
  await expect(run.locator('.progress')).toContainText(/Review round 2 of 2: 2 of 2 done/, { timeout: 20000 });
  await app.close();
});
