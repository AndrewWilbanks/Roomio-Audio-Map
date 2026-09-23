// updater.js — auto-update from GitHub Releases (electron-updater).
// Only active in packaged builds. The publish target is set in package.json → build.publish.
const { app, dialog } = require('electron');

let autoUpdater = null;
let manual = false;                 // true while a "Check for Updates…" from the menu is running

function init(getWindow) {
  if (!app.isPackaged) return;      // dev runs (npm start) never update themselves
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox(getWindow(), {
      type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      message: `Roomio ${info.version} is ready to install.`,
      detail: 'It will also install the next time you quit the app.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('update-not-available', () => {
    if (manual) dialog.showMessageBox(getWindow(), { type: 'info', message: 'You have the latest version.', detail: `Roomio ${app.getVersion()}` });
    manual = false;
  });
  autoUpdater.on('error', (e) => {
    if (manual) dialog.showMessageBox(getWindow(), { type: 'warning', message: 'Could not check for updates.', detail: String(e && e.message || e) });
    manual = false;
  });
  // check shortly after launch, then every 6 hours
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10_000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 3600_000);
}

function checkNow(getWindow) {
  if (!autoUpdater) {
    dialog.showMessageBox(getWindow(), { type: 'info', message: 'Updates are only available in the installed app.', detail: `This is a development build (${app.getVersion()}).` });
    return;
  }
  manual = true;
  autoUpdater.checkForUpdates().catch(() => {});
}

module.exports = { init, checkNow };
