# Releasing Roomio

Installers are built by GitHub Actions and attached to a **draft** GitHub Release. Installed
apps update themselves from **published** releases (electron-updater reads `latest-mac.yml`
and `latest.yml` from the release).

## One-time setup

1. Repository: **https://github.com/AndrewWilbanks/Roomio-Audio-Map** (public). `package.json` → `repository` and `build.publish` already point at it.
2. Push the project:
   ```bash
   git init && git add . && git commit -m "Roomio 0.1.0"
   git remote add origin https://github.com/AndrewWilbanks/Roomio-Audio-Map.git
   git push -u origin main
   ```
3. **Public repo** = updates work for everyone with no token. For a **private** repo, installed
   apps can't see releases without a token — use a public repo, or a separate public
   "releases" repo as the publish target.

## Signing (strongly recommended)

| | Without | With |
|---|---|---|
| **macOS** | Gatekeeper warning on first open (right-click → Open). **Auto-update cannot install** — Squirrel.Mac requires a signed app | Opens normally; auto-update works |
| **Windows** | SmartScreen warning ("More info → Run anyway"). Auto-update still works | No warning once the certificate has reputation |

macOS needs an **Apple Developer ID Application** certificate (Apple Developer Program) and
notarization. Add these repository secrets (Settings → Secrets and variables → Actions):

| Secret | What |
|---|---|
| `MAC_CERT_P12_BASE64` | Developer ID Application certificate exported as .p12, base64-encoded (`base64 -i cert.p12`) |
| `MAC_CERT_PASSWORD` | The .p12 password |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | 10-character team ID |
| `WIN_CERT_PFX_BASE64`, `WIN_CERT_PASSWORD` | (optional) Windows code-signing certificate |

With no secrets set, the workflow still builds unsigned installers.

## Each release

1. Bump `"version"` in `package.json` (e.g. `0.2.0`) and commit.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`
3. Wait for both jobs in **Actions → release** to finish (macOS + Windows).
4. Open the draft under **Releases**, add notes, and **Publish**. Installed apps pick it up
   within a few hours (or via Check for Updates…).

## Building locally

```bash
npm run dist:mac     # universal .dmg + .zip (unsigned unless a Developer ID is in your keychain)
npm run dist:win     # NSIS installer, x64 + arm64 (cross-builds from macOS, unsigned)
```
Local builds use `--publish never`; they never upload anything.
