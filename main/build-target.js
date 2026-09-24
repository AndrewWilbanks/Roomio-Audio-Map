// build-target.js — which kind of build is running, decided at build time.
// electron-builder writes "buildTarget" into the packaged package.json (extraMetadata):
//   direct (default: dmg/zip/nsis from GitHub Releases) | mas (Mac App Store) | appx (Microsoft Store)
// Electron's own process.mas / process.windowsStore flags are honoured as a safety net.
const { app } = require('electron');

let declared = 'direct';
try { declared = require('../package.json').buildTarget || 'direct'; } catch (e) { /* keep default */ }

const target = process.mas ? 'mas' : process.windowsStore ? 'appx' : declared;
const store = target === 'mas' || target === 'appx';

module.exports = {
  target,
  store,
  // self-update only in packaged direct-download builds
  get selfUpdate() { return !store && app.isPackaged; },
  // test/portable data-folder override (RA_USER_DATA) never in store builds
  allowDataOverride: !store,
};
