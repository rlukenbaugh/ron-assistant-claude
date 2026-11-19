'use strict';
// Checks GitHub Releases for a newer version, downloads it in the background, and installs it
// when the app closes (or at once if Ron chooses "Restart now"). Only the installed (NSIS) build
// can update itself; the portable .exe and development runs never contact GitHub.
// Nothing about questions, answers, settings or history is sent: only a request for the
// release list and the installer download.
const { app } = require('electron');

const SIX_HOURS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY = 15000;

/**
 * @param {object} deps
 * @param {(line:string)=>void} deps.log
 * @param {(status:object)=>void} deps.send  delivers status changes to the window
 * @param {string} [deps.fakeVersion]  test hook: pretend this version has been downloaded
 */
function createUpdater({ log, send, fakeVersion = '' }) {
  const portable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
  const supported = Boolean(fakeVersion) || (app.isPackaged && !portable);
  let updater = null;
  let firstCheck = null;
  let interval = null;
  let status = supported
    ? { state: 'idle', current: app.getVersion() }
    : { state: 'unsupported', current: app.getVersion(), detail: portable ? 'The portable version does not update itself. Download the new version from the releases page.' : 'Updates are only checked in the installed app.' };

  function set(next) {
    const before = status;
    status = { current: app.getVersion(), ...next };
    // Download progress arrives many times a second; only pass on 10 % steps.
    if (next.state === 'downloading' && before.state === 'downloading' && Math.floor((before.percent || 0) / 10) === Math.floor((next.percent || 0) / 10)) return;
    send(status);
  }

  function load() {
    if (updater) return updater;
    ({ autoUpdater: updater } = require('electron-updater'));
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.logger = null; // our own log() records status lines only
    updater.on('checking-for-update', () => set({ state: 'checking' }));
    updater.on('update-not-available', () => set({ state: 'current', checkedAt: new Date().toISOString() }));
    updater.on('update-available', (i) => { log(`update ${i.version} available, downloading`); set({ state: 'downloading', version: i.version, percent: 0 }); });
    updater.on('download-progress', (p) => set({ state: 'downloading', version: status.version, percent: Math.round(p.percent || 0) }));
    updater.on('update-downloaded', (i) => { log(`update ${i.version} downloaded`); set({ state: 'ready', version: i.version }); });
    updater.on('error', (e) => {
      log(`update check failed: ${String(e?.message || e).split('\n')[0].slice(0, 200)}`);
      set({ state: 'error', detail: 'Could not check for updates. The app will try again later.' });
    });
    return updater;
  }

  async function check() {
    if (!supported) return status;
    if (['checking', 'downloading', 'ready'].includes(status.state)) return status;
    if (fakeVersion) { set({ state: 'ready', version: fakeVersion }); return status; }
    try { await load().checkForUpdates(); } catch { /* reported through the 'error' event */ }
    return status;
  }

  /** Turn the automatic checks on or off (at start-up after 15 s, then every 6 hours). */
  function schedule(on) {
    clearTimeout(firstCheck); clearInterval(interval);
    firstCheck = null; interval = null;
    if (!on || !supported) return;
    firstCheck = setTimeout(check, FIRST_CHECK_DELAY);
    interval = setInterval(check, SIX_HOURS);
  }

  function install() {
    if (status.state !== 'ready') return false;
    log(`installing update ${status.version}`);
    if (fakeVersion) return true;
    // Silent install of the already-chosen folder, then start the new version.
    setImmediate(() => load().quitAndInstall(true, true));
    return true;
  }

  return { check, schedule, install, status: () => status, supported };
}

module.exports = { createUpdater };
