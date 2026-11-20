/* ============================================================
   AeroGyan — desktop app (Windows, macOS, Linux)
   ------------------------------------------------------------
   ⭐ 2026-11-20 — macOS (universal .dmg) and Linux (.AppImage + .deb):
   • aerogyan:// links: Windows registry / macOS Info.plist / the .deb's
     launcher; the AppImage writes its own launcher on start
     (integrateAppImage) so links and the applications menu find it.
   • device key: Windows MachineGuid, macOS IOPlatformUUID, Linux
     /etc/machine-id (one device slot per computer).
   • content protection is Windows + macOS only — Linux has no way to
     keep a window out of screenshots, so it is skipped there.
   • updates: Windows + AppImage update themselves (electron-updater,
     …/download/windows/ and …/download/linux/); the Mac app (not
     notarized) and the .deb (needs the admin password) instead ask
     /api/app-release and offer to download the new version.
   A real installed app (not a browser shortcut). It opens the
   AeroGyan landing page (https://aerogyan.tech/) in its own window
   with its own icon, Start-menu / desktop entry and taskbar button;
   "Log in" / "Start learning" lead on to https://aerogyan.tech/app.
   • Back (mouse back button, Alt+←) closes the site's pop-ups and
     menus first (window.aeroBack), then goes back a page.

   • Screenshots, screen recording and screen sharing show a black
     window (content protection) — like FLAG_SECURE on Android.
   • aerogyan.tech and Razorpay stay inside the app; YouTube,
     WhatsApp, social and other sites open in the normal browser.
   • Downloads (notes PDF/PNG, exports, materials) are saved to
     Downloads › AeroGyan with a notification.
   • Certificates / pop-ups open in an app window; Print works
     (choose "Microsoft Print to PDF" to save a PDF).
   • Offline screen that retries by itself.
   • Updates download in the background from aerogyan.tech and
     install on restart (Admin → Apps publishes them).
   • The website sees "AeroGyanApp/<version> (Desktop; Windows)"
     in the user-agent and hides its "Get App" buttons.
   • AeroGyanDesktop.deviceKey() (preload) gives the website a stable
     key for this PC (from the Windows MachineGuid), so the main app
     and the Office apps on one PC share one device slot.
   • The same code is every AeroGyan Office app (Sheets, Slides …):
     the build (office/builder.config.js, OFFICE_SLUG=<slug>) writes
     "aerogyanOffice" into the packaged package.json; the app then opens
     https://aerogyan.tech/apps/<slug>/ under its own name, data folder,
     taskbar id and update feed, and says "(Desktop; Windows; Office
     <slug>)" in its user-agent. Try one without building:
     OFFICE_SLUG=sheets npx electron .
   • …and every AeroGyan Office PACK ("AeroGyan for Professors" …,
     OFFICE_PACK=<id>, package.json "aerogyanPack"): ONE program whose
     installer puts a shortcut per app in the Start menu, each running it
     with --office=<slug>. Every app opens in its own window at
     https://aerogyan.tech/apps/<slug>/ with its own icon, window size and
     taskbar id (tech.aerogyan.pack.<id>.<slug>, so the taskbar keeps the
     apps apart); a second launch of an open app focuses its window. All
     windows share one session, so one sign-in covers the whole pack.
     Without --office it opens the pack's HOME (src/pack-home.html: every
     app as a tile). User-agent "(Desktop; Windows; Office pack <id>)". Try:
     OFFICE_PACK=professors npx electron . [--office=grading]
   ============================================================ */
'use strict';

const { app, BrowserWindow, Menu, session, shell, dialog, Notification, screen, ipcMain, nativeTheme, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

/* an AeroGyan Office app? (null = the main AeroGyan app) */
const OFFICE = (() => {
  let o = null;
  try { o = require('../package.json').aerogyanOffice || null; } catch (_) {}
  const env = String(process.env.OFFICE_SLUG || '').trim().toLowerCase();
  if (!o && env && !app.isPackaged && /^[a-z][a-z0-9]{0,31}$/.test(env)) {   // npx electron . with OFFICE_SLUG
    o = { slug: env, name: 'AeroGyan ' + env };
    for (const f of ['../../office/apps.json', '../office/apps.json']) {
      try {
        const a = (require(f).apps || []).find((x) => x.slug === env);
        if (a) { o = { slug: a.slug, name: a.name, color: a.color2 || a.color }; break; }
      } catch (_) {}
    }
  }
  return o && o.slug ? o : null;
})();

/* an AeroGyan Office pack? ({id, name, short, apps: [{slug, name, short, color}]} or null) */
const PACK = (() => {
  if (OFFICE) return null;
  let p = null;
  try { p = require('../package.json').aerogyanPack || null; } catch (_) {}
  const env = String(process.env.OFFICE_PACK || '').trim().toLowerCase();
  if (!p && env && !app.isPackaged && /^[a-z][a-z0-9]{0,31}$/.test(env)) {         // npx electron . with OFFICE_PACK
    for (const f of ['../../office/apps.json', '../office/apps.json']) {
      try {
        const d = require(f);
        const pk = (d.packs || []).find((x) => x.id === env);
        if (!pk) continue;
        const apps = pk.apps.map((s) => (d.apps || []).find((x) => x.slug === s)).filter(Boolean)
          .map((a) => ({ slug: a.slug, name: a.name, short: a.short, line: a.line, color: a.color2 || a.color, color1: a.color }));
        p = { id: pk.id, name: pk.name, short: pk.short, line: pk.line, folder: pk.name, apps };
        break;
      } catch (_) {}
    }
  }
  return p && p.id && Array.isArray(p.apps) && p.apps.length ? p : null;
})();
/* --office=<slug> on the command line (the pack's shortcuts pass it) */
function officeArg(argv) {
  const a = (argv || []).find((x) => typeof x === 'string' && /^--office=/i.test(x));
  return a ? a.slice('--office='.length).trim().toLowerCase() : '';
}
function packApp(slug) { return (PACK && slug && PACK.apps.find((a) => a.slug === slug)) || null; }
const packAppId = (a) => `tech.aerogyan.pack.${PACK.id}.${a.slug}`;
const packAppUrl = (a) => `https://aerogyan.tech/apps/${a.slug}/`;
/* the app this launch asked for; null = no / unknown --office → the pack's HOME window (a local page
   with every app of the pack as a tile: the installer's "run after install" and the pack's own shortcut) */
const LAUNCH_APP = PACK ? packApp(officeArg(process.argv)) : null;

const APP_NAME = OFFICE ? OFFICE.name : PACK ? PACK.name : 'AeroGyan';
const APP_URL = OFFICE ? `https://aerogyan.tech/apps/${OFFICE.slug}/` : PACK ? (LAUNCH_APP ? packAppUrl(LAUNCH_APP) : 'https://aerogyan.tech/apps/') : 'https://aerogyan.tech/app';
const START_URL = (OFFICE || PACK) ? APP_URL : 'https://aerogyan.tech/app';    // first page on launch: the sign-in screen (2026-10-23; the landing page also sends the app there)
const APP_ID = OFFICE ? `tech.aerogyan.office.${OFFICE.slug}` : PACK ? `tech.aerogyan.pack.${PACK.id}` : 'tech.aerogyan.app';
const PROTOCOL = 'aerogyan';                       // only the main app registers aerogyan:// links
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
const OS_NAME = IS_MAC ? 'macOS' : (process.platform === 'win32' ? 'Windows' : 'Linux');
const isColor = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
const BG = (OFFICE && isColor(OFFICE.color)) ? OFFICE.color : '#0b1226';
const ICON = path.join(__dirname, OFFICE && fs.existsSync(path.join(__dirname, 'office-icon.png')) ? 'office-icon.png' : 'icon.png');
/* a pack app's window icon (packed as src/office-icons/<slug>/office-icon.png) */
function packIcon(a) {
  const f = path.join(__dirname, 'office-icons', a.slug, 'office-icon.png');
  return fs.existsSync(f) ? f : ICON;
}

/* each app keeps its own data folder (sign-in, window size) — also when run with npx electron .
   (a pack has ONE data folder for all its apps: one sign-in) */
if (OFFICE || PACK) {
  try { app.setName(APP_NAME); app.setPath('userData', path.join(app.getPath('appData'), APP_NAME)); } catch (_) {}
}

/* ⭐ 2026-10-14 — classroom smartboards. Their vendor software (floating toolbars,
   annotation layers) keeps a transparent, always-on-top window over the screen; Chromium's
   native-occlusion check then decides our window is hidden and stops painting it — a black
   or frozen page and stuttering ink. Our window is never truly hidden behind those, so the
   check is switched off. Must run before the app is ready. */
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

/* --aero-selftest=<folder> : used only by the GitHub build to test the app, then it quits */
const SELFTEST_DIR = (() => {
  const a = process.argv.find((x) => x.startsWith('--aero-selftest='));
  return a ? a.slice('--aero-selftest='.length) : null;
})();

/* ---------------------------------------------------------------- hosts */
const EXTERNAL_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com',
  'wa.me', 'api.whatsapp.com', 'web.whatsapp.com', 'chat.whatsapp.com',
  'play.google.com', 'maps.google.com', 'maps.app.goo.gl',
  'linkedin.com', 'www.linkedin.com', 'instagram.com', 'www.instagram.com',
  'facebook.com', 'www.facebook.com', 'm.facebook.com', 'twitter.com', 'x.com', 't.me'
]);
const PAYMENT_DOMAINS = ['razorpay.com', 'razorpay.in', 'rzp.io'];
/* only these schemes are ever handed to Windows / macOS */
const SAFE_EXTERNAL = new Set(['http:', 'https:', 'mailto:', 'tel:', 'whatsapp:', 'tg:']);

function parse(u) { try { return new URL(u); } catch (_) { return null; } }
function hostOf(u) { const p = parse(u); return p ? p.hostname.toLowerCase() : ''; }
function isOwnHost(h) { return h === 'aerogyan.tech' || h.endsWith('.aerogyan.tech'); }
function isPaymentHost(h) { return PAYMENT_DOMAINS.some((d) => h === d || h.endsWith('.' + d)); }
function isInAppUrl(u) {                   // pages the MAIN window may show
  const p = parse(u);
  if (!p) return false;
  if (p.protocol !== 'https:') return false;
  return isOwnHost(p.hostname) || isPaymentHost(p.hostname);
}

/* ---------------------------------------------------------------- log */
let LOG_FILE = null;
function log(...args) {
  try {
    if (!LOG_FILE) {
      const dir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      LOG_FILE = path.join(dir, 'main.log');
      try { if (fs.statSync(LOG_FILE).size > 512 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old'); } catch (_) {}
    }
    const line = new Date().toISOString() + ' ' + args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    fs.appendFileSync(LOG_FILE, line + '\n');
    if (!app.isPackaged || SELFTEST_DIR) console.log(line);
  } catch (_) {}
}
process.on('uncaughtException', (e) => log('uncaught', e));
process.on('unhandledRejection', (e) => log('unhandled', e));

/* hooks the self-test listens to */
const hooks = { external: [], downloads: [], children: [] };

/* ---------------------------------------------------------------- start-up */
/* Windows notifications + taskbar grouping (a pack: the launched app's own id, or the pack's id for
   its home — each of its windows then sets its own, see packWindowDetails) */
if (process.platform === 'win32') app.setAppUserModelId(PACK && LAUNCH_APP ? packAppId(LAUNCH_APP) : APP_ID);

/* the app window (a pack: the one used last) — dialogs, updates and the self-test use it */
let mainWin = null;
/* every top-level app window (not pop-ups): the main window, or one per open app of a pack */
const appWindows = new Set();
/* a pack's open app windows: slug → BrowserWindow */
const packWins = new Map();
/* a pack's home window (the launcher page) */
let homeWin = null;
let pendingDeepLink = null;

/* per app / per pack (keyed by its data folder); a pack tells the running copy which app to open */
const gotLock = SELFTEST_DIR ? true : app.requestSingleInstanceLock(PACK ? { office: LAUNCH_APP ? LAUNCH_APP.slug : '' } : undefined);
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, _cwd, extra) => {
    if (PACK) {                                       // another shortcut of the pack: open / focus that app
      if (!app.isReady()) return;
      const a = packApp(officeArg(argv)) || packApp(extra && extra.office);
      if (a) openPackApp(a); else openPackHome();          // no --office: the pack's home
      ciReport('second-instance');
      return;
    }
    const link = (argv || []).find((a) => typeof a === 'string' && a.startsWith(PROTOCOL + '://'));
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
      if (link) openDeepLink(link);
    }
  });
  app.on('open-url', (e, url) => {                   // macOS deep links
    e.preventDefault();
    if (mainWin) { openDeepLink(url); mainWin.show(); mainWin.focus(); return; }
    pendingDeepLink = url;
    /* the app still runs in the Dock with every window closed: open one for the link */
    if (app.isReady() && !PACK && !OFFICE) createMainWindow();
  });
  pendingDeepLink = process.argv.find((a) => typeof a === 'string' && a.startsWith(PROTOCOL + '://')) || null;

  app.whenReady().then(onReady).catch((e) => { log('ready failed', e); app.exit(1); });
}

function onReady() {
  log('start', APP_NAME, app.getVersion(), 'electron', process.versions.electron, OS_NAME, SELFTEST_DIR ? 'SELFTEST' : '');
  if (app.isPackaged && !SELFTEST_DIR && !OFFICE && !PACK) {
    /* Linux: the .deb's launcher declares aerogyan:// (MimeType) and the AppImage writes its own —
       Electron's xdg-settings call would name a launcher that may not exist */
    if (IS_LINUX) integrateAppImage();
    else try { app.setAsDefaultProtocolClient(PROTOCOL); } catch (_) {}
  }
  setupSession(session.defaultSession);
  Menu.setApplicationMenu(IS_MAC ? buildMacMenu() : null);
  /* ⭐ round 5: on a Mac the pack is one app in the Dock — right-click it to open any of its apps */
  if (PACK && IS_MAC && app.dock) {
    try {
      app.dock.setMenu(Menu.buildFromTemplate([
        { label: 'All apps', click: () => openPackHome() }, { type: 'separator' },
        ...PACK.apps.map((a) => ({ label: a.short || String(a.name || a.slug).replace(/^AeroGyan\s+/, ''), click: () => openPackApp(a) }))
      ]));
    } catch (e) { log('dock menu failed', e); }
  }
  if (PACK) { if (LAUNCH_APP) openPackApp(LAUNCH_APP); else openPackHome(); } else createMainWindow();
  setupAutoUpdate();
  if (SELFTEST_DIR) {
    require('./selftest').run({
      app, dir: SELFTEST_DIR, hooks, appUrl: APP_URL, appName: APP_NAME,
      office: OFFICE || (PACK && LAUNCH_APP ? { slug: LAUNCH_APP.slug, name: LAUNCH_APP.name } : null),
      uaTag: PACK ? `Office pack ${PACK.id}` : OFFICE ? `Office ${OFFICE.slug}` : null,
      getMainWindow: () => mainWin, deepLinkToUrl, log
    });
  }
}

app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });
app.on('activate', () => {
  if (mainWin || !app.isReady()) return;
  if (PACK) openPackHome(); else createMainWindow();
});

/* ---------------------------------------------------------------- session */
function setupSession(ses) {
  /* a clean Chrome user-agent + our marker (no "Electron/…" token) */
  const base = ses.getUserAgent()
    .replace(/\sElectron\/\S+/i, '')
    .replace(new RegExp('\\s' + app.getName().replace(/[^A-Za-z0-9]/g, '.') + '\\/\\S+', 'i'), '')
    .replace(/\saerogyan(-desktop)?\/\S+/i, '')
    .replace(/\sAeroGyan[^\s/]*\/\S+/gi, '');          // Office apps: "AeroGyanCampusQ&A/1.0.1" (name without spaces)
  const ua = `${base} AeroGyanApp/${app.getVersion()} (Desktop; ${OS_NAME}${PACK ? '; Office pack ' + PACK.id : OFFICE ? '; Office ' + OFFICE.slug : ''})`;
  app.userAgentFallback = ua;
  ses.setUserAgent(ua);

  const ALLOWED = new Set(['clipboard-sanitized-write', 'clipboard-read', 'notifications', 'fullscreen', 'media', 'speaker-selection']);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const h = hostOf((details && details.requestingUrl) || (wc && wc.getURL()) || '');
    /* full screen is fine for any embedded player (e.g. a lecture video); the rest only for our site */
    const ok = permission === 'fullscreen' || ((isOwnHost(h) || isPaymentHost(h)) && ALLOWED.has(permission));
    if (!ok) log('permission denied', permission, h);
    cb(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    const h = hostOf(origin || '');
    return permission === 'fullscreen' || isOwnHost(h) || isPaymentHost(h);
  });

  ses.on('will-download', onWillDownload);
}

/* ---------------------------------------------------------------- device key */
/* base64url(sha256("aerogyan-device:" + machine id)), the same in every AeroGyan app on
   this computer (main app + Office apps) so they count as one device. "" if it can't be read.
   machine id = Windows MachineGuid · macOS IOPlatformUUID · Linux /etc/machine-id */
let DEVICE_KEY = null;
function machineId() {
  const opts = { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
  if (process.platform === 'win32') {
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    const out = execFileSync(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], opts);
    const m = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out);
    return m ? m[1].trim() : '';
  }
  if (IS_MAC) {                                    // the Mac's hardware UUID (System Information → Hardware UUID)
    const ioreg = fs.existsSync('/usr/sbin/ioreg') ? '/usr/sbin/ioreg' : 'ioreg';     // a Finder launch has a short PATH
    const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(execFileSync(ioreg, ['-rd1', '-c', 'IOPlatformExpertDevice'], opts));
    return m ? m[1] : '';
  }
  for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {     // Linux (systemd / D-Bus)
    try { const v = fs.readFileSync(f, 'utf8').trim(); if (v) return v; } catch (_) {}
  }
  return '';
}
function deviceKey() {
  if (DEVICE_KEY !== null) return DEVICE_KEY;
  let id = '';
  try { id = machineId(); } catch (e) { log('device id unavailable', e && e.message); }
  DEVICE_KEY = id ? crypto.createHash('sha256').update('aerogyan-device:' + id, 'utf8').digest('base64url') : '';
  return DEVICE_KEY;
}
ipcMain.on('aerogyan:device-key', (e) => {
  let url = '';
  try { url = (e.senderFrame && e.senderFrame.url) || e.sender.getURL(); } catch (_) {}
  e.returnValue = isOwnHost(hostOf(url)) ? deviceKey() : '';       // only our own pages get it
});

/* ---------------------------------------------------------------- windows */
/* the main app / an Office app: window-state.json; each app of a pack: window-state-<slug>.json */
const STATE_FILE = (slug) => path.join(app.getPath('userData'), slug ? `window-state-${slug}.json` : 'window-state.json');

function loadWindowState(slug) {
  const wa = screen.getPrimaryDisplay().workArea;
  const def = {
    width: Math.min(1360, Math.round(wa.width * 0.9)),
    height: Math.min(880, Math.round(wa.height * 0.9)),
    maximized: wa.width < 1400
  };
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(slug), 'utf8'));
    const b = s && s.bounds;
    if (b && b.width >= 380 && b.height >= 460) {
      const d = screen.getDisplayMatching(b).workArea;          // still on a connected screen?
      const visible = b.x < d.x + d.width - 80 && b.x + b.width > d.x + 80 && b.y >= d.y - 20 && b.y < d.y + d.height - 80;
      if (visible) return { x: b.x, y: b.y, width: b.width, height: b.height, maximized: !!s.maximized };
      return { width: b.width, height: b.height, maximized: !!s.maximized };
    }
  } catch (_) {}
  return def;
}
function saveWindowState(win, slug) {
  try {
    if (!win || win.isDestroyed()) return;
    fs.writeFileSync(STATE_FILE(slug), JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch (_) {}
}

function webPrefs() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    plugins: true,                       // built-in PDF viewer
    spellcheck: true,
    devTools: !app.isPackaged,
    backgroundThrottling: true
  };
}

function createMainWindow() {
  mainWin = createAppWindow({ url: null, title: APP_NAME, icon: ICON, bg: BG, slug: null });
}

/* one top-level app window. url null = START_URL (or the deep link the app was opened with);
   file = a local page of the app instead (the pack's home), with query */
function createAppWindow({ url, file, query, title, icon, bg, slug, cascade, size }) {
  const st = SELFTEST_DIR ? { width: 1280, height: 800, maximized: false } : loadWindowState(slug);
  if (size && st.x === undefined) {                   // a smaller first size (the pack's home)
    const wa = screen.getPrimaryDisplay().workArea;
    st.width = Math.min(size.width, wa.width); st.height = Math.min(size.height, wa.height); st.maximized = false;
  }
  if (cascade && st.x === undefined) {                // a pack's next window: a little lower-right, not on top
    const wa = screen.getPrimaryDisplay().workArea;
    st.x = wa.x + Math.max(0, Math.round((wa.width - st.width) / 2)) + 32 * cascade;
    st.y = wa.y + Math.max(0, Math.round((wa.height - st.height) / 2)) + 32 * cascade;
  }
  const win = new BrowserWindow({
    x: st.x, y: st.y, width: st.width, height: st.height,
    minWidth: 380, minHeight: 460,
    show: false,
    title,
    backgroundColor: bg,
    icon,
    autoHideMenuBar: true,
    webPreferences: webPrefs()
  });
  protect(win);
  appWindows.add(win);
  winIcons.set(win, icon);

  let shown = false;
  const show = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    if (st.maximized) win.maximize();
    win.show();
  };
  win.once('ready-to-show', show);
  setTimeout(show, 3500);                     // never stay invisible on a slow connection

  win.on('close', () => saveWindowState(win, slug));
  win.on('closed', () => { appWindows.delete(win); if (mainWin === win) mainWin = null; });
  win.on('app-command', (_e, cmd) => {          // mouse back / forward buttons
    if (cmd === 'browser-backward') goBack(win.webContents);
    if (cmd === 'browser-forward') goForward(win.webContents);
  });

  const wc = win.webContents;
  wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return;                 // -3 = aborted (e.g. a download)
    if (!/^https?:/i.test(String(failedUrl || ''))) return;
    log('load failed', code, desc, failedUrl);
    wc.loadFile(path.join(__dirname, 'offline.html'), { query: { u: String(failedUrl), c: String(code) } }).catch(() => {});
  });
  wc.on('render-process-gone', async (_e, details) => {
    log('renderer gone', details && details.reason);
    if (win.isDestroyed() || (details && details.reason === 'clean-exit')) return;
    if (SELFTEST_DIR) return wc.reload();
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Reload', 'Close'], defaultId: 0, cancelId: 1,
      title, message: `${title} stopped unexpectedly.`, detail: 'Reload to continue where you were.'
    });
    if (r.response === 0) wc.reload(); else win.close();
  });

  if (file) {
    wc.loadFile(file, { query: query || {} }).catch((e) => log('load failed', file, e && e.message));
    return win;
  }
  let start = url;
  if (!start) {
    start = pendingDeepLink ? (deepLinkToUrl(pendingDeepLink) || START_URL) : START_URL;
    pendingDeepLink = null;
  }
  wc.loadURL(start).catch(() => {});          // failures are shown by did-fail-load
  return win;
}

/* ---------------------------------------------------------------- pack apps */
/* open one app of the pack in its own window, or bring its open window to the front */
function openPackApp(a) {
  let win = packWins.get(a.slug);
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    mainWin = win;
    return win;
  }
  win = createAppWindow({
    url: packAppUrl(a), title: a.name, icon: packIcon(a), slug: a.slug,
    bg: isColor(a.color) ? a.color : '#0b1226', cascade: packWins.size
  });
  packWins.set(a.slug, win);
  packWindowDetails(win, a);
  mainWin = win;
  win.on('focus', () => { mainWin = win; });
  win.on('closed', () => {
    packWins.delete(a.slug);
    if (!mainWin) mainWin = [...packWins.values()].find((w) => !w.isDestroyed()) || null;
    ciReport('closed ' + a.slug);
  });
  win.on('closed', () => { if (!mainWin && homeWin && !homeWin.isDestroyed()) mainWin = homeWin; });
  win.webContents.on('did-finish-load', () => ciReport('loaded ' + a.slug));
  win.webContents.on('did-navigate-in-page', () => ciReport('navigated ' + a.slug));
  ciReport('opened ' + a.slug);
  return win;
}

/* the pack's HOME: a local page (src/pack-home.html, works offline) with every app of the pack as a big
   tile; a tile opens that app's own window (same as its shortcut). Opened by the pack's own shortcut and
   after installing / updating, so the first thing a user sees is that ALL the apps are there. */
const HOME_FILE = path.join(__dirname, 'pack-home.html');
function homeIcon() {
  const f = path.join(__dirname, 'office-icons', '_pack', 'office-icon.png');
  return fs.existsSync(f) ? f : ICON;
}
function openPackHome() {
  if (homeWin && !homeWin.isDestroyed()) {
    if (homeWin.isMinimized()) homeWin.restore();
    homeWin.show();
    homeWin.focus();
    mainWin = homeWin;
    return homeWin;
  }
  const dark = nativeTheme.shouldUseDarkColors;
  const data = {
    id: PACK.id, name: PACK.name, line: PACK.line || '', folder: PACK.folder || PACK.name,
    color: PACK.color || '#4F46E5', color2: PACK.color2 || '#1E1B4B', accent: PACK.accent || PACK.color || '#818CF8',
    version: app.getVersion(),
    // ⭐ round 5: where the apps are differs per system (Start menu / Dock / applications menu)
    os: process.platform, appimage: !!process.env.APPIMAGE,
    apps: PACK.apps.map((a) => ({ slug: a.slug, name: a.name, line: a.line || '', color: a.color1 || a.color || '', color2: a.color || '' }))
  };
  const win = createAppWindow({
    file: HOME_FILE, query: { d: JSON.stringify(data) }, title: PACK.name, icon: homeIcon(), slug: 'home',
    bg: dark ? '#0b1020' : '#f6f7fb', size: { width: 1040, height: 760 }
  });
  homeWin = win;
  mainWin = win;
  if (process.platform === 'win32') {
    try {
      const ico = path.join(process.resourcesPath || '', 'office-icons', '_pack.ico');
      const details = { appId: APP_ID, relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: PACK.name };
      if (app.isPackaged && fs.existsSync(ico)) { details.appIconPath = ico; details.appIconIndex = 0; }
      win.setAppDetails(details);
    } catch (e) { log('setAppDetails failed', e); }
  }
  const wc = win.webContents;
  /* a tile is a link to https://aerogyan.tech/apps/<slug>/: open that app's window instead; the home page
     itself never navigates away */
  const route = (u) => {
    const p = parse(u);
    const m = p && p.protocol === 'https:' && isOwnHost(p.hostname) && /^\/apps\/([a-z][a-z0-9]{0,31})\/?$/.exec(p.pathname);
    const a = m && packApp(m[1]);
    if (a) { openPackApp(a); return true; }
    if (p && /^https?:$/.test(p.protocol)) openExternal(u);
    return false;
  };
  wc.on('will-navigate', (e, navUrl) => {
    const u = navUrl || (e && e.url) || '';
    if (/^file:/i.test(u) && u.split('?')[0] === wc.getURL().split('?')[0]) return;     // its own reload
    e.preventDefault();
    route(u);
  });
  wc.setWindowOpenHandler(({ url }) => { route(url); return { action: 'deny' }; });
  wc.on('did-finish-load', () => { ciReport('loaded home'); ciClickLoop(); });
  win.on('focus', () => { mainWin = win; });
  win.on('closed', () => {
    if (homeWin === win) homeWin = null;
    if (!mainWin) mainWin = [...packWins.values()].find((w) => !w.isDestroyed()) || null;
    ciReport('closed home');
  });
  ciReport('opened home');
  return win;
}

/* Windows: the window's own taskbar id (= its Start-menu shortcut's), icon and relaunch command,
   so each app of the pack has its own taskbar button and pins to the taskbar as itself */
function packWindowDetails(win, a) {
  if (process.platform !== 'win32') return;
  try {
    const ico = path.join(process.resourcesPath || '', 'office-icons', a.slug + '.ico');
    const details = {
      appId: packAppId(a),
      relaunchCommand: `"${process.execPath}" --office=${a.slug}`,
      relaunchDisplayName: a.name
    };
    if (app.isPackaged && fs.existsSync(ico)) { details.appIconPath = ico; details.appIconIndex = 0; }
    win.setAppDetails(details);
  } catch (e) { log('setAppDetails failed', e); }
}

/* CI only: the Windows smoke test (ci/office-pack-smoke.ps1) creates <userData>\ci-report.on and then
   reads <userData>\ci-report.json to see which app windows are open and on which page. */
let CI_REPORT;
function ciReport(why) {
  if (!PACK) return;
  if (CI_REPORT === undefined) {
    CI_REPORT = null;
    try {
      const dir = app.getPath('userData');
      if (fs.existsSync(path.join(dir, 'ci-report.on'))) CI_REPORT = path.join(dir, 'ci-report.json');
    } catch (_) {}
  }
  if (!CI_REPORT) return;
  try {
    const windows = [];
    for (const [slug, w] of packWins) {
      if (w.isDestroyed()) continue;
      windows.push({ slug, appId: packAppId(packApp(slug)), url: w.webContents.getURL(), title: w.getTitle(), visible: w.isVisible() });
    }
    let home = null;
    if (homeWin && !homeWin.isDestroyed()) {
      const hwc = homeWin.webContents;
      home = { url: hwc.getURL().split('?')[0], title: homeWin.getTitle(), visible: homeWin.isVisible(), appId: APP_ID, loaded: !hwc.isLoading() };
    }
    fs.writeFileSync(CI_REPORT, JSON.stringify({ pid: process.pid, why, launched: LAUNCH_APP ? LAUNCH_APP.slug : 'home', ua: app.userAgentFallback, home, homeTiles: ciTiles, windows, at: new Date().toISOString() }, null, 1));
  } catch (e) { log('ci report failed', e); }
}
/* CI only: <userData>\ci-click holds a slug → click that tile on the home page, like a user would */
let ciTiles = null, ciLoop = null;
function ciClickLoop() {
  ciReport('home ready');
  if (!CI_REPORT || ciLoop) return;
  const file = path.join(app.getPath('userData'), 'ci-click');
  const read = () => {
    if (!homeWin || homeWin.isDestroyed()) return;
    homeWin.webContents.executeJavaScript('Array.from(document.querySelectorAll("a.tile")).map(function (a) { return a.dataset.slug + "|" + (a.querySelector("img") && a.querySelector("img").naturalWidth > 0 ? "icon" : "no-icon") + "|" + a.querySelector(".name").textContent; })')
      .then((t) => { ciTiles = t; ciReport('home tiles'); }).catch(() => {});
  };
  setTimeout(read, 800);
  ciLoop = setInterval(() => {
    try {
      if (!fs.existsSync(file)) return;
      const slug = fs.readFileSync(file, 'utf8').trim();
      fs.unlinkSync(file);
      if (!homeWin || homeWin.isDestroyed() || !/^[a-z][a-z0-9]{0,31}$/.test(slug)) return;
      homeWin.webContents.executeJavaScript(`(function(){var a=document.querySelector('a.tile[data-slug="${slug}"]'); if(!a) return false; a.click(); return true;})()`)
        .then((ok) => ciReport('clicked ' + slug + ' ' + ok)).catch(() => {});
    } catch (e) { log('ci click failed', e); }
  }, 500);
}

/* screenshots / recording / screen sharing see a black window — Windows and macOS only: Linux (X11 and
   Wayland) has no way for an app to keep its window out of a capture, so there is nothing to switch on */
const CAN_PROTECT = process.platform === 'win32' || IS_MAC;
function protect(win) {
  if (!CAN_PROTECT) return;
  try { win.setContentProtection(true); } catch (e) { log('content protection failed', e); }
}

/* each window's icon (pop-ups use their app window's) */
const winIcons = new WeakMap();

function childWindowOptions(parent) {
  const pb = parent && !parent.isDestroyed() ? parent.getBounds() : null;
  const width = pb ? Math.max(720, Math.min(1100, pb.width - 80)) : 1000;
  const height = pb ? Math.max(560, Math.min(860, pb.height - 60)) : 760;
  return {
    width, height,
    minWidth: 360, minHeight: 360,
    parent: IS_MAC ? undefined : parent || undefined,
    show: true,
    backgroundColor: '#ffffff',
    icon: (parent && winIcons.get(parent)) || ICON,
    autoHideMenuBar: true,
    title: APP_NAME,
    webPreferences: webPrefs()
  };
}

/* every web page the app creates (main window, pop-ups) gets the same rules */
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());

  contents.setWindowOpenHandler(({ url }) => {
    const p = parse(url);
    const scheme = p ? p.protocol : '';
    const inApp = url === '' || url === 'about:blank' || scheme === 'blob:' || scheme === 'data:' ||
                  (scheme === 'https:' && (isOwnHost(p.hostname) || isPaymentHost(p.hostname)));
    if (inApp) {
      const parent = BrowserWindow.fromWebContents(contents) || mainWin;
      return { action: 'allow', overrideBrowserWindowOptions: childWindowOptions(parent) };
    }
    openExternal(url);
    return { action: 'deny' };
  });

  contents.on('did-create-window', (child) => {
    protect(child);
    try { child.setMenu(null); } catch (_) {}
    hooks.children.push(child);
  });

  contents.on('will-navigate', (e, navUrl) => {
    const url = navUrl || (e && e.url) || '';
    const own = BrowserWindow.fromWebContents(contents);
    const isMain = !!own && appWindows.has(own) && contents === own.webContents;
    const p = parse(url);
    if (!p) { e.preventDefault(); return; }
    if (isMain) {
      if (isInAppUrl(url)) return;
      e.preventDefault();
      openExternal(url);
      return;
    }
    /* pop-ups (payment / bank pages, certificates) may go anywhere on https,
       except the sites that have their own apps */
    if (p.protocol === 'https:' || p.protocol === 'http:') {
      if (EXTERNAL_HOSTS.has(p.hostname.toLowerCase())) { e.preventDefault(); openExternal(url); }
      return;
    }
    if (p.protocol === 'about:' || p.protocol === 'blob:' || p.protocol === 'data:') return;
    e.preventDefault();
    openExternal(url);
  });

  contents.on('zoom-changed', (_e, dir) => zoom(contents, dir === 'in' ? 1 : -1));
  contents.on('before-input-event', (e, input) => onKey(contents, e, input));
  contents.on('context-menu', (_e, params) => contextMenu(contents, params));
});

function openExternal(url) {
  const p = parse(url);
  if (!p || !SAFE_EXTERNAL.has(p.protocol)) { log('blocked external', url); return; }
  hooks.external.push(url);
  if (SELFTEST_DIR) return;                       // the test only records it
  shell.openExternal(url).catch((e) => log('openExternal failed', e));
}

/* ---------------------------------------------------------------- keys, zoom, menu */
function historyBack(wc) {
  const h = wc.navigationHistory;
  if (h && h.canGoBack()) h.goBack(); else if (!h && wc.canGoBack && wc.canGoBack()) wc.goBack();
}
/* the website first closes its own pop-up / menu (or goes up a page) */
function goBack(wc) {
  let host = '';
  try { host = new URL(wc.getURL()).hostname; } catch (_) {}
  if (!/(^|\.)aerogyan\.tech$/i.test(host)) return historyBack(wc);
  wc.executeJavaScript('(function(){try{return !!(window.aeroBack&&window.aeroBack());}catch(e){return false;}})()', true)
    .then((handled) => { if (!handled) historyBack(wc); })
    .catch(() => historyBack(wc));
}
function goForward(wc) {
  const h = wc.navigationHistory;
  if (h && h.canGoForward()) h.goForward(); else if (!h && wc.canGoForward && wc.canGoForward()) wc.goForward();
}
function zoom(wc, step) {
  if (step === 0) { wc.setZoomLevel(0); return; }
  const z = Math.max(-3, Math.min(4, wc.getZoomLevel() + step * 0.5));
  wc.setZoomLevel(z);
}

function onKey(wc, e, input) {
  if (input.type !== 'keyDown') return;
  const mod = IS_MAC ? input.meta : input.control;
  const k = String(input.key || '');
  const win = BrowserWindow.fromWebContents(wc);
  const act = (fn) => { e.preventDefault(); fn(); };

  if (k === 'F5' || (mod && k.toLowerCase() === 'r')) {
    return act(() => (input.shift || (mod && k === 'F5') ? wc.reloadIgnoringCache() : wc.reload()));
  }
  if (k === 'F11' && !IS_MAC && win) return act(() => win.setFullScreen(!win.isFullScreen()));
  if (mod && (k === '=' || k === '+' || k === 'Add')) return act(() => zoom(wc, 1));
  if (mod && (k === '-' || k === '_' || k === 'Subtract')) return act(() => zoom(wc, -1));
  if (mod && k === '0') return act(() => zoom(wc, 0));
  if ((input.alt && !IS_MAC && k === 'ArrowLeft') || (IS_MAC && input.meta && k === '[')) return act(() => goBack(wc));
  if ((input.alt && !IS_MAC && k === 'ArrowRight') || (IS_MAC && input.meta && k === ']')) return act(() => goForward(wc));
  if (mod && k.toLowerCase() === 'w' && win && !appWindows.has(win)) return act(() => win.close());
  if (!app.isPackaged && mod && input.shift && k.toLowerCase() === 'i') return act(() => wc.toggleDevTools());
}

function contextMenu(wc, p) {
  const items = [];
  if (p.misspelledWord && Array.isArray(p.dictionarySuggestions) && p.dictionarySuggestions.length) {
    p.dictionarySuggestions.slice(0, 5).forEach((s) => items.push({ label: s, click: () => wc.replaceMisspelling(s) }));
    items.push({ type: 'separator' });
  }
  if (p.isEditable) {
    const f = p.editFlags || {};
    items.push(
      { label: 'Undo', role: 'undo', enabled: f.canUndo !== false },
      { label: 'Redo', role: 'redo', enabled: f.canRedo !== false },
      { type: 'separator' },
      { label: 'Cut', role: 'cut', enabled: !!f.canCut },
      { label: 'Copy', role: 'copy', enabled: !!f.canCopy },
      { label: 'Paste', role: 'paste', enabled: !!f.canPaste },
      { type: 'separator' },
      { label: 'Select all', role: 'selectAll' }
    );
  }
  if (!items.length) return;
  Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(wc) || undefined });
}

function buildMacMenu() {
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]);
}

/* ---------------------------------------------------------------- downloads */
function cleanName(name) {
  let n = String(name || 'download').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').trim();
  if (!n) n = 'download';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = '_' + n;
  return n.slice(0, 150);
}
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p) && i < 1000; i++) p = path.join(dir, `${stem} (${i})${ext}`);
  return p;
}

function onWillDownload(_event, item, wc) {
  const dir = path.join(app.getPath('downloads'), 'AeroGyan');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const target = uniquePath(dir, cleanName(item.getFilename()));
  item.setSavePath(target);
  log('download', item.getURL().slice(0, 120), '→', target);

  /* the progress shows on the taskbar button of the app window it came from */
  let bar = null;
  try { const w = wc && BrowserWindow.fromWebContents(wc); bar = w ? (w.getParentWindow() || w) : null; } catch (_) {}
  if (!bar || !appWindows.has(bar)) bar = mainWin;
  item.on('updated', (_e, state) => {
    if (!bar || bar.isDestroyed()) return;
    const total = item.getTotalBytes();
    if (state === 'progressing' && total > 0) bar.setProgressBar(item.getReceivedBytes() / total);
  });
  item.once('done', (_e, state) => {
    if (bar && !bar.isDestroyed()) bar.setProgressBar(-1);
    hooks.downloads.push({ path: target, state });
    const name = path.basename(target);
    if (state === 'completed') {
      toastInPage(wc, `Saved to Downloads › AeroGyan › ${name}`, 'success');
      notify('Saved to Downloads › AeroGyan', name, () => shell.showItemInFolder(target));
    } else if (state !== 'cancelled') {
      toastInPage(wc, 'Download failed — please try again.', 'error');
    }
  });
}

function toastInPage(wc, msg, type) {
  try {
    if (!wc || wc.isDestroyed() || !isOwnHost(hostOf(wc.getURL()))) return;
    wc.executeJavaScript(`window.showToast && window.showToast(${JSON.stringify(msg)}, ${JSON.stringify(type)})`).catch(() => {});
  } catch (_) {}
}

function notify(title, body, onClick) {
  try {
    if (SELFTEST_DIR || !Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: ICON, silent: true });
    if (onClick) n.on('click', onClick);
    n.show();
  } catch (_) {}
}

/* ---------------------------------------------------------------- deep links */
/* aerogyan://open/courses → https://aerogyan.tech/courses
   aerogyan://app#/notes   → https://aerogyan.tech/app#/notes */
function deepLinkToUrl(link) {
  const p = parse(link);
  if (!p || p.protocol !== PROTOCOL + ':') return null;
  const host = (p.hostname || '').toLowerCase();
  let pathname = p.pathname || '/';
  if (host && host !== 'open') pathname = '/' + host + (pathname === '/' ? '' : pathname);
  const out = parse('https://aerogyan.tech' + (pathname.startsWith('/') ? pathname : '/' + pathname) + p.search + p.hash);
  return out && isOwnHost(out.hostname) ? out.toString() : null;
}
function openDeepLink(link) {
  const url = deepLinkToUrl(link);
  if (url && mainWin && !mainWin.isDestroyed()) mainWin.webContents.loadURL(url).catch(() => {});
}

/* ---------------------------------------------------------------- updates */
/* how this copy updates: 'self' = electron-updater (Windows installer, Linux AppImage), 'mac' / 'deb' = it asks
   aerogyan.tech for a newer version and offers the download, '' = never (not packaged, the self-test, a bare
   Linux folder) */
function updateKind() {
  if (!app.isPackaged || SELFTEST_DIR) return '';
  if (process.platform === 'win32') return 'self';
  if (IS_MAC) return OFFICE ? '' : 'mac';                    // an unsigned Mac app cannot replace itself
  if (process.env.APPIMAGE) return 'self';                   // the AppImage swaps its own file
  let type = '';
  try { type = fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim(); } catch (_) {}
  return type === 'deb' && !OFFICE ? 'deb' : '';             // a .deb update needs the admin password: offer it
}

function setupAutoUpdate() {
  const kind = updateKind();
  if (kind === 'mac' || kind === 'deb') return setupUpdateNotice(kind);
  if (kind !== 'self') return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { log('updater missing', e); return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m) => log('[update]', m), warn: (m) => log('[update]', m), error: (m) => log('[update]', m), debug: () => {} };

  let asked = null;
  autoUpdater.on('error', (e) => log('[update] error', e && e.message));
  autoUpdater.on('update-downloaded', async (info) => {
    if (!info || asked === info.version || !mainWin || mainWin.isDestroyed()) return;
    asked = info.version;
    const r = await dialog.showMessageBox(mainWin, {
      type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      title: 'Update ready',
      message: `${APP_NAME} ${info.version} is ready to install`,
      detail: `Restart ${APP_NAME} to finish the update. If you choose Later, it installs the next time you close the app.`
    });
    if (r.response === 0) setImmediate(() => autoUpdater.quitAndInstall(true, true));
  });

  const check = () => { autoUpdater.checkForUpdates().catch((e) => log('[update] check failed', e && e.message)); };
  setTimeout(check, 20 * 1000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

/* "1.0.10" > "1.0.9" */
function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/* macOS and the Linux .deb: every 6 hours ask /api/app-release (a pack: ?pack=<id>) for this system's newest
   version; when it is newer, offer to download it (once per version every 3 days). The download opens in the
   browser; sign-in and settings stay, they live in the user's data folder. */
function setupUpdateNotice(plat) {
  const api = 'https://aerogyan.tech/api/app-release' + (PACK ? '?pack=' + encodeURIComponent(PACK.id) : '');
  const noteFile = path.join(app.getPath('userData'), 'update-notice.json');
  let busy = false;
  const check = async () => {
    if (busy) return;
    busy = true;
    try {
      const res = await net.fetch(api, { headers: { Accept: 'application/json' } });
      if (!res.ok) { log('[update] notice: HTTP', res.status); return; }
      const rel = ((await res.json()) || {})[plat];
      if (!rel || !rel.available || cmpVersion(rel.version, app.getVersion()) <= 0) return;
      const version = String(rel.version).replace(/[^0-9A-Za-z.-]/g, '').slice(0, 20);
      let seen = {};
      try { seen = JSON.parse(fs.readFileSync(noteFile, 'utf8')) || {}; } catch (_) {}
      if (seen.version === version && Date.now() - Number(seen.at || 0) < 3 * 24 * 3600 * 1000) return;
      const url = parse(new URL(String(rel.url || ''), 'https://aerogyan.tech/').toString());
      if (!url || url.protocol !== 'https:' || !isOwnHost(url.hostname)) return;
      const win = mainWin && !mainWin.isDestroyed() ? mainWin : null;
      if (!win) return;                                   // no window (Mac, all closed): ask on the next check
      try { fs.writeFileSync(noteFile, JSON.stringify({ version, at: Date.now() })); } catch (_) {}
      log('[update] offering', version, url.toString());
      const how = plat === 'mac'
        ? `Download it, quit ${APP_NAME} (⌘Q), open the downloaded file and drag ${APP_NAME} to Applications — choose Replace.`
        : 'Download it and open the .deb file to install it over this version (or run: sudo apt install ./<file>.deb).';
      const r = await dialog.showMessageBox(win, {
        type: 'info', buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1,
        title: 'Update available',
        message: `${APP_NAME} ${version} is available (you have ${app.getVersion()})`,
        detail: how + ' You stay signed in.'
      });
      if (r.response === 0) openExternal(url.toString());
    } catch (e) {
      log('[update] notice failed', e && e.message);
    } finally {
      busy = false;
    }
  };
  setTimeout(check, 30 * 1000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

/* Linux AppImage: one file nobody "installs", so on start the app puts its own launcher in the applications menu
   (~/.local/share/applications/tech.aerogyan.app.desktop) and makes it the handler of aerogyan:// links. The
   launcher points at wherever the AppImage is now — it moves when it updates itself (AeroGyan-1.0.9.AppImage),
   so it is rewritten whenever that changes. The .deb has its own launcher (from the package). */
function integrateAppImage() {
  const img = process.env.APPIMAGE || '';
  /* (a path with " ` $ \ would need two layers of desktop-entry escaping — such a folder is left alone) */
  if (!IS_LINUX || !img || !path.isAbsolute(img) || /["`$\\\n\r]/.test(img)) return;
  try {
    const dataHome = process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME)
      ? process.env.XDG_DATA_HOME : path.join(app.getPath('home'), '.local', 'share');
    const appsDir = path.join(dataHome, 'applications');
    const iconDir = path.join(dataHome, 'icons', 'hicolor', '256x256', 'apps');
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(iconDir, { recursive: true });
    const icon = path.join(iconDir, 'tech.aerogyan.app.png');
    const iconData = fs.readFileSync(ICON);
    let oldIcon = null;
    try { oldIcon = fs.readFileSync(icon); } catch (_) {}
    if (!oldIcon || !oldIcon.equals(iconData)) fs.writeFileSync(icon, iconData);
    /* Exec: the path in double quotes, % doubled (desktop entry spec) */
    const exec = '"' + img.replace(/%/g, '%%') + '" %U';
    const entry = ['[Desktop Entry]', 'Type=Application', 'Name=AeroGyan', 'GenericName=Learning app',
      'Comment=AeroGyan Education — courses, notes, tests and live classes', `Exec=${exec}`, 'Icon=tech.aerogyan.app',
      'Terminal=false', 'Categories=Education;', `MimeType=x-scheme-handler/${PROTOCOL};`, 'StartupWMClass=AeroGyan',
      'X-AppImage-Version=' + app.getVersion()].join('\n') + '\n';
    const file = path.join(appsDir, 'tech.aerogyan.app.desktop');
    let old = '';
    try { old = fs.readFileSync(file, 'utf8'); } catch (_) {}
    if (old === entry) return;
    fs.writeFileSync(file, entry, { mode: 0o644 });
    log('appimage launcher written', file, '→', img);
    const quiet = () => {};
    execFile('xdg-mime', ['default', 'tech.aerogyan.app.desktop', `x-scheme-handler/${PROTOCOL}`], { timeout: 10000 }, quiet);
    execFile('update-desktop-database', [appsDir], { timeout: 10000 }, quiet);
    execFile('gtk-update-icon-cache', ['-q', '-t', '-f', path.join(dataHome, 'icons', 'hicolor')], { timeout: 10000 }, quiet);
  } catch (e) { log('appimage launcher failed', e); }
}
