# gamez: desktop shell (Electron, Steam)

A desktop window around the hosted game (`main.mjs`), with a sandboxed preload (`preload.cjs`).
The shell loads the website; it bundles no game code, so every release shows the live client.
It is **not** a pnpm workspace package. Nothing here is installed by `vp install`, and CI does
not build it. Background and the Steam checklist: [`docs/ship.md`](../../../docs/ship.md).

## 0. Prerequisites

- Node 22.18 or newer, npm.
- Electron 28 or newer supports the ESM main file used here. The versions in `package.json`
  (`electron ^37`, `electron-builder ^26`, `steamworks.js ^0.4`) were **not** checked against the
  registry when this folder was written. Run `npm view electron version` and
  `npm view electron-builder version`, then set the ranges to the current majors before the first
  install.
- Windows packaging: run on Windows, or on Linux or macOS with Wine. macOS packaging: macOS with
  Xcode command-line tools. Linux: AppImage works on most distributions.

## 1. Install (once)

```sh
cd apps/native/electron
npm install
```

`steamworks.js` is an optional dependency. If it fails to install on a platform, the app still
runs without Steam.

## 2. Dev run

```sh
GAMEZ_URL=http://localhost:5173 npm start     # the Vite dev server (start it from the repo root first)
npm start                                     # the production URL in main.mjs (see section 4)
```

`GAMEZ_URL` also turns on the DevTools menu item. Leave it unset for release builds.

## 3. Checks

```sh
npm run check    # node --check on main.mjs and preload.cjs (no Electron needed)
```

## 4. Production URL

`main.mjs` has `PROD_URL`. It is a placeholder (`https://REPLACE-WITH-PROD-HOST/`) on purpose: the
app refuses to start while the placeholder is in use, so a release cannot ship without the real
host. Set the real production origin before `npm run dist`. Do not put secrets in this file.

## 5. Packaging

```sh
npm run dist:win     # NSIS installer (Windows)
npm run dist:mac     # DMG and ZIP (macOS, arm64 and x64 by default)
npm run dist:linux   # AppImage
```

Output goes to `apps/native/electron/dist/` (git-ignored by the repo rules: keep it out of commits).
The icon is generated from `apps/game/public/icons/icon-512.png` (original art, `tools/pwa`).

### Code signing (not configured)

- Windows: sign the installer with an EV or OV code-signing certificate. Set the signing
  environment variables that electron-builder reads (for example `CSC_LINK`, `CSC_KEY_PASSWORD`).
  Keep them in the CI secret store, never in this repo.
- macOS: sign with a Developer ID Application certificate and notarize with an App Store Connect
  API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`). Without notarization, macOS
  blocks the app on first launch.
- Linux: AppImage needs no signature.

## 6. Steam

### Development

Steam must run on the same machine. Put `steam_appid.txt` (containing the app id, for example
`480` for Spacewar) next to the executable only during development. Remove it before you upload a
build.

```sh
STEAM_APP_ID=480 npm start
```

With the variable set, `main.mjs` calls `steamworks.init(appId)` in a `try/catch`. The window
still opens if Steam is missing. Steam-only features (achievements, cloud saves, overlay) must
check the client before they use the result.

### Depot upload (notes)

1. Create the app in the Steamworks partner site and note the app id, the depot ids and the
   launch options (the executable is `gamez.exe`, `gamez.app` or the AppImage).
2. Build each platform's package with `npm run dist:*`, then arrange the unpacked files per depot
   (a Windows depot, a macOS depot, a Linux depot).
3. Upload with SteamCMD: write an `app_build.vdf` (app id, the depots, the build description) and
   run `steamcmd +login <partner-account> +run_app_build <path-to-app_build.vdf> +quit`. The login
   account needs a Steam Guard approval; keep credentials out of the repo.
4. Set the build live on a branch in the partner site, after a test on a private branch.

Steam requires the Steamworks SDK redistributables in the depots. The `steamworks.js` package
ships the native library, so check its licence and the depot rules before release.

### Microtransactions (deferred)

Steam microtransactions and the Steam Inventory API are **not implemented** (wave C documents them
in `docs/ship.md`). Until they are, the Steam build sells nothing: hide purchase links in the
desktop shell, or ship a build with no store.

## 7. Security notes

- `contextIsolation` on, `nodeIntegration` off, `sandbox` on. The page reaches only
  `window.gamezNative` (a frozen object with the platform name).
- Every permission request is denied (camera, microphone, notifications, geolocation).
- Navigation stays on the game host and the listed OAuth hosts (`main.mjs`). Other links open in
  the default browser.
- The shell has no auto-updater. Add one only with signed releases.
