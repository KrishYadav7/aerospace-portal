#!/usr/bin/env node
/* ============================================================
   CI only: the store's own install code (src/lib/platform.js) installs the store that was just built,
   finds it again the way the store finds every app, and uninstalls it.
     node test/ci-install-check.js <windows|mac|linux|deb> <file> <version>
   windows  silent NSIS install → HKCU Uninstall\<electron-builder GUID of tech.aerogyan.store> → DisplayVersion
   mac      dmg → /Applications/AeroGyan Store.app → Info.plist id + version
   linux    AppImage → ~/Applications + .desktop launcher
   deb      sudo apt-get install → dpkg-query version
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const platform = require('../src/lib/platform');
const core = require('../src/lib/core');

const [plat, file, version] = process.argv.slice(2);
const app = {
  id: 'store', name: 'AeroGyan Store', line: 'Install and update every AeroGyan app',
  platforms: {
    windows: { available: true, appId: 'tech.aerogyan.store', productName: 'AeroGyan Store', silentArgs: ['/S'] },
    mac: { available: true, appId: 'tech.aerogyan.store', productName: 'AeroGyan Store', appName: 'AeroGyan Store.app' },
    linux: { available: true, productName: 'AeroGyan Store', version },
    deb: { available: true, productName: 'AeroGyan Store', debPackage: 'aerogyan-store', version }
  }
};
const ctx = { os: core.osKey(), state: { appimages: {} }, hasDpkg: plat === 'deb' };
let bad = 0;
const check = (ok, what, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ' — ' + detail : ''}`); if (!ok) bad++; };

(async () => {
  if (plat === 'linux') delete app.platforms.deb;
  if (plat === 'deb') delete app.platforms.linux;
  const before = await platform.detect(app, ctx);
  check(!before.installed, 'not installed before', JSON.stringify(before));
  if (plat === 'windows') check(core.nsisGuid('tech.aerogyan.store') === 'f84d7956-a3c0-5cb0-9ce1-b1531fd7e91e', 'GUID rule');
  const res = await platform.install(app, plat, path.resolve(file), { sudo: true });
  check(res.ok && res.message !== 'manual', 'installed by the store code', JSON.stringify(res));
  if (plat === 'linux') ctx.state.appimages.store = { version, path: res.path, desktop: res.desktop };
  const inst = await platform.detect(app, ctx);
  check(inst.installed && inst.version === version, `found again with version ${version}`, JSON.stringify(inst));
  if (plat === 'windows') {
    check(/\\f84d7956-a3c0-5cb0-9ce1-b1531fd7e91e$/i.test(inst.key || ''), 'by its GUID key', inst.key);
    check(!!inst.exe && fs.existsSync(inst.exe), 'program found', inst.exe);
    check(/\/S$/.test(inst.quietUninstall || ''), 'quiet uninstall known', inst.quietUninstall);
  }
  if (plat === 'linux') {
    const d = fs.readFileSync(inst.desktop, 'utf8');
    check(/Exec=".*AeroGyan Store\.AppImage" %U/.test(d) && (fs.statSync(inst.path).mode & 0o111) !== 0, 'launcher + executable AppImage', inst.desktop);
  }
  if (plat === 'mac') check(fs.existsSync(path.join(inst.path, 'Contents', 'MacOS', 'AeroGyan Store')), 'app in place', inst.path);
  await platform.uninstall(app, inst, { sudo: true });
  if (plat === 'linux') delete ctx.state.appimages.store;
  if (plat === 'windows') await new Promise((r) => setTimeout(r, 8000));     // the uninstaller copies itself and finishes in the background
  const after = await platform.detect(app, ctx);
  check(!after.installed, 'uninstalled clean', JSON.stringify(after));
  console.log(bad ? `INSTALL CHECK FAILED (${bad})` : 'INSTALL CHECK OK');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
