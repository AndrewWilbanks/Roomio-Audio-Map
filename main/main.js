// main.js — Electron main process: window + menu, venue storage and profiles,
// setup-wizard routing, the Smaart connection, demo mode, and (direct builds only) auto-update.
// Store-sandbox rules apply to everything here — see SANDBOX.md.
const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const buildTarget = require('./build-target');
const store = require('./venue-store');
const { testConnection } = require('./smaart-test');
const { SmaartService } = require('./smaart-service');
const demo = require('./demo');

// tests / portable use: RA_USER_DATA points the app at a different data folder (never in store builds)
if (process.env.RA_USER_DATA && buildTarget.allowDataOverride) app.setPath('userData', process.env.RA_USER_DATA);

// self-update code is only loaded in direct-download builds
const updater = buildTarget.store ? null : require('./updater');

let win = null;
let helpWin = null;
let current = null;                          // 'main' | 'setup'
const page = (name) => path.join(__dirname, '..', 'renderer', name);
const getWin = () => win;

const webPreferences = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  spellcheck: false,
});

// ------------------------------------------------------------------ Smaart (backend)
// The live service, or the simulated one while demo mode is on. Only the active one reaches the window.
const liveSmaart = new SmaartService(() => store.credentials.get());
const demoSmaart = new demo.DemoSmaart();
const smaart = () => (store.isDemo() ? demoSmaart : liveSmaart);
const toWin = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
for (const svc of [liveSmaart, demoSmaart]) {
  svc.on('status', (s) => { if (svc === smaart()) toWin('smaart:status', s); });
  svc.on('message', (raw) => { if (svc === smaart()) toWin('smaart:message', raw); });
  svc.on('log', (l) => { if (svc === smaart()) toWin('smaart:log', l); });
}

function startSmaartFromVenue() {
  const v = store.venue.exists() ? store.venue.get() : null;
  if (v && v.smaart && v.smaart.autoConnect !== false) smaart().connect(v.smaart);
}

// ------------------------------------------------------------------ window
function load(which) {
  current = which;
  liveSmaart.stop(true);                     // a (possibly different) venue's page reconnects on load
  demoSmaart.stop(true);
  win.loadFile(page(which === 'setup' ? 'setup.html' : 'index.html'));
  buildMenu();
}

// links: http(s) opens the default browser (approved exception); nothing else navigates
function lockDown(wc) {
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600,
    title: 'Roomio',
    backgroundColor: '#EFEEE7',
    show: false,
    webPreferences: webPreferences(),
  });
  win.once('ready-to-show', () => win.show());
  lockDown(win.webContents);
  win.webContents.on('did-finish-load', () => { if (current === 'main') { toWin('smaart:status', smaart().state); if (smaart().state.status === 'off') startSmaartFromVenue(); } });
  win.on('closed', () => { win = null; liveSmaart.stop(true); demoSmaart.stop(true); });
  // first run (or after a reset): no venue.json -> setup wizard
  load(store.venue.exists() ? 'main' : 'setup');
}

// In-app help (bundled renderer/help.html, generated from README.md) — no other app is launched
function openHelp() {
  if (helpWin && !helpWin.isDestroyed()) { helpWin.focus(); return; }
  helpWin = new BrowserWindow({
    width: 900, height: 820, title: 'Roomio Help', parent: win || undefined, backgroundColor: '#FBFAF4',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  lockDown(helpWin.webContents);
  helpWin.loadFile(page('help.html'));
  helpWin.on('closed', () => { helpWin = null; });
}

// ------------------------------------------------------------------ menu
// Menu items that touch the venue go through the page first, so it can save pending edits.
const menuAction = (action) => () => toWin('menu', action);

function buildMenu() {
  const onMain = current === 'main';
  const inDemo = store.isDemo();
  const isMac = process.platform === 'darwin';
  const updates = updater ? [{ label: 'Check for Updates…', click: () => updater.checkNow(getWin) }] : [];
  const venueItems = inDemo ? [
    { label: 'Exit Demo', click: menuAction('exit-demo') },
  ] : [
    { label: 'New Venue…', click: menuAction('new-venue'), enabled: onMain },
    { label: 'Import Venue Profile…', click: menuAction('import-profile') },
    { label: 'Export Venue Profile…', click: menuAction('export-profile'), enabled: onMain },
    { label: 'Back Up All Data…', click: menuAction('backup'), enabled: onMain },
    { type: 'separator' },
    { label: 'Reset Venue…', click: menuAction('reset-venue'), enabled: onMain },
  ];
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        ...updates,
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: menuAction('settings'), enabled: onMain },
        { type: 'separator' },
        { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: isMac ? 'Venue' : 'File',
      submenu: [
        ...(isMac ? [] : [{ label: 'Settings…', accelerator: 'Ctrl+,', click: menuAction('settings'), enabled: onMain }, { type: 'separator' }]),
        ...venueItems,
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: 'Exit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
        { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Roomio Help', click: openHelp },
        ...(isMac ? [] : updates),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------ IPC
// every handler validates its input; errors come back to the page as rejections
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => fn(...args));

handle('venue:exists', () => store.venue.exists());
handle('venue:get', () => store.venue.get());
handle('venue:save', (v) => { store.venue.save(v); return true; });
handle('data:get', () => store.data.get());
handle('data:save', (d) => { store.data.save(d); return true; });

// ---- user files: only through the native dialogs (sandbox rule). Purposes are a fixed list.
const MAX_TEXT = 60 * 1024 * 1024;
const OPEN_PURPOSES = {
  auditorium: { title: 'Choose an auditorium file', filters: [{ name: 'Auditorium file (.json, .csv)', extensions: ['json', 'csv', 'txt'] }] },
  trace: { title: 'Choose a Smaart ASCII export', filters: [{ name: 'Smaart export (.txt, .csv)', extensions: ['txt', 'csv', 'asc'] }, { name: 'All files', extensions: ['*'] }] },
  readings: { title: 'Import readings', filters: [{ name: 'CSV', extensions: ['csv'] }] },
};
const SAVE_PURPOSES = {
  csv: { title: 'Export CSV', filters: [{ name: 'CSV', extensions: ['csv'] }] },
};
const safeName = (s) => String(s || 'untitled').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim().slice(0, 120) || 'untitled';

handle('file:openText', async (purpose) => {
  const p = OPEN_PURPOSES[purpose];
  if (!p) throw new Error('Unknown file purpose.');
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: p.title, properties: ['openFile'], filters: p.filters });
  if (canceled || !filePaths[0]) return null;
  const st = fs.statSync(filePaths[0]);
  if (st.size > MAX_TEXT) throw new Error('That file is too large (over 60 MB).');
  return { name: path.basename(filePaths[0]), text: fs.readFileSync(filePaths[0], 'utf8') };
});

handle('file:saveText', async (purpose, defaultName, text) => {
  const p = SAVE_PURPOSES[purpose];
  if (!p) throw new Error('Unknown file purpose.');
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw new Error('Nothing to save.');
  // only a file name: the OS dialog chooses the folder
  const { canceled, filePath } = await dialog.showSaveDialog(win, { title: p.title, defaultPath: safeName(defaultName), filters: p.filters });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, text);
  return path.basename(filePath);
});

// setup wizard
handle('setup:complete', (venue, password) => {
  const err = store.venue.validate(venue);
  if (err) throw new Error(err);
  store.setDemo(false);
  store.venue.backup();                                  // a previous venue (New Venue…) is kept in backups/
  store.venue.save(venue);
  if (typeof password === 'string') store.credentials.set(password);
  store.data.save({ readings: [], spectra: [] });
  load('main');
  return true;
});
const exampleText = () => fs.readFileSync(page(path.join('examples', 'example-hall.auditorium.json')), 'utf8');
handle('setup:example', exampleText);
handle('setup:open', () => { load('setup'); return true; });
handle('setup:cancel', () => { if (store.venue.exists()) load('main'); return store.venue.exists(); });

// demo mode: bundled hall + simulated Smaart, in userData/demo (fresh each time)
handle('demo:start', () => {
  store.writeDemo(demo.buildDemo(exampleText()));
  load('main');
  return true;
});
handle('demo:exit', () => {
  store.setDemo(false);
  load(store.venue.exists() ? 'main' : 'setup');
  return true;
});

// Settings → Reset venue
handle('venue:reset', async () => {
  const v = store.venue.get();
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Reset venue', 'Cancel'], defaultId: 1, cancelId: 1,
    message: `Reset “${v ? v.auditorium.name : 'this venue'}”?`,
    detail: 'The venue and its measurements are moved to a backup inside Roomio\'s data, and setup starts again. Export a venue profile first if you want to use it on another computer.',
  });
  if (response !== 0) return false;
  store.venue.reset();
  load('setup');
  return true;
});

// venue profiles (also "Back Up All Data…" = a profile with measurements)
handle('profile:export', async (includeMeasurements) => {
  const profile = store.exportProfile(!!includeMeasurements, app.getVersion());
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: includeMeasurements ? 'Back up venue and measurements' : 'Export venue profile',
    defaultPath: `${safeName(profile.venue.auditorium.name)}.roomio.json`,      // file name only; the OS picks the folder
    filters: [{ name: 'Roomio venue profile', extensions: ['roomio.json', 'json'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, JSON.stringify(profile));
  return filePath;
});

handle('profile:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import venue profile', properties: ['openFile'],
    filters: [{ name: 'Roomio venue profile', extensions: ['json'] }],
  });
  if (canceled || !filePaths[0]) return null;
  let parsed;
  try { parsed = store.parseProfile(fs.readFileSync(filePaths[0], 'utf8')); }
  catch (e) { await dialog.showMessageBox(win, { type: 'error', message: 'Can\'t import this file', detail: e.message }); return null; }
  const s = parsed.summary;
  const wasDemo = store.isDemo();
  store.setDemo(false);                                   // imports always go to the real venue
  if (store.venue.exists()) {
    const cur = store.venue.get();
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['Replace current venue', 'Cancel'], defaultId: 0, cancelId: 1,
      message: `Import “${s.name}”?`,
      detail: `${s.seats} seats${s.readings || s.spectra ? `, ${s.readings} readings, ${s.spectra} frequency responses` : ', no measurements'}.\n\n` +
        `“${cur.auditorium.name}” and its measurements will be kept as a backup inside Roomio's data. The Smaart password isn't part of a profile — enter it again if Smaart uses one.`,
    });
    if (response !== 0) { store.setDemo(wasDemo); return null; }
  }
  store.importProfile(parsed);
  load('main');
  return s;
});

// Smaart: the page asks, the main process does
handle('smaart:test', (cfg, password) => testConnection(cfg || {}, password === undefined ? store.credentials.get() : password));
handle('smaart:connect', (cfg) => { smaart().connect(cfg || {}); return smaart().state; });
handle('smaart:disconnect', () => { smaart().stop(); return smaart().state; });
handle('smaart:retry', () => { smaart().retryNow(); return smaart().state; });
handle('smaart:status', () => smaart().state);
handle('smaart:send', (text) => smaart().send(String(text)));
handle('smaart:setPassword', (pw) => { store.credentials.set(typeof pw === 'string' ? pw : ''); return store.credentials.has(); });
handle('credentials:has', () => store.credentials.has());
handle('app:info', () => ({
  version: app.getVersion(), platform: process.platform, packaged: app.isPackaged,
  buildTarget: buildTarget.target, demo: store.isDemo(), selfUpdate: !!updater && buildTarget.selfUpdate,
  userData: store.userDataDir(),
}));

// ------------------------------------------------------------------ lifecycle
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => { createWindow(); if (updater && buildTarget.selfUpdate) updater.init(getWin); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}
