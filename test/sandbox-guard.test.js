// Static guard for SANDBOX.md: fails if shipped code (main/, renderer/) uses anything the
// Mac App Store sandbox / MSIX rules forbid. Dev tools (dev/, test/) are not shipped.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(js|html)$/.test(f)) files.push(p);
  }
})(path.join(ROOT, 'main')); (function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(js|html)$/.test(f)) files.push(p);
  }
})(path.join(ROOT, 'renderer'));
const src = (p) => fs.readFileSync(p, 'utf8');
const hits = (re, allow = []) => files.filter(p => !allow.includes(path.relative(ROOT, p)) && re.test(src(p))).map(p => path.relative(ROOT, p));

test('no child processes, shell exec, AppleScript or PowerShell', () => {
  assert.deepStrictEqual(hits(/child_process|\bexecFile?\(|\bspawn\(|osascript|powershell/i), []);
});
test('no servers (client only)', () => {
  assert.deepStrictEqual(hits(/createServer|WebSocketServer|\.listen\(|loadURL\(\s*['"`]https?:\/\/localhost/), []);
});
test('no launching other apps (only openExternal for links)', () => {
  assert.deepStrictEqual(hits(/shell\.(openPath|showItemInFolder|openItem)|execSync/), []);
});
test('no login items, global shortcuts, accessibility or registry', () => {
  assert.deepStrictEqual(hits(/setLoginItemSettings|globalShortcut|isTrustedAccessibilityClient|systemPreferences\.(askForMediaAccess|getMediaAccessStatus)|\bregedit|winreg/), []);
});
test('user files only via native dialogs or drag-and-drop (browser fallbacks only in bridge.js)', () => {
  assert.deepStrictEqual(hits(/<input[^>]*type=["']?file|\.type\s*=\s*['"]file|\.download\s*=|createObjectURL/, ['renderer/js/bridge.js']), []);
});
test('no hard-coded absolute paths, home folder or /tmp', () => {
  assert.deepStrictEqual(hits(/['"`](\/Users\/|\/home\/|\/tmp\/|[A-Z]:\\\\)|os\.homedir\(|getPath\(['"](home|downloads|desktop)['"]\)/), []);
});
test('Smaart connection values are not hard-coded outside smaart-defaults.js', () => {
  const offenders = files.filter(p => !p.endsWith('smaart-defaults.js')).filter(p => {
    const code = src(p).split('\n').filter(l => !/^\s*(\/\/|\*|<!--)/.test(l)).join('\n');
    return /['"`]localhost['"`]|\|\|\s*26000|\?\?\s*26000|port:\s*26000/.test(code);
  }).map(p => path.relative(ROOT, p));
  assert.deepStrictEqual(offenders, []);
});
test('self-update is gated by build target', () => {
  const main = src(path.join(ROOT, 'main/main.js'));
  assert.match(main, /buildTarget\.store \? null : require\('\.\/updater'\)/);
  assert.doesNotMatch(src(path.join(ROOT, 'main/smaart-service.js')) + src(path.join(ROOT, 'main/venue-store.js')), /electron-updater/);
});
test('package: no native production modules, NSIS per-user, Local Network string set', () => {
  const pkg = JSON.parse(src(path.join(ROOT, 'package.json')));
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(), ['electron-updater', 'ws']);
  assert.strictEqual(pkg.build.nsis.perMachine, false);
  assert.strictEqual(pkg.build.nsis.allowToChangeInstallationDirectory, false);
  assert.match(pkg.build.mac.extendInfo.NSLocalNetworkUsageDescription, /Smaart/);
});
test('store build configs drop the updater and use the sandbox entitlements', () => {
  const mas = require('../build/electron-builder.mas.js'), appx = require('../build/electron-builder.appx.js');
  for (const c of [mas, appx]) {
    assert.ok(c.files.includes('!node_modules/electron-updater{,/**/*}'));
    assert.strictEqual(c.publish, null);
  }
  assert.strictEqual(mas.extraMetadata.buildTarget, 'mas');
  assert.strictEqual(appx.extraMetadata.buildTarget, 'appx');
  const ent = src(path.join(ROOT, mas.mas.entitlements));
  for (const k of ['com.apple.security.app-sandbox', 'com.apple.security.network.client', 'com.apple.security.files.user-selected.read-write']) assert.ok(ent.includes(k), k);
  assert.ok(!ent.includes('<key>com.apple.security.network.server</key>'), 'client only');
  assert.ok(src(path.join(ROOT, mas.mas.entitlementsInherit)).includes('com.apple.security.inherit'));
});
test('in-app help is up to date with README.md', () => {
  const r = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'dev/build-help.js'), '--check']);   // test-only
  assert.strictEqual(r.status, 0, String(r.stderr));
});
