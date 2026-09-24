// preload.js — the only API the page gets. contextIsolation + sandbox: no Node in the renderer.
const { contextBridge, ipcRenderer } = require('electron');

// subscribe to a main-process event; returns an unsubscribe function
const on = (channel) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('raNative', {
  // venue profile + measurements (userData/venue.json, userData/measurements.json)
  venueGet: () => ipcRenderer.invoke('venue:get'),
  venueSave: (v) => ipcRenderer.invoke('venue:save', v),
  dataGet: () => ipcRenderer.invoke('data:get'),
  dataSave: (d) => ipcRenderer.invoke('data:save', d),
  hasVenue: () => ipcRenderer.invoke('venue:exists'),
  venueReset: () => ipcRenderer.invoke('venue:reset'),
  profileExport: (includeMeasurements) => ipcRenderer.invoke('profile:export', includeMeasurements),
  profileImport: () => ipcRenderer.invoke('profile:import'),
  // setup wizard
  setupComplete: (venue, password) => ipcRenderer.invoke('setup:complete', venue, password),
  setupCancel: () => ipcRenderer.invoke('setup:cancel'),
  openSetup: () => ipcRenderer.invoke('setup:open'),
  example: () => ipcRenderer.invoke('setup:example'),
  demoStart: () => ipcRenderer.invoke('demo:start'),
  demoExit: () => ipcRenderer.invoke('demo:exit'),
  // user files — native dialogs only (SANDBOX.md). purpose: 'auditorium' | 'trace' | 'readings'
  fileOpenText: (purpose) => ipcRenderer.invoke('file:openText', purpose),
  fileSaveText: (purpose, defaultName, text) => ipcRenderer.invoke('file:saveText', purpose, defaultName, text),
  // Smaart (the connection lives in the main process; the password never comes back here)
  smaartTest: (cfg, password) => ipcRenderer.invoke('smaart:test', cfg, password),
  smaartConnect: (cfg) => ipcRenderer.invoke('smaart:connect', cfg),
  smaartDisconnect: () => ipcRenderer.invoke('smaart:disconnect'),
  smaartRetry: () => ipcRenderer.invoke('smaart:retry'),
  smaartStatus: () => ipcRenderer.invoke('smaart:status'),
  smaartSend: (text) => ipcRenderer.invoke('smaart:send', text),
  smaartSetPassword: (pw) => ipcRenderer.invoke('smaart:setPassword', pw),
  hasPassword: () => ipcRenderer.invoke('credentials:has'),
  onSmaartStatus: on('smaart:status'),
  onSmaartMessage: on('smaart:message'),
  onSmaartLog: on('smaart:log'),
  onMenu: on('menu'),
  // app info
  info: () => ipcRenderer.invoke('app:info'),
});
