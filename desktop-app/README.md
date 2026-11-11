# AeroGyan desktop app (Windows · macOS later)

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

## macOS (next)
The same code builds a Mac app (`npm run dist:mac` on a Mac). For students to open it without
warnings it must be signed and notarized with an Apple Developer account (99 USD / year).

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
  "AeroGyan for Professors" with one shortcut per app: `--office=<slug>`, the app's own `.ico`
  (`resources/office-icons/<slug>.ico`), its own AppUserModelID `tech.aerogyan.pack.<id>.<slug>`;
  desktop shortcuts only for the first 4 apps (never over a stand-alone app's shortcut); uninstall
  removes them all.
- main.js: `--office=<slug>` opens that app's window at `/apps/<slug>/` (own window size, own taskbar
  id via `setAppDetails`, so the taskbar keeps each app apart); a second launch goes to the running copy
  (one single-instance lock per pack) and opens / focuses that app's window. One session → one sign-in.
- User agent `… (Desktop; Windows; Office pack <id>)`; updates from
  `https://aerogyan.tech/download/office/pack/<id>/windows/`.

Every AeroGyan desktop app (main + Office) gives the website `AeroGyanDesktop.deviceKey()` =
base64url(sha256("aerogyan-device:" + Windows MachineGuid)), so all of them on one PC share one device slot.
