# Desktop app (.dmg)

Wildroom as a macOS app: Electron around the same Vue client and Node server. Apple Silicon (arm64).

## Build

```bash
pnpm install
pnpm electron:build
```

Output:

- `release/Wildroom-<version>-arm64.dmg` — the installer
- `release/mac-arm64/Wildroom.app` — the same app, unpacked

Needs network access the first time (the dmg tool). A rebuild takes about a minute; `node scripts/build-electron.mjs
--clean` reinstalls the staged native modules from scratch.

Other scripts:

```bash
pnpm electron:start   # production mode without packaging (stages dist-electron/app and runs it)
pnpm electron:dev     # Electron window around `pnpm dev` (Vite + API server, hot reload)
```

## What the build does

`scripts/build-electron.mjs`:

1. `vite build` → `dist/client`.
2. Stages `dist-electron/app`, a self-contained npm project: the server bundled by esbuild (`server/index.mjs`),
   `main.cjs` / `preload.cjs`, the SPA (`client/`), the RunPod scripts, and a `node_modules` holding only what can't be
   bundled — @napi-rs/keyring, @resvg/resvg-js, ffmpeg-static.
3. Loads the native addons in Electron as a check. They are Node-API builds, so the repo's own copies serve both
   Electron and system Node.
4. Draws the icon: `electron/icon.svg` → `dist-electron/build/icon.icns`, every size macOS asks for.
5. electron-builder packs it: `app.asar` with the native addons and the ffmpeg binary unpacked to `app.asar.unpacked`
   (the server rewrites ffmpeg-static's path to it), bundle id `com.szymonkubisa.wildroom`, `.wildroom` registered as a
   package document type, ad-hoc signature, `.app` + `.dmg`.

At launch the main process forks the bundled server in a utilityProcess on port 7777 (a free port if that one is
taken), with `STUDIO_CLIENT_DIST` pointing at the bundled SPA, waits for `/api/health` and opens the window. Quitting
asks the server to shut down (finishes its writes, releases the library lock). Server log:
`~/Library/Logs/Wildroom/server.log` (Help → Show Server Log).

## Install

Open the `.dmg`, drag **Wildroom** to **Applications**, eject.

The app shares projects, app data, local models (`~/Library/Application Support/Wildroom/Models`) and Keychain
keys with the web version (`pnpm dev` / `pnpm start`), but only one of them can run at a time (library lock): quit one
before starting the other.

## Gatekeeper (unsigned build)

The build is **ad-hoc signed** — not signed with an Apple Developer ID and **not notarized**.

- **On the Mac that built it** it just opens: a locally built app carries no quarantine flag.
- **On another Mac** (dmg sent over AirDrop, downloaded, copied from a USB stick) macOS refuses it once because it
  can't verify the developer. Either:
  1. open the app (it is refused), then **System Settings → Privacy & Security** → *"Wildroom" was blocked…*
     → **Open Anyway**, and confirm with the password (since macOS 15 right-click → Open no longer offers this), or
  2. after copying it to Applications, in Terminal:
     ```bash
     xattr -dr com.apple.quarantine "/Applications/Wildroom.app"
     ```
- **Keychain**: an ad-hoc signature changes with every build, so after installing a new build macOS asks once more
  for access to the saved API keys — choose **Always Allow**.

Why ad-hoc and not unsigned: Apple Silicon only runs signed code, and a bundle whose seal is broken is reported as
*"damaged and can't be opened"* once quarantined, with no Open Anyway.

### Signing and notarizing

To hand the app to others without the steps above you need a paid Apple Developer account:

1. A **Developer ID Application** certificate in the login Keychain (Xcode → Settings → Accounts → Manage Certificates).
2. An app-specific password for the Apple ID (account.apple.com) and the Team ID.
3. Build with:
   ```bash
   STUDIO_MAC_IDENTITY="Developer ID Application: Your Name (TEAMID)" APPLE_ID=you@example.com APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx APPLE_TEAM_ID=TEAMID pnpm electron:build
   ```
   This signs with the hardened runtime (electron-builder's default entitlements: JIT, unsigned executable memory,
   no library validation) and notarizes. Without the three `APPLE_*` variables it signs but skips notarization.
   This path is not tested yet.

## Testing a build without touching your library

`STUDIO_HOME` moves everything — projects, app data, caches, the window's own storage and the logs — under one folder,
so a test copy runs beside the real app and leaves the real library alone. `STUDIO_NO_KEYCHAIN=1` starts with no saved
keys (demo mode: nothing paid can run):

```bash
STUDIO_HOME=/tmp/studio-test STUDIO_NO_KEYCHAIN=1 "release/mac-arm64/Wildroom.app/Contents/MacOS/Wildroom"
```

Smoke test for a new build: mount the dmg, copy the app out of it and launch it with a scratch `STUDIO_HOME` — the
window opens and the UI loads, Home → New project creates a project, a demo shot generates (ffmpeg makes its proxy,
poster and waveform), and quitting shuts the server down cleanly.

## Known limits

- arm64 only: the build targets the host's architecture and installs the native modules for it.
- No auto-update; install a new dmg over the installed app.
- Local models (LTX-2.5, FLUX.2) are not bundled; install them from the repo with `pnpm models:ltx` /
  `pnpm models:flux2` — the app finds them in `~/Library/Application Support/Wildroom/Models`.
