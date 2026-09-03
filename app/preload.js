'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The only bridge between renderer and Node. Secrets and fs stay in main.
contextBridge.exposeInMainWorld('jarvis', {
  ask: (prompt) => ipcRenderer.invoke('jarvis:ask', prompt),
  cancel: () => ipcRenderer.invoke('jarvis:cancel'),
  status: () => ipcRenderer.invoke('jarvis:status'),
  vaultList: (rel) => ipcRenderer.invoke('vault:list', rel),
  vaultRead: (rel) => ipcRenderer.invoke('vault:read', rel),

  onText: (fn) => ipcRenderer.on('jarvis:text', (_e, t) => fn(t)),
  onTool: (fn) => ipcRenderer.on('jarvis:tool', (_e, t) => fn(t)),
  onDone: (fn) => ipcRenderer.on('jarvis:done', (_e, d) => fn(d)),
});

// The Office. Same rule as above: the renderer gets verbs, never fs or a model client.
contextBridge.exposeInMainWorld('office', {
  roster: () => ipcRenderer.invoke('office:roster'),
  state: () => ipcRenderer.invoke('office:state'),
  submit: (prompt) => ipcRenderer.invoke('office:submit', prompt),
  approvePlan: (taskId, approved) => ipcRenderer.invoke('office:approvePlan', taskId, approved),
  approveStep: (stepId, approved) => ipcRenderer.invoke('office:approveStep', stepId, approved),
  cancel: (id) => ipcRenderer.invoke('office:cancel', id),

  onChange: (fn) => ipcRenderer.on('office:change', (_e, s) => fn(s)),
  onStream: (fn) => ipcRenderer.on('office:stream', (_e, d) => fn(d)),
});

contextBridge.exposeInMainWorld('voice', {
  config: () => ipcRenderer.invoke('voice:config'),
  start: (sampleRate) => ipcRenderer.invoke('voice:start', sampleRate),
  chunk: (buf) => ipcRenderer.send('voice:chunk', buf),
  stop: () => ipcRenderer.invoke('voice:stop'),
  speak: (text, touched) => ipcRenderer.invoke('voice:speak', text, touched),

  onTranscript: (fn) => ipcRenderer.on('voice:transcript', (_e, d) => fn(d)),
  onError: (fn) => ipcRenderer.on('voice:error', (_e, e) => fn(e)),
});
