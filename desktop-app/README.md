# AeroGyan desktop app (Windows · macOS · Linux)

A real installed app — not a browser shortcut. It opens `https://aerogyan.tech/app` in its own
window with its own icon, Start-menu and desktop entry, and appears in **Settings › Apps**.

## What students get
- **One-click install, no admin password** — installs for the current Windows user in a few
  seconds (`AeroGyan-Setup-1.0.N.exe`, 64-bit Windows 10 / 11).
- **Screenshots, screen recording and screen sharing show a black window** (content protection),
  like the Android app.
- Remembers its window size and position.
- **Downloads work** — notes PDF/PNG, exports and materials are saved to *Downloads › AeroGyan*
  with a notification (click it to open the folder).
- **Certificates / pop-ups** open in an app window; *Print → Microsoft Print to PDF* saves a PDF.
- **Payments** (Razorpay, bank pages) stay inside the app; YouTube, WhatsApp, LinkedIn and other
  sites open in the normal browser.
- **Offline screen** that reconnects by itself.
- **Automatic updates** — the app checks aerogyan.tech every few hours, downloads a new version in
  the background and installs it on restart.
- Keyboard: `F5` reload · `F11` full screen · `Ctrl +` / `Ctrl -` / `Ctrl 0` zoom ·
  `Alt ←` back · mouse back/forward buttons.
- The website sees `AeroGyanApp/<version> (Desktop; Windows)` in the user-agent, so its
  "Get App" buttons are hidden inside the app. Voice typing (needs Chrome) is hidden; typing,
  paste, photos and files work.

## Building (no Windows PC needed)
GitHub builds and tests it:

0. **One time:** move `desktop-app/ci/windows-app.yml` to `.github/workflows/windows-app.yml`
   (GitHub only runs workflows from there). No secrets are needed.
1. Push to `main` (any change inside `desktop-app/`), or open **GitHub → Actions →
   "Windows app (installer)" → Run workflow**.
2. After ~10 minutes a Release **windows-v1.0.N** appears with `AeroGyan-Setup-1.0.N.exe` and
   `windows-test-report-1.0.N.txt` (the app installed and tested itself on a real Windows machine).
3. On the website: **Admin → Apps → Windows → Publish latest from GitHub** (or upload the `.exe`).
   From then on the Windows "Get App" button downloads it, and installed apps update themselves.

## "Windows protected your PC"
The installer is not code-signed yet, so the first time Windows SmartScreen and Edge show a
warning (*More info → Run anyway*; in Edge *… → Keep*). The website's install guide explains this
to students. To remove the warning for good, either:
- publish the app in the **Microsoft Store** (a free individual developer account; the Store signs
  it), or
- buy a **code-signing certificate** and add it to the build.

## Run it on your own computer (optional)
```
cd desktop-app
npm install
npm start            # opens the app
npm run dist:win     # builds the installer (on Windows)
```

## macOS and Linux (2026-11-20)
The same code builds the Mac and Linux apps (`npm run dist:mac` on a Mac, `npm run dist:linux` on Linux).
In the cloud: workflow `.github/workflows/desktop-app.yml` (branch `desktop-maclinux`) runs on a tag
`desktop-v1.0.N` (or by hand with the version) and makes ONE Release `desktop-v1.0.N` with
- `AeroGyan-1.0.N.dmg` — macOS 11+, one app for Intel and Apple silicon (built on `macos-15-intel`). Ad-hoc signed,
  not notarized: the first open needs **System Settings → Privacy & Security → Open Anyway** (macOS 14 or older:
  right-click → Open). Notarizing needs an Apple Developer account (99 USD / year); then set `identity`,
  `hardenedRuntime` and `notarize` in `package.json` → `build.mac`.
- `AeroGyan-1.0.N.AppImage` — any 64-bit Linux; updates itself from `https://aerogyan.tech/download/linux/`
  (`latest-linux.yml`). On its first start it adds `~/.local/share/applications/tech.aerogyan.app.desktop` (the
  applications menu + `aerogyan://` links) and rewrites it when it moves (an update renames the file). Ubuntu 22.04+
  may need `libfuse2` (24.04: `libfuse2t64`).
- `AeroGyan-1.0.N.deb` — Ubuntu / Debian: `/opt/AeroGyan`, `/usr/bin/aerogyan`, launcher `aerogyan.desktop` with
  `aerogyan://`, electron-builder's AppArmor profile for Ubuntu 24.04.
- `desktop-test-report-1.0.N.txt` — the checks and the self-test of each build (also on Ubuntu 24.04).

Then **Admin → Apps → Mac & Linux → Publish latest from GitHub** (the server also takes new builds by itself every
20 minutes). Downloads: `/download/mac`, `/download/linux` (AppImage), `/download/linux-deb`.

Differences from Windows:
- **Updates** — Windows and the AppImage update themselves. An unsigned Mac app cannot replace itself and a .deb
  needs the admin password, so those ask `/api/app-release` every 6 hours and offer **Download** when a newer
  version is out (once per version every 3 days).
- **Screenshots** — blocked on Windows and macOS (content protection). Linux has no way for an app to keep its
  window out of a capture, so it is not attempted there (the self-test lists it as info).
- **Device key** — macOS IOPlatformUUID, Linux `/etc/machine-id` (Windows MachineGuid): one device slot per
  computer for the main app and the Office packs.
- User agent `AeroGyanApp/<v> (Desktop; macOS)` / `(Desktop; Linux)`.

Try the self-test on a Mac (from VS Code's terminal Electron needs `env -u ELECTRON_RUN_AS_NODE`):
```
env -u ELECTRON_RUN_AS_NODE npx electron . --aero-selftest=/tmp/st && cat /tmp/st/report.txt
```

## AeroGyan Office apps (same code, `OFFICE_SLUG`)
Each of the 24 Office apps is the same program with its own id, name, icon, data folder and
update feed, built with `desktop-app/office/builder.config.js`:
```
OFFICE_SLUG=sheets npx electron-builder --config office/builder.config.js --win nsis --x64 --publish never
OFFICE_SLUG=sheets npx electron .        # try it without building (opens /apps/sheets/)
```
- appId `tech.aerogyan.office.<slug>`, Start-menu/desktop name and Settings › Apps = the full name
  (AeroGyan Sheets), installer `AeroGyan-<Short>-Setup-<version>.exe` (Sheets, AISolver, PlacementPrep …).
- Opens `https://aerogyan.tech/apps/<slug>/`; user agent `AeroGyanApp/<ver> (Desktop; Windows; Office <slug>)`.
- Updates from `https://aerogyan.tech/download/office/<slug>/windows/` (electron-updater feed).
- Only the main app registers `aerogyan://` links.
- Icons: `desktop-app/office/<slug>/icon.ico` + `office-icon.png`, made by
  `node desktop-app/office/make-office-icons.js` (pure JavaScript, from `office/icons/<slug>/`).
- In the cloud: workflow `office-windows.yml` (branch `office-apps`) builds every app and pack, smoke-tests
  each (`ci/office-smoke.ps1`, packs `ci/office-pack-smoke.ps1`), builds the main app as a check and makes
  one Release `office-windows-v1.0.<run>`.

### Packs (`OFFICE_PACK`) — one installer, every app of the pack
```
OFFICE_PACK=professors npx electron-builder --config office/builder.config.js --win nsis --x64 --publish never
OFFICE_PACK=professors npx electron . --office=grading     # try it without building
```
- ONE program `AeroGyan for Professors.exe` (appId `tech.aerogyan.pack.<id>`), one-click per-user
  installer `AeroGyan-ProfessorPack-Setup-<version>.exe` (StudentPack for students).
- The installer (`office/pack-<id>/pack.nsh`, written by builder.config.js) makes a Start-menu folder
  "AeroGyan for Professors" with the pack's HOME shortcut ("AeroGyan for Professors", sorts first) and one
  shortcut per app ("Courses", "Live Classes" …: `--office=<slug>`, the app's own `.ico` from
  `resources/office-icons/<slug>.ico`, its own AppUserModelID `tech.aerogyan.pack.<id>.<slug>`), and the
  same on the desktop (home + every app as "AeroGyan <App>"). Missing desktop shortcuts are made on every
  install AND update (never twice, never over a stand-alone app's shortcut; the ones we made are listed in
  `HKCU\Software\tech.aerogyan.pack.<id>`); uninstall removes them all. After installing / updating it
  opens the home.
- The HOME (`src/pack-home.html`, local, works offline, light/dark, the pack's colours): every app as a
  big tile with its icon and line, "All 16 apps are installed — find them on your desktop and in Start →
  AeroGyan for Professors". A tile opens that app's window. It opens when the program starts without
  `--office` (home shortcut, after install).
- main.js: `--office=<slug>` opens that app's window at `/apps/<slug>/` (own window size, own taskbar
  id via `setAppDetails`, so the taskbar keeps each app apart); a second launch goes to the running copy
  (one single-instance lock per pack) and opens / focuses that app's window (or the home). One session →
  one sign-in.
- User agent `… (Desktop; Windows; Office pack <id>)`; updates from
  `https://aerogyan.tech/download/office/pack/<id>/windows/`.

Every AeroGyan desktop app (main + Office) gives the website `AeroGyanDesktop.deviceKey()` =
base64url(sha256("aerogyan-device:" + Windows MachineGuid)), so all of them on one PC share one device slot.
