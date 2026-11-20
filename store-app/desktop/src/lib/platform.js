/* ============================================================
   AeroGyan Store (desktop) — what is installed, and install / open / uninstall, per system.
   Plain Node (child_process + fs); Electron's `shell` is passed in where it helps (open a file, Trash),
   so test/ci-install-check.js can run the same code on the CI machines.

   Windows  installed  HKCU + HKLM (+ WOW6432Node) …\Uninstall\<electron-builder GUID of the app id>, else
                       DisplayName == product name → DisplayVersion, (Quiet)UninstallString, the program
            install    the one-click NSIS installer with the catalogue's silentArgs (/S), waits for it;
                       failing that, the installer is opened normally
   Mac      installed  /Applications or ~/Applications/<product>.app (CFBundleIdentifier == app id preferred)
            install    hdiutil attach (read-only, no Finder window) → ditto the .app next to the old one →
                       swap → detach; /Applications when writable, else ~/Applications. Files the store
                       downloads with Node carry no quarantine flag, so Gatekeeper does not stop the
                       ad-hoc signed apps; we still clear it if present.
   Linux    installed  our AppImages (state file) and `dpkg-query` for .deb packages
            install    AppImage → ~/Applications/<product>.AppImage + chmod 755 + a .desktop launcher with
                       its icon; .deb → `pkexec apt-get install -y` (the system asks for the password),
                       else the system's package installer (xdg-open)
   ============================================================ */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const core = require('./core');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, Object.assign({ windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: opts.timeout || 0 }, opts), (e, stdout, stderr) => {
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: e });
    });
  });
}
const exists = (p) => { try { fs.accessSync(p); return true; } catch (_) { return false; } };
function err(code, message) { const e = new Error(message); e.code = code; return e; }
const home = () => os.homedir();
const safeName = (s) => String(s || 'app').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '').trim() || 'app';

/* ================================================================ Windows */
const UNINSTALL = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
let regCache = null;
async function winUninstallKeys(fresh) {
  if (regCache && !fresh && Date.now() - regCache.at < 5000) return regCache.keys;
  const roots = [`HKCU\\${UNINSTALL}`, `HKLM\\${UNINSTALL}`, `HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall`];
  const keys = {};
  for (const r of roots) {
    const res = await run('reg', ['query', r, '/s'], { timeout: 20000 });
    Object.assign(keys, core.parseReg(res.stdout));
  }
  regCache = { at: Date.now(), keys };
  return keys;
}
function winProgram(entry, productName) {
  const un = core.splitCommand(entry.UninstallString || entry.QuietUninstallString || '')[0] || '';
  const dir = entry.InstallLocation || (un ? path.dirname(un) : '');
  if (!dir || !exists(dir)) return '';
  const exes = fs.readdirSync(dir).filter((f) => /\.exe$/i.test(f) && !/^uninstall/i.test(f));
  const want = safeName(productName).toLowerCase() + '.exe';
  return path.join(dir, exes.find((f) => f.toLowerCase() === want) || exes[0] || '');
}

/* ================================================================ Mac */
async function macApp(file) {
  const name = (file && (file.appName || (file.productName && file.productName + '.app'))) || '';
  const dirs = ['/Applications', path.join(home(), 'Applications')];
  for (const d of dirs) {
    const p = path.join(d, name);
    if (!name || !exists(path.join(p, 'Contents', 'Info.plist'))) continue;
    const r = await run('plutil', ['-convert', 'json', '-o', '-', path.join(p, 'Contents', 'Info.plist')]);
    const info = core.parsePlist(r.stdout);
    if (info && (!file.appId || !info.id || info.id === file.appId)) return { path: p, version: info.version, id: info.id };
  }
  return null;
}

/* ================================================================ Linux */
function linuxPaths(app, file) {
  const product = safeName((file && file.productName) || app.name);
  return {
    appimage: path.join(home(), 'Applications', product + '.AppImage'),
    desktop: path.join(home(), '.local', 'share', 'applications', `tech.aerogyan.store.${app.id}.desktop`),
    icon: path.join(home(), '.local', 'share', 'icons', 'hicolor', '256x256', 'apps', `tech.aerogyan.store.${app.id}.png`)
  };
}
async function hasDpkg() { return process.platform === 'linux' && (await run('dpkg-query', ['--version'])).code === 0; }
async function debVersion(pkg) {
  if (!pkg || !/^[a-z0-9][a-z0-9+.-]+$/.test(pkg)) return '';
  const r = await run('dpkg-query', ['-W', '-f=${Status}\t${Version}', pkg]);
  return r.code === 0 ? core.parseDpkg(r.stdout) : '';
}

/* ================================================================ detect
   detect(app, ctx) → {installed, version, how, path?, uninstall?, quietUninstall?, exe?}
   ctx: {os, state (the store's state: appimages), hasDpkg} */
async function detect(app, ctx) {
  const P = app.platforms || {};
  const none = { installed: false };
  if (ctx.os === 'windows') {
    const f = P.windows;
    if (!f) return none;
    const e = core.findUninstall(await winUninstallKeys(), { appId: f.appId, productName: f.productName || app.name });
    if (!e) return none;
    return { installed: true, how: 'registry', version: e.DisplayVersion || '', key: e.key, uninstall: e.UninstallString || '',
      quietUninstall: e.QuietUninstallString || '', exe: winProgram(e, f.productName || app.name) };
  }
  if (ctx.os === 'mac') {
    const f = P.mac;
    if (!f) return none;
    const m = await macApp(f);
    return m ? { installed: true, how: 'app', version: m.version, path: m.path } : none;
  }
  // linux: a .deb first (system-wide), then our AppImage
  if (P.deb && P.deb.debPackage && ctx.hasDpkg) {
    const v = await debVersion(P.deb.debPackage);
    if (v) return { installed: true, how: 'deb', version: v, pkg: P.deb.debPackage };
  }
  const rec = ctx.state && ctx.state.appimages && ctx.state.appimages[app.id];
  const lp = linuxPaths(app, P.linux || P.deb);
  const fp = (rec && rec.path) || lp.appimage;
  if (exists(fp)) return { installed: true, how: 'appimage', version: (rec && rec.version) || '', path: fp, desktop: (rec && rec.desktop) || lp.desktop };
  return none;
}

/* ================================================================ install */
async function installWindows(file, fp, o) {
  const args = Array.isArray(file.silentArgs) && file.silentArgs.length ? file.silentArgs.map(String) : ['/S'];
  const r = await run(fp, args, { timeout: 15 * 60 * 1000 });
  regCache = null;
  if (r.code === 0) return { ok: true, silent: true };
  // not silent-friendly (or refused): open it normally — the person clicks through
  if (o.shell) await o.shell.openPath(fp);
  else spawn(fp, [], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, silent: false, message: 'manual' };
}

async function attachDmg(fp) {
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'agstore-'));
  const r = await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, fp], { timeout: 5 * 60 * 1000 });
  if (r.code !== 0) throw err('DMG', 'The disk image could not be opened: ' + (r.stderr || r.stdout).trim());
  return mnt;
}
async function detachDmg(mnt) {
  let r = await run('hdiutil', ['detach', mnt, '-quiet']);
  if (r.code !== 0) r = await run('hdiutil', ['detach', mnt, '-force', '-quiet']);
  try { fs.rmdirSync(mnt); } catch (_) {}
}
function findApp(mnt, appName) {
  if (appName && exists(path.join(mnt, appName))) return path.join(mnt, appName);
  const a = fs.readdirSync(mnt).find((f) => f.endsWith('.app'));
  return a ? path.join(mnt, a) : '';
}
function writable(dir) { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch (_) { return false; } }

/* copy the .app out of a mounted dmg to dest (an .../Name.app path), swapping atomically */
async function placeApp(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.agstore-new';
  const old = dest + '.agstore-old';
  await run('rm', ['-rf', tmp, old]);
  const c = await run('ditto', [src, tmp], { timeout: 10 * 60 * 1000 });
  if (c.code !== 0) { await run('rm', ['-rf', tmp]); throw err('COPY', (c.stderr || 'copy failed').trim()); }
  if (exists(dest)) fs.renameSync(dest, old);
  fs.renameSync(tmp, dest);
  await run('rm', ['-rf', old]);
  await run('xattr', ['-dr', 'com.apple.quarantine', dest]);     // none expected (see the header) — harmless
}

async function installMac(file, fp, o) {
  const mnt = await attachDmg(fp);
  try {
    const src = findApp(mnt, file.appName);
    if (!src) throw err('DMG', 'No app inside the disk image.');
    const name = path.basename(src);
    const dir = o.macDir || (writable('/Applications') ? '/Applications' : path.join(home(), 'Applications'));
    const dest = path.join(dir, name);
    try {
      await placeApp(src, dest);
    } catch (e) {
      // copying failed: show the disk image so the person can drag the app to Applications
      if (o.shell) await o.shell.openPath(fp);
      throw err('MANUAL', `Could not copy ${name} (${e.message}). The disk image is open: drag ${name} onto Applications, then open it from there.`);
    }
    return { ok: true, path: dest };
  } finally {
    await detachDmg(mnt);
  }
}

function desktopEntry(app, file, exec, icon) {
  const q = (s) => '"' + String(s).replace(/(["`$\\])/g, '\\$1') + '"';
  const line = String(app.line || '').replace(/[\r\n]+/g, ' ');
  return ['[Desktop Entry]', 'Type=Application', `Name=${(file && file.productName) || app.name}`, `Comment=${line}`,
    `Exec=${q(exec)} %U`, `Icon=${icon}`, 'Terminal=false', 'Categories=Education;Office;', `StartupWMClass=${(file && file.productName) || app.name}`,
    `X-AeroGyan-Store-Id=${app.id}`, ''].join('\n');
}

async function installAppImage(app, file, fp, o) {
  const lp = linuxPaths(app, file);
  fs.mkdirSync(path.dirname(lp.appimage), { recursive: true });
  const tmp = lp.appimage + '.new';
  fs.copyFileSync(fp, tmp);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, lp.appimage);                                // replaces a running AppImage safely
  let icon = 'application-x-executable';
  if (o.iconFile && exists(o.iconFile)) {
    fs.mkdirSync(path.dirname(lp.icon), { recursive: true });
    fs.copyFileSync(o.iconFile, lp.icon);
    icon = lp.icon;
  }
  fs.mkdirSync(path.dirname(lp.desktop), { recursive: true });
  fs.writeFileSync(lp.desktop, desktopEntry(app, file, lp.appimage, icon), { mode: 0o644 });
  await run('update-desktop-database', [path.dirname(lp.desktop)]);
  return { ok: true, path: lp.appimage, desktop: lp.desktop, version: file.version };
}

async function installDeb(file, fp, o) {
  const abs = path.resolve(fp);
  if (o.sudo) {                                                   // CI: no password prompt
    const r = await run('sudo', ['apt-get', 'install', '-y', abs], { timeout: 15 * 60 * 1000 });
    if (r.code === 0) return { ok: true };
    throw err('DEB', (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' '));
  }
  const pk = await run('pkexec', ['apt-get', 'install', '-y', abs], { timeout: 30 * 60 * 1000 });
  if (pk.code === 0) return { ok: true };
  if (pk.code === 126 || pk.code === 127) throw err('CANCELLED', 'The password prompt was cancelled.');
  // no pkexec / apt failed: the system's package installer takes over
  if (o.shell) await o.shell.openPath(abs);
  else spawn('xdg-open', [abs], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, message: 'manual' };
}

/* install(app, plat, fp, o) — o: {shell, iconFile, macDir, sudo} */
async function install(app, plat, fp, o = {}) {
  const file = app.platforms[plat];
  if (plat === 'windows') return installWindows(file, fp, o);
  if (plat === 'mac') return installMac(file, fp, o);
  if (plat === 'linux') return installAppImage(app, file, fp, o);
  if (plat === 'deb') return installDeb(file, fp, o);
  throw err('PLATFORM', 'Nothing to install on this computer.');
}

/* ================================================================ open / uninstall */
function launchDetached(cmd, args) {
  const c = spawn(cmd, args || [], { detached: true, stdio: 'ignore' });
  c.on('error', () => {});
  c.unref();
}
async function open(app, inst, o = {}) {
  const P = app.platforms || {};
  if (process.platform === 'win32') {
    if (inst.exe && exists(inst.exe)) return launchDetached(inst.exe);
    throw err('OPEN', 'The program was not found — open it from the Start menu.');
  }
  if (process.platform === 'darwin') {
    if (P.mac && P.mac.appId && (await run('open', ['-b', P.mac.appId])).code === 0) return;
    if (inst.path) return launchDetached('open', [inst.path]);
    throw err('OPEN', 'The app was not found in Applications.');
  }
  if (inst.how === 'appimage' && inst.path) return launchDetached(inst.path);
  if (inst.how === 'deb') {
    const r = await run('dpkg', ['-L', inst.pkg]);
    const desk = r.stdout.split('\n').find((l) => /^\/usr\/share\/applications\/.*\.desktop$/.test(l));
    if (desk) {
      if ((await run('gtk-launch', [path.basename(desk, '.desktop')])).code === 0) return;
      const ex = /^Exec=(.*)$/m.exec(fs.readFileSync(desk, 'utf8'));
      if (ex) { const parts = core.splitCommand(ex[1].replace(/%[a-zA-Z]/g, '')); return launchDetached(parts[0], parts.slice(1)); }
    }
  }
  throw err('OPEN', 'Open it from your applications menu.');
}

async function uninstall(app, inst, o = {}) {
  if (process.platform === 'win32') {
    const cmd = core.splitCommand(inst.quietUninstall || inst.uninstall);
    if (!cmd.length) throw err('UNINSTALL', 'Uninstall it from Settings → Apps.');
    const r = await run(cmd[0], cmd.slice(1), { timeout: 10 * 60 * 1000 });
    regCache = null;
    if (r.code !== 0) throw err('UNINSTALL', 'The uninstaller did not finish — use Settings → Apps.');
    return { ok: true };
  }
  if (process.platform === 'darwin') {
    if (!inst.path) throw err('UNINSTALL', 'The app was not found.');
    if (o.shell && o.shell.trashItem) await o.shell.trashItem(inst.path);
    else await run('rm', ['-rf', inst.path]);
    return { ok: true };
  }
  if (inst.how === 'deb') {
    const r = await run(o.sudo ? 'sudo' : 'pkexec', ['apt-get', 'remove', '-y', inst.pkg], { timeout: 15 * 60 * 1000 });
    if (r.code !== 0) throw err('UNINSTALL', r.code === 126 ? 'The password prompt was cancelled.' : 'apt could not remove it.');
    return { ok: true };
  }
  for (const f of [inst.path, inst.desktop, linuxPaths(app, (app.platforms || {}).linux).icon]) if (f) fs.rmSync(f, { force: true });
  await run('update-desktop-database', [path.join(home(), '.local', 'share', 'applications')]);
  return { ok: true };
}

module.exports = { detect, install, open, uninstall, hasDpkg, linuxPaths, attachDmg, detachDmg, findApp, placeApp, winUninstallKeys, run, launchDetached };
