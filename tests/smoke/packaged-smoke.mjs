// Smoke test of the packaged app (release\win-unpacked) with the REAL signed-in Claude and Codex.
// Uses a throwaway data folder, so Ron's own settings/history are not touched. Uses a little quota.
//   node tests/smoke/packaged-smoke.mjs
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..', '..');
const exe = path.join(root, 'release', 'win-unpacked', 'Ron Assistant.exe');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ron-assistant-smoke-'));
const shots = path.join(root, 'test-results', 'screens');
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ mode: 'review', enabled: { claude: true, codex: true, hermes: false }, speech: { output: 'windows', autoSpeak: true, muted: true } }));

const app = await electron.launch({ executablePath: exe, env: { ...process.env, RON_ASSISTANT_DATA_DIR: dataDir } });
const page = await app.firstWindow();
const ok = [];
const check = (name, pass, detail = '') => { ok.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
try {
  await page.waitForSelector('body[data-ready="1"]');
  await page.waitForSelector('.chip[data-model="claude"] .dot.ready', { timeout: 60000 });
  await page.waitForSelector('.chip[data-model="codex"] .dot.ready', { timeout: 60000 });
  const chips = await page.locator('.chip').evaluateAll((els) => els.map((e) => `${e.textContent.trim()}:${e.querySelector('.dot').className.replace('dot ', '')}`));
  check('connection chips', chips.some((c) => c.startsWith('Claude:ready')) && chips.some((c) => c.startsWith('Codex:ready')), chips.join(', '));
  await page.screenshot({ path: path.join(shots, 'packaged-start.png') });

  await page.locator('#question').fill('In two short paragraphs: why do the seasons happen on Earth? Include one reputable link for further reading.');
  await page.locator('#question').press('Control+Enter');
  const run = page.locator('article.run').last();
  await run.locator('.final .answer').waitFor({ timeout: 600000 });
  const finalText = await run.locator('.final .answer').innerText();
  check('final answer printed', finalText.length > 80, `${finalText.length} characters`);
  check('final byline names the writer', /Written by (Claude|Codex)/.test(await run.locator('.final .byline').first().innerText()));
  for (const id of ['claude', 'codex']) {
    await run.locator(`[data-model-tab="${id}"]`).click();
    const t = await run.locator(`[data-model-panel="${id}"] .answer`).innerText().catch(() => '');
    check(`${id} independent answer shown`, t.length > 50, `${t.length} characters`);
  }
  await run.locator('details.discussion > summary').click();
  check('review discussion has both reviews', (await run.locator('details.discussion .turn').count()) === 2);
  check('run finished without errors', (await run.locator('.badge.failed').count()) === 0);
  const links = await run.locator('a.ext-link').count();
  console.log(`Links rendered: ${links} (all marked as not checked)`);
  await page.screenshot({ path: path.join(shots, 'packaged-review.png'), fullPage: true });
  console.log(`Final answer:\n${finalText}`);
} finally {
  await app.close();
}
console.log(`${ok.filter(Boolean).length}/${ok.length} packaged smoke checks passed`);
process.exitCode = ok.every(Boolean) ? 0 : 1;
