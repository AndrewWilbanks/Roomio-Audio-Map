// main.js — Electron main process: window + menu, venue storage and profiles,
// setup-wizard routing, the Smaart connection, and auto-update.
const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./venue-store');
const { testConnection } = require('./smaart-test');
const { SmaartService } = require('./smaart-service');
const updater = require('./updater');

// tests / portable use: RA_USER_DATA points the app at a different data folder
if (process.env.RA_USER_DATA) app.setPath('userData', process.env.RA_USER_DATA);

let win = null;
let current = null;                          // 'main' | 'setup'
const page = (name) => path.join(__dirname, '..', 'renderer', name);
const getWin = () => win;

// ------------------------------------------------------------------ Smaart (backend)
const smaart = new SmaartService(() => store.credentials.get());
const toWin = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
smaart.on('status', (s) => toWin('smaart:status', s));
smaart.on('message', (raw) => toWin('smaart:message', raw));
smaart.on('log', (l) => toWin('smaart:log', l));

function startSmaartFromVenue() {
  const v = store.venue.exists() ? store.venue.get() : null;
  if (v && v.smaart && v.smaart.autoConnect !== false) smaart.connect(v.smaart);
}

// ------------------------------------------------------------------ window
function load(which) {
  current = which;
  smaart.stop(true);                         // a (possibly different) venue's page reconnects on load
  win.loadFile(page(which === 'setup' ? 'setup.html' : 'index.html'));
  buildMenu();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600,
    title: 'Roomio',
    backgroundColor: '#EFEEE7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  // the app never navigates away or opens windows; external links go to the browser
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.webContents.on('did-finish-load', () => { if (current === 'main') { toWin('smaart:status', smaart.state); if (smaart.state.status === 'off') startSmaartFromVenue(); } });
  win.on('closed', () => { win = null; smaart.stop(true); });
  // first run (or after a reset): no venue.json -> setup wizard
  load(store.venue.exists() ? 'main' : 'setup');
}

// ------------------------------------------------------------------ menu
// Menu items that touch the venue go through the page first, so it can save pending edits.
const menuAction = (action) => () => toWin('menu', action);

function buildMenu() {
  const onMain = current === 'main';
  const isMac = process.platform === 'darwin';
  const venueItems = [
    { label: 'New Venue…', click: menuAction('new-venue'), enabled: onMain },
    { label: 'Import Venue Profile…', click: menuAction('import-profile') },
    { label: 'Export Venue Profile…', click: menuAction('export-profile'), enabled: onMain },
    { type: 'separator' },
    { label: 'Reset Venue…', click: menuAction('reset-venue'), enabled: onMain },
    { type: 'separator' },
    { label: 'Show Data Folder', click: () => shell.openPath(store.userDataDir()) },
  ];
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => updater.checkNow(getWin) },
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
        { label: 'Roomio Help', click: () => openReadme() },
        ...(isMac ? [] : [{ label: 'Check for Updates…', click: () => updater.checkNow(getWin) }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openReadme() {
  const packed = path.join(process.resourcesPath || '', 'README.md');
  shell.openPath(fs.existsSync(packed) ? packed : path.join(__dirname, '..', 'README.md'));
}

// ------------------------------------------------------------------ IPC
// every handler validates its input; errors come back to the page as rejections
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => fn(...args));

handle('venue:exists', () => store.venue.exists());
handle('venue:get', () => store.venue.get());
handle('venue:save', (v) => { store.venue.save(v); return true; });
handle('data:get', () => store.data.get());
handle('data:save', (d) => { store.data.save(d); return true; });

// setup wizard
handle('setup:complete', (venue, password) => {
  const err = store.venue.validate(venue);
  if (err) throw new Error(err);
  store.venue.backup();                                  // a previous venue (New Venue…) is kept in backups/
  store.venue.save(venue);
  if (typeof password === 'string') store.credentials.set(password);
  store.data.save({ readings: [], spectra: [] });
  load('main');
  return true;
});
handle('setup:example', () => fs.readFileSync(page('examples/example-hall.auditorium.json'), 'utf8'));
handle('setup:open', () => { load('setup'); return true; });
handle('setup:cancel', () => { if (store.venue.exists()) load('main'); return store.venue.exists(); });

// Settings → Reset venue
handle('venue:reset', async () => {
  const v = store.venue.get();
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Reset venue', 'Cancel'], defaultId: 1, cancelId: 1,
    message: `Reset “${v ? v.auditorium.name : 'this venue'}”?`,
    detail: 'The venue and its measurements are moved to a backup in the data folder, and setup starts again. Export a venue profile first if you want to use it on another computer.',
  });
  if (response !== 0) return false;
  store.venue.reset();
  load('setup');
  return true;
});

// venue profiles
const safeName = (s) => String(s || 'venue').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'venue';
handle('profile:export', async (includeMeasurements) => {
  const profile = store.exportProfile(!!includeMeasurements, app.getVersion());
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export venue profile',
    defaultPath: path.join(app.getPath('documents'), `${safeName(profile.venue.auditorium.name)}.roomio.json`),
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
  if (store.venue.exists()) {
    const cur = store.venue.get();
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['Replace current venue', 'Cancel'], defaultId: 0, cancelId: 1,
      message: `Import “${s.name}”?`,
      detail: `${s.seats} seats${s.readings || s.spectra ? `, ${s.readings} readings, ${s.spectra} frequency responses` : ', no measurements'}.\n\n` +
        `“${cur.auditorium.name}” and its measurements will be moved to a backup in the data folder. The Smaart password isn't part of a profile — enter it again if Smaart uses one.`,
    });
    if (response !== 0) return null;
  }
  store.importProfile(parsed);
  load('main');
  return s;
});

// Smaart: the page asks, the main process does
handle('smaart:test', (cfg, password) => testConnection(cfg || {}, password === undefined ? store.credentials.get() : password));
handle('smaart:connect', (cfg) => { smaart.connect(cfg || {}); return smaart.state; });
handle('smaart:disconnect', () => { smaart.stop(); return smaart.state; });
handle('smaart:retry', () => { smaart.retryNow(); return smaart.state; });
handle('smaart:status', () => smaart.state);
handle('smaart:send', (text) => smaart.send(String(text)));
handle('smaart:setPassword', (pw) => { store.credentials.set(typeof pw === 'string' ? pw : ''); return store.credentials.has(); });
handle('credentials:has', () => store.credentials.has());
handle('app:info', () => ({ version: app.getVersion(), userData: store.userDataDir(), platform: process.platform, packaged: app.isPackaged }));

// ------------------------------------------------------------------ lifecycle
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => { createWindow(); updater.init(getWin); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}
