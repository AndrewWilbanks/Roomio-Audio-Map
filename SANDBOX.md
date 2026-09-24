# Store-sandbox rules (Mac App Store + Microsoft Store / MSIX)

Roomio ships as a direct download today, but every change must keep it buildable as a
sandboxed **Mac App Store** app and an **MSIX** package. These rules are permanent
constraints for this project. If a feature would break one, stop and propose a
sandbox-safe alternative before building it.

## File system
- App data (venue.json, measurements, credentials, backups, demo data, logs, caches) lives
  **only** under `app.getPath('userData')`. Never write to the app bundle / install folder,
  the home folder directly, `/tmp` (use `app.getPath('temp')` / `os.tmpdir()` if ever
  needed), or any hard-coded absolute path.
- User files are read or written **only** through the native dialogs
  (`dialog.showOpenDialog` / `dialog.showSaveDialog`, via `file:openText` / `file:saveText`
  in `main/main.js`) or by **drag-and-drop** onto the window (allowed: the OS grants access to
  dropped files). No folder scanning, no `~/Downloads`-style paths, no reading a path typed
  into a text field.
- To reopen a user file later, **copy it into userData** on import. Only use
  security-scoped bookmarks (`securityScopedBookmarks` + `app.startAccessingSecurityScopedResource`)
  if copying is impossible.
- Build paths with `path.join` / OS APIs. No string-concatenated paths, no `/` vs `\` assumptions.
- `RA_USER_DATA` (test override of the data folder) is honoured only in dev and
  direct-download builds, never in store builds.

## Processes and system
- No `child_process`, shell commands, helper binaries, AppleScript/osascript, PowerShell, or
  launching other applications. (`shell.openExternal` for `http(s)` links is the one approved
  exception: it opens the default browser.)
- No registry writes, no Program Files, no admin/elevation. Installs and runs as a standard
  user (NSIS: `perMachine: false`, `allowToChangeInstallationDirectory: false`).
- No auto-launch at login, global shortcuts, accessibility APIs, or reading other apps' data
  without explicit approval.
- No native Node modules unless necessary; if one is needed, flag it first (must be signable
  and sandbox-safe). Today the packaged app has none (`ws` runs without its optional add-ons).

## Network
- Roomio is a network **client** only: outgoing WebSocket to Smaart from the main process.
  No local HTTP/WebSocket servers. UI loads from bundled files (`loadFile`), never localhost.
- Smaart host / port / path / password come **only** from `venue.json` (password: encrypted
  `credentials.json`). `renderer/js/smaart-defaults.js` only pre-fills the setup wizard.
  A missing host or port is a visible error, never a silent default.
- Failures (refused, timeout, unreachable, macOS Local Network permission denied) show a
  plain-language message in the status pill; the app always launches and setup / venue
  editing / demo mode work with no Smaart at all.
- macOS: `NSLocalNetworkUsageDescription` is set in Info.plist (`build.mac.extendInfo`).

## Updates
- Self-update (electron-updater) exists only in **direct** builds. `main/build-target.js`
  decides: store builds (`mas`, `appx`; also `process.mas` / `process.windowsStore`) never
  load the updater, hide "Check for Updates…", and don't even package `electron-updater`
  (see `build/store-common.js`).

## Builds
| Target | Command | Notes |
|---|---|---|
| Direct macOS (dmg/zip, hardened runtime, notarization-ready) | `npm run dist:mac` | `build/entitlements.mac.plist` |
| Direct Windows (NSIS) | `npm run dist:win` | per-user, no admin |
| Mac App Store (`mas`, universal) | `npm run dist:mas` | `build/entitlements.mas.plist` + `.mas.inherit.plist`; needs Apple distribution certs + provisioning profile to sign. CI check: **store-builds** workflow |
| Microsoft Store (`appx` / MSIX) | `npm run dist:appx` (on Windows) | identity/publisher placeholders in `build/electron-builder.appx.js`. CI check: **store-builds** workflow |

## Demo mode
Reachable from the setup wizard ("Try the demo"). Loads the bundled example hall with
simulated Smaart data generated **in-process** (`main/demo.js`) — no server, no network.
Demo data lives in `userData/demo/` and never touches the real venue.

## Checklist for every change
- [ ] New file access goes through `file:openText` / `file:saveText` or drag-and-drop
- [ ] New data is written under `userData` with `path.join`
- [ ] No new process spawning, servers, login items, shortcuts, native modules
- [ ] No hard-coded Smaart connection values
- [ ] Anything update-related is gated by `buildTarget.selfUpdate`
