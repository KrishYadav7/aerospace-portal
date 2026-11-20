/* ============================================================
   AeroGyan Store (एरोज्ञान स्टोर) — desktop app for Windows, macOS and Linux (tech.aerogyan.store).
   Lists ONLY our own apps (GET https://aerogyan.tech/api/store?for=desktop), installs and updates them:
   download (resumable, pinned hosts) → SHA-256 check against the catalogue → install for this system
   (lib/platform.js). The window is a sandboxed page (src/renderer/) that knows app ids only: every URL,
   hash and command stays here in the main process.

   Flags (for tests):  --catalog=<url> (or AEROGYAN_STORE_URL)   --aero-selftest=<folder>
   AEROGYAN_STORE_TEST_HOSTS=127.0.0.1 lets an UNPACKED run talk to a local test server over http;
   a packaged store ignores it, so the host pin always holds for people.
   ============================================================ */
'use strict';
const { app, BrowserWindow, ipcMain, shell, Notification, dialog, nativeTheme, Menu } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const core = require('./lib/core');
const { download } = require('./lib/download');
const platform = require('./lib/platform');

const argOf = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const SELFTEST_DIR = argOf('aero-selftest');
const CATALOG_URL = argOf('catalog') || process.env.AEROGYAN_STORE_URL || 'https://aerogyan.tech/api/store?for=desktop';
const TEST_HOSTS = !app.isPackaged ? String(process.env.AEROGYAN_STORE_TEST_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean) : [];
const OS = core.osKey();
const DAY = 24 * 3600 * 1000;

app.setAppUserModelId('tech.aerogyan.store');
if (SELFTEST_DIR) app.setPath('userData', path.join(path.resolve(SELFTEST_DIR), 'userdata'));

/* ---------------------------------------------------------------- state (userData/state.json) */
const statePath = () => path.join(app.getPath('userData'), 'state.json');
let state = { lang: '', role: '', autoUpdate: false, linuxFormat: {}, appimages: {}, lastCheck: 0, notified: '' };
function loadState() { try { state = Object.assign(state, JSON.parse(fs.readFileSync(statePath(), 'utf8'))); } catch (_) {} }
function saveState() { try { fs.mkdirSync(path.dirname(statePath()), { recursive: true }); fs.writeFileSync(statePath(), JSON.stringify(state, null, 1)); } catch (_) {} }
const log = (...a) => { if (!app.isPackaged || SELFTEST_DIR) console.log('[store]', ...a); };

/* ---------------------------------------------------------------- the catalogue */
let catalog = null;          // {hosts, apps, generatedAt}
let catalogFrom = '';        // 'network' | 'cache'
let hasDpkg = false;
const check = (u) => core.checkUrl(u, { catalogHosts: catalog ? catalog.hosts : [], testHosts: TEST_HOSTS });

function getJSON(url, max = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const why = core.checkUrl(url, { testHosts: TEST_HOSTS });
    if (why) return reject(new Error(`catalogue address refused: ${why}`));
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { Accept: 'application/json', 'User-Agent': `AeroGyanStore-Desktop/${app.getVersion()} (${OS})`, 'Cache-Control': 'no-cache' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`catalogue answered ${res.statusCode}`)); }
      let n = 0; const parts = [];
      res.on('data', (b) => { n += b.length; if (n > max) req.destroy(new Error('catalogue too large')); else parts.push(b); });
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (e) { reject(new Error('catalogue is not JSON')); } });
      res.on('error', reject);
    });
    req.setTimeout(20000, () => req.destroy(new Error('the store server did not answer')));
    req.on('error', reject);
  });
}
const cachePath = () => path.join(app.getPath('userData'), 'catalog.json');
async function loadCatalog(refresh) {
  if (catalog && !refresh) return { catalog, from: catalogFrom };
  try {
    const c = core.cleanCatalog(await getJSON(CATALOG_URL));
    catalog = c; catalogFrom = 'network';
    try { fs.writeFileSync(cachePath(), JSON.stringify(c)); } catch (_) {}
    return { catalog, from: 'network' };
  } catch (e) {
    log('catalogue:', e.message);
    if (!catalog) { try { catalog = core.cleanCatalog(Object.assign({ success: true }, JSON.parse(fs.readFileSync(cachePath(), 'utf8')))); catalogFrom = 'cache'; } catch (_) {} }
    if (catalog) return { catalog, from: 'cache', error: e.message };
    throw e;
  }
}
const appById = (id) => (catalog ? catalog.apps.find((a) => a.id === id) : null);
const targetOf = (a) => core.target(a, OS, { hasDpkg, prefer: state.linuxFormat[a.id] });

/* ---------------------------------------------------------------- what is installed */
let installed = {};
async function detectAll() {
  if (!catalog) return {};
  const out = {};
  for (const a of catalog.apps) {
    try { out[a.id] = await platform.detect(a, { os: OS, state, hasDpkg }); } catch (e) { out[a.id] = { installed: false, error: e.message }; }
  }
  // the store itself: this program
  out.store = { installed: true, version: app.getVersion(), how: 'self' };
  installed = out;
  return out;
}
function updatesOf() {
  if (!catalog) return [];
  return catalog.apps.filter((a) => {
    const i = installed[a.id]; const t = targetOf(a);
    return i && i.installed && t && t.file.available && core.cmpVer(t.file.version, i.version) > 0;
  }).map((a) => a.id);
}

/* ---------------------------------------------------------------- jobs (one per app) */
const jobs = new Map();         // id → {ctl, phase}
let win = null;
const send = (ch, v) => { if (win && !win.isDestroyed()) win.webContents.send(ch, v); };
const progress = (id, p) => send('store:progress', Object.assign({ id }, p));
const dlDir = () => path.join(app.getPath('userData'), 'downloads');

function fileNameFor(a, plat, f) {
  const ext = { windows: '.exe', mac: '.dmg', linux: '.AppImage', deb: '.deb' }[plat];
  const n = String(f.fileName || '').replace(/[^A-Za-z0-9._-]/g, '');
  return n && n.endsWith(ext) ? n : `${a.id}-${String(f.version || '0').replace(/[^0-9A-Za-z.-]/g, '')}${ext}`;
}

/* small https file (an icon) from a pinned host */
function fetchSmall(url, dest) {
  return new Promise((resolve) => {
    if (check(url)) return resolve(false);
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(false); }
      const parts = []; let n = 0;
      res.on('data', (b) => { n += b.length; if (n > 2 * 1024 * 1024) req.destroy(); else parts.push(b); });
      res.on('end', () => { try { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, Buffer.concat(parts)); resolve(true); } catch (_) { resolve(false); } });
    });
    req.setTimeout(15000, () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

/* fetchVerified: download + SHA-256 check (shared by install and the self-test) */
async function fetchVerified(a, plat, f, ctl, onProgress, onPhase) {
  const dest = path.join(dlDir(), fileNameFor(a, plat, f));
  return download({ url: f.url, dest, sha256: f.sha256, size: f.size, check, signal: ctl && ctl.signal, onProgress, onPhase, log });
}

async function macRunning(appPath) {
  const r = await platform.run('pgrep', ['-f', path.join(appPath, 'Contents', 'MacOS') + '/']);
  return r.code === 0 && r.stdout.trim() !== '';
}

async function installApp(id, opts = {}) {
  const a = appById(id);
  if (!a) throw new Error('Unknown app.');
  if (jobs.has(id)) throw new Error('Already working on it.');
  const t = targetOf(a);
  if (!t || !t.file.available || !t.file.url) throw Object.assign(new Error('There is no installer of this app for this computer yet.'), { code: 'NONE' });
  const ctl = new AbortController();
  jobs.set(id, { ctl, phase: 'download' });
  try {
    progress(id, { phase: 'download', received: 0, total: t.file.size || 0 });
    const fp = await fetchVerified(a, t.plat, t.file, ctl,
      (p) => progress(id, Object.assign({ phase: 'download' }, p)), (ph) => progress(id, { phase: ph }));
    if (ctl.signal.aborted) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
    jobs.get(id).phase = 'install';
    progress(id, { phase: 'install' });
    if (id === 'store') return await selfUpdate(t.plat, fp);
    if (t.plat === 'mac') {
      const cur = installed[id];
      if (cur && cur.installed && cur.path && (await macRunning(cur.path)) && !opts.auto) {
        const r = await dialog.showMessageBox(win, { type: 'question', buttons: [L('Quit and update', 'बंद करके अपडेट करें'), L('Cancel', 'रद्द करें')], defaultId: 0, cancelId: 1,
          message: L(`${a.name} is open.`, `${a.nameHi || a.name} खुला है।`), detail: L('It will be closed to finish the update.', 'अपडेट पूरा करने के लिए इसे बंद किया जाएगा।') });
        if (r.response !== 0) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
        await platform.run('osascript', ['-e', `quit app id "${String(t.file.appId || '').replace(/[^A-Za-z0-9.-]/g, '')}"`]);
      } else if (cur && cur.installed && cur.path && opts.auto && (await macRunning(cur.path))) {
        throw Object.assign(new Error('open — updated later'), { code: 'BUSY' });
      }
    }
    let iconFile = '';
    if (t.plat === 'linux' && a.icon) { iconFile = path.join(app.getPath('userData'), 'icons', a.id + '.png'); if (!(await fetchSmall(a.icon, iconFile))) iconFile = ''; }
    const res = await platform.install(a, t.plat, fp, { shell, iconFile });
    if (t.plat === 'linux') { state.appimages[a.id] = { version: t.file.version, path: res.path, desktop: res.desktop }; saveState(); }
    if (res.message !== 'manual') { try { fs.rmSync(fp, { force: true }); } catch (_) {} }
    await detectAll();
    return Object.assign({ ok: true, version: t.file.version }, res);
  } finally {
    jobs.delete(id);
    progress(id, { phase: 'done' });
  }
}

/* ---------------------------------------------------------------- self-update (entry "store") */
async function selfUpdate(plat, fp) {
  if (plat === 'windows') {
    spawn(fp, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 500);
    return { ok: true, restarting: true };
  }
  if (plat === 'mac') {
    const appPath = path.resolve(process.execPath, '..', '..', '..');            // …/AeroGyan Store.app
    if (!appPath.endsWith('.app')) throw new Error('Run the store from Applications to update it.');
    const stage = path.join(app.getPath('userData'), 'update');
    fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });
    const mnt = await platform.attachDmg(fp);
    try {
      const src = platform.findApp(mnt, 'AeroGyan Store.app');
      const r = await platform.run('ditto', [src, path.join(stage, 'AeroGyan Store.app')]);
      if (r.code !== 0) throw new Error('Could not unpack the update.');
    } finally { await platform.detachDmg(mnt); }
    const sh = path.join(stage, 'swap.sh');
    fs.writeFileSync(sh, `#!/bin/sh\nwhile kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done\n` +
      `rm -rf "${appPath}.old" && mv "${appPath}" "${appPath}.old" && ditto "${stage}/AeroGyan Store.app" "${appPath}" && rm -rf "${appPath}.old" || { rm -rf "${appPath}"; mv "${appPath}.old" "${appPath}"; }\n` +
      `xattr -dr com.apple.quarantine "${appPath}" 2>/dev/null; open "${appPath}"\n`, { mode: 0o755 });
    spawn('/bin/sh', [sh], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 300);
    return { ok: true, restarting: true };
  }
  if (plat === 'linux') {
    const self = process.env.APPIMAGE;
    if (!self) throw new Error('This store was not started from its AppImage — download the new one from aerogyan.tech.');
    fs.copyFileSync(fp, self + '.new'); fs.chmodSync(self + '.new', 0o755); fs.renameSync(self + '.new', self);
    spawn(self, [], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 300);
    return { ok: true, restarting: true };
  }
  const a = appById('store');
  await platform.install(a, 'deb', fp, { shell });
  app.relaunch(); setTimeout(() => app.quit(), 300);
  return { ok: true, restarting: true };
}

/* ---------------------------------------------------------------- daily update check */
const L = (en, hi) => (state.lang === 'hi' ? hi : en);
async function updateCheck(fromTimer) {
  try {
    await loadCatalog(true); await detectAll();
    state.lastCheck = Date.now(); saveState();
    const ups = updatesOf();
    send('store:catalog', { reason: 'check' });
    if (ups.length && state.autoUpdate) {
      for (const id of ups.filter((x) => x !== 'store')) {
        const t = targetOf(appById(id));
        if (t && t.plat === 'deb') continue;                   // needs the password: never in the background
        try { await installApp(id, { auto: true }); } catch (e) { log('auto-update', id, e.message); }
      }
    }
    const left = updatesOf();
    const key = left.join(',');
    if (fromTimer && left.length && key !== state.notified && Notification.isSupported()) {
      state.notified = key; saveState();
      const n = new Notification({ title: L('AeroGyan Store', 'एरोज्ञान स्टोर'),
        body: L(`${left.length} update${left.length === 1 ? '' : 's'} available`, `${left.length} अपडेट उपलब्ध`) });
      n.on('click', () => { if (win) { win.show(); win.focus(); send('store:tab', 'updates'); } });
      n.show();
    }
  } catch (e) { log('update check:', e.message); }
}

/* ---------------------------------------------------------------- IPC (ids only from the page) */
const ok = (fn) => async (_e, ...a) => { try { return { ok: true, value: await fn(...a) }; } catch (e) { return { ok: false, code: e.code || '', message: e.message }; } };
const idOk = (id) => typeof id === 'string' && /^[a-z0-9-]{1,60}$/.test(id);
ipcMain.handle('store:state', ok(() => ({ lang: state.lang, role: state.role, autoUpdate: state.autoUpdate, os: OS, arch: process.arch,
  version: app.getVersion(), hasDpkg, linuxFormat: state.linuxFormat, dark: nativeTheme.shouldUseDarkColors, test: TEST_HOSTS.length > 0 })));
ipcMain.handle('store:pref', ok((k, v) => {
  if (k === 'lang' && ['en', 'hi'].includes(v)) state.lang = v;
  else if (k === 'role' && ['student', 'professor', 'everyone'].includes(v)) state.role = v;
  else if (k === 'autoUpdate') state.autoUpdate = !!v;
  else if (k === 'linuxFormat' && v && idOk(v.id) && ['deb', 'linux'].includes(v.format)) state.linuxFormat[v.id] = v.format;
  else throw new Error('bad setting');
  saveState(); return true;
}));
ipcMain.handle('store:catalog', ok(async (refresh) => {
  const r = await loadCatalog(!!refresh);
  await detectAll();
  return { apps: r.catalog.apps, from: r.from, error: r.error || '', generatedAt: r.catalog.generatedAt, installed, updates: updatesOf(),
    busy: [...jobs.keys()], targets: Object.fromEntries(r.catalog.apps.map((a) => {
      const t = targetOf(a); return [a.id, { status: core.status(a, OS, { hasDpkg, prefer: state.linuxFormat[a.id] }), plat: t ? t.plat : '' }];
    })) };
}));
ipcMain.handle('store:install', ok((id) => { if (!idOk(id)) throw new Error('bad id'); return installApp(id); }));
ipcMain.handle('store:cancel', ok((id) => { const j = jobs.get(id); if (j && j.phase === 'download') j.ctl.abort(); return !!j; }));
ipcMain.handle('store:open', ok(async (id) => { const a = appById(id); if (!a) throw new Error('Unknown app.'); return platform.open(a, installed[id] || {}, { shell }); }));
ipcMain.handle('store:uninstall', ok(async (id) => {
  const a = appById(id); const inst = installed[id];
  if (!a || !inst || !inst.installed || id === 'store') throw new Error('Not installed.');
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: [L('Uninstall', 'अनइंस्टॉल करें'), L('Cancel', 'रद्द करें')], defaultId: 1, cancelId: 1,
    message: L(`Uninstall ${a.name}?`, `${a.nameHi || a.name} अनइंस्टॉल करें?`), detail: L('Your account and files on aerogyan.tech stay.', 'aerogyan.tech पर आपका अकाउंट और फ़ाइलें बनी रहेंगी।') });
  if (r.response !== 0) return false;
  await platform.uninstall(a, inst, { shell });
  if (inst.how === 'appimage') { delete state.appimages[id]; saveState(); }
  await detectAll();
  return true;
}));
ipcMain.handle('store:web', ok((id, which) => {
  const a = appById(id); if (!a) throw new Error('Unknown app.');
  const t = targetOf(a);
  const url = which === 'download' && t && t.file.url ? t.file.url : a.web;
  if (!url || core.checkUrl(url, { testHosts: TEST_HOSTS })) throw new Error('No page to open.');
  return shell.openExternal(url);
}));
ipcMain.handle('store:check', ok(() => updateCheck(false)));

/* ---------------------------------------------------------------- window */
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 720, minHeight: 520, show: !SELFTEST_DIR || !!process.env.AEROGYAN_STORE_SHOW,
    title: 'AeroGyan Store', backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1020' : '#f6f7fb',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, devTools: !app.isPackaged }
  });
  win.removeMenu();
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { if (!core.checkUrl(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.once('ready-to-show', () => { if (!SELFTEST_DIR) win.show(); });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  nativeTheme.on('updated', () => send('store:theme', nativeTheme.shouldUseDarkColors));
}

if (!SELFTEST_DIR && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
    loadState();
    if (!state.lang) state.lang = /^hi/i.test(app.getLocale()) ? 'hi' : 'en';
    hasDpkg = await platform.hasDpkg();
    createWindow();
    if (SELFTEST_DIR) {
      require('./selftest').run({ app, dir: path.resolve(SELFTEST_DIR), getWindow: () => win, loadCatalog, appById, targetOf, fetchVerified, check, log, catalogUrl: CATALOG_URL });
      return;
    }
    // on start and then daily (checked every 3 hours — a laptop is often asleep at the exact time)
    setTimeout(() => updateCheck(Date.now() - state.lastCheck > DAY), 20000);
    setInterval(() => { if (Date.now() - state.lastCheck > DAY) updateCheck(true); }, 3 * 3600 * 1000);
  });
  app.on('window-all-closed', () => app.quit());
}
