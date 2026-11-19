'use strict';
// The only bridge between the page and the app. Every call is a fixed, named operation.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('ron', {
  init: invoke('app:init'),
  saveSettings: invoke('settings:save'),
  saveInstructions: invoke('instructions:save'),
  checkConnections: invoke('connections:check'),
  testConnection: invoke('connections:test'),
  choosePath: invoke('connections:choosePath'),
  resetPath: invoke('connections:resetPath'),
  ask: invoke('ask:start'),
  retry: invoke('ask:retry'),
  stop: invoke('ask:stop'),
  listHistory: invoke('history:list'),
  getConversation: invoke('history:get'),
  deleteConversation: invoke('history:delete'),
  clearHistory: invoke('history:clear'),
  render: invoke('md:render'),
  plain: invoke('md:plain'),
  speechText: invoke('md:speech'),
  openLink: invoke('link:open'),
  checkLink: invoke('link:check'),
  copy: invoke('clipboard:write'),
  readClipboard: invoke('clipboard:read'),
  jarvisStatus: invoke('jarvis:status'),
  jarvisSpeak: invoke('jarvis:speak'),
  openDataFolder: invoke('app:openDataFolder'),
  updateStatus: invoke('update:status'),
  checkUpdate: invoke('update:check'),
  installUpdate: invoke('update:install'),
  onUpdate: (fn) => {
    const handler = (_e, status) => fn(status);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },
  onRun: (fn) => {
    const handler = (_e, run) => fn(run);
    ipcRenderer.on('run:update', handler);
    return () => ipcRenderer.removeListener('run:update', handler);
  },
});
