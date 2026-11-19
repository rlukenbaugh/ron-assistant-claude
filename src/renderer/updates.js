// The update banner and the Updates section of Settings.
import { $, state, toast } from './shared.js';
import { saveSettings } from './appearance.js';

// ---------- updates ----------
function updateStatusText(u) {
  switch (u?.state) {
    case 'checking': return 'Checking for updates…';
    case 'current': return `You have the latest version (${u.current}).`;
    case 'downloading': return `Downloading version ${u.version}… ${u.percent || 0}%`;
    case 'ready': return `Version ${u.version} is ready to install.`;
    case 'error': return u.detail || 'Could not check for updates.';
    case 'unsupported': return u.detail || '';
    default: return u?.current ? `Version ${u.current}.` : '';
  }
}
function onUpdate(u) {
  state.update = u;
  $('#update-status').textContent = updateStatusText(u);
  const banner = $('#update-banner');
  if (u?.state === 'ready' && !state.updateDismissed) {
    $('#update-text').textContent = `Ron Assistant ${u.version} is ready. It will be installed when you close the app.`;
    banner.hidden = false;
  } else if (u?.state !== 'ready') banner.hidden = true;
}
export function wireUpdates() {
  $('#auto-update').addEventListener('change', (e) => { saveSettings({ autoUpdate: e.target.checked }); toast(e.target.checked ? 'Will check for updates automatically' : 'Automatic update checks are off'); });
  $('#btn-check-update').addEventListener('click', async () => { onUpdate({ ...state.update, state: 'checking' }); onUpdate(await ron.checkUpdate()); });
  $('#btn-update-later').addEventListener('click', () => { state.updateDismissed = true; $('#update-banner').hidden = true; });
  $('#btn-update-now').addEventListener('click', async () => {
    if (state.busy) { toast('Wait for the current answer or press Stop, then restart.'); return; }
    if (await ron.installUpdate()) $('#update-text').textContent = 'Restarting to install the update…';
  });
  ron.onUpdate(onUpdate);
  ron.updateStatus().then(onUpdate);
}
