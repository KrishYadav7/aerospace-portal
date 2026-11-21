/* Unit tests of the desktop store's pure parts and the downloader:  node --test test/unit.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const core = require('../src/lib/core');
const { download } = require('../src/lib/download');

test('versions', () => {
  assert.equal(core.cmpVer('1.0.10', '1.0.9'), 1);
  assert.equal(core.cmpVer('1.0.9', '1.0.10'), -1);
  assert.equal(core.cmpVer('1.0.0', '1.0.0'), 0);
  assert.equal(core.cmpVer('1.0', '1.0.0'), 0);
  assert.equal(core.cmpVer('1.0.0', '1.0.0-rc.2'), 1);
  assert.equal(core.cmpVer('1.0.0-rc.10', '1.0.0-rc.2'), 1);
  assert.equal(core.cmpVer('v2.0.0', '1.9.9'), 1);
  assert.equal(core.cmpVer('', '1.0.0'), 0, 'unreadable → not newer');
});

test('electron-builder uninstall GUID', () => {
  // the same as builder-util-runtime UUID.v5(appId, 50e065bc-3134-11e6-9bab-38c9862bdaf3)
  assert.equal(core.nsisGuid('tech.aerogyan.store'), 'f84d7956-a3c0-5cb0-9ce1-b1531fd7e91e');
  assert.match(core.nsisGuid('tech.aerogyan.app'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(core.nsisGuid('tech.aerogyan.app'), core.nsisGuid('tech.aerogyan.office.sheets'));
});

const REG = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\f84d7956-a3c0-5cb0-9ce1-b1531fd7e91e',
  '    DisplayName    REG_SZ    AeroGyan Store',
  '    UninstallString    REG_SZ    "C:\\Users\\a\\AppData\\Local\\Programs\\aerogyan-store\\Uninstall AeroGyan Store.exe" /currentuser',
  '    QuietUninstallString    REG_SZ    "C:\\Users\\a\\AppData\\Local\\Programs\\aerogyan-store\\Uninstall AeroGyan Store.exe" /currentuser /S',
  '    DisplayVersion    REG_SZ    1.0.0',
  '    EstimatedSize    REG_DWORD    0x3a2f0',
  '    NoModify    REG_DWORD    0x1',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{0123-old}',
  '    DisplayName    REG_SZ    Jivan Medico 1.0.0',
  '    DisplayVersion    REG_SZ    1.0.0',
  '    Publisher    REG_SZ',
  ''
].join('\r\n');

test('registry parsing and matching', () => {
  const keys = core.parseReg(REG);
  assert.equal(Object.keys(keys).length, 2);
  const e = core.findUninstall(keys, { appId: 'tech.aerogyan.store', productName: 'Something else' });
  assert.equal(e.DisplayVersion, '1.0.0');
  assert.equal(e.EstimatedSize, '0x3a2f0');
  assert.deepEqual(core.splitCommand(e.QuietUninstallString), ['C:\\Users\\a\\AppData\\Local\\Programs\\aerogyan-store\\Uninstall AeroGyan Store.exe', '/currentuser', '/S']);
  const j = core.findUninstall(keys, { appId: 'tech.aerogyan.medico', productName: 'Jivan Medico' });
  assert.equal(j && j.DisplayVersion, '1.0.0', 'DisplayName "<name> <version>" matches the product');
  assert.equal(core.findUninstall(keys, { appId: 'tech.aerogyan.drishya', productName: 'Drishya' }), null);
  assert.equal(core.findUninstall(keys, { appId: 'x', productName: 'Jivan' }), null, 'a prefix is not a match');
});

test('Info.plist and dpkg parsing', () => {
  assert.deepEqual(core.parsePlist('{"CFBundleIdentifier":"tech.aerogyan.store","CFBundleShortVersionString":"1.2.3","CFBundleName":"AeroGyan Store"}'),
    { id: 'tech.aerogyan.store', version: '1.2.3', name: 'AeroGyan Store' });
  assert.equal(core.parsePlist('not json'), null);
  assert.equal(core.parseDpkg('install ok installed\t1.0.5'), '1.0.5');
  assert.equal(core.parseDpkg('install ok installed\t1:2.0.0'), '2.0.0');
  assert.equal(core.parseDpkg('deinstall ok config-files\t1.0.5'), '');
  assert.equal(core.parseDpkg('unknown ok not-installed\t'), '');
  assert.equal(core.parseDpkg(''), '');
});

test('which file fits this computer', () => {
  const f = (v) => ({ available: v, url: v ? 'https://aerogyan.tech/x' : '' });
  const app = { id: 'a', platforms: { windows: f(true), mac: f(false), linux: f(true), deb: f(true) } };
  assert.equal(core.osKey('win32'), 'windows'); assert.equal(core.osKey('darwin'), 'mac'); assert.equal(core.osKey('linux'), 'linux');
  assert.equal(core.target(app, 'windows').plat, 'windows');
  assert.equal(core.status(app, 'mac'), 'soon');
  assert.equal(core.target(app, 'linux', { hasDpkg: true }).plat, 'deb');
  assert.equal(core.target(app, 'linux', { hasDpkg: false }).plat, 'linux');
  assert.equal(core.target(app, 'linux', { hasDpkg: true, prefer: 'linux' }).plat, 'linux');
  const office = { id: 'office-sheets', kind: 'office', inPacks: ['pack-students'], platforms: { android: f(true), windows: f(true) } };
  assert.equal(core.status(office, 'windows'), 'ready');
  assert.equal(core.status(office, 'mac'), 'pack', 'a single Office app comes in the pack on a Mac');
  assert.equal(core.status({ id: 'w', platforms: {} }, 'linux'), 'web');
  assert.equal(core.forRole({ audience: ['professor'] }, 'student'), false);
  assert.equal(core.forRole({ audience: ['everyone'] }, 'student'), true);
});

test('the host pin', () => {
  const hosts = ['aerogyan.tech', 'medico.aerogyan.tech', 'drishya.aerogyan.tech', 'ganak.aerogyan.tech',
    'sankalak.aerogyan.tech', 'shilp.aerogyan.tech', 'indpay.aerogyan.tech', 'ganit.aerogyan.tech'];   // 1.0.1: Sankalak, Shilp, IndPay, Ganit (built in; newer ones come from the signed manifest)
  for (const h of hosts) assert.equal(core.checkUrl(`https://${h}/download/x`, { catalogHosts: hosts }), '');
  assert.match(core.checkUrl('https://sankalak.aerogyan.tech.evil.com/x'), /not an AeroGyan server/);
  assert.match(core.checkUrl('https://shilp.aerogyan.tech/x', { catalogHosts: ['aerogyan.tech'] }), /not in the catalogue/);
  assert.match(core.checkUrl('http://aerogyan.tech/x'), /https/);
  assert.match(core.checkUrl('https://evil.example.com/x'), /not an AeroGyan server/);
  assert.match(core.checkUrl('https://aerogyan.tech.evil.com/x'), /not an AeroGyan server/);
  assert.match(core.checkUrl('https://user:pw@aerogyan.tech/x'), /credentials/);
  assert.match(core.checkUrl('https://ganak.aerogyan.tech/x', { catalogHosts: ['aerogyan.tech'] }), /not in the catalogue/);
  assert.match(core.checkUrl('http://127.0.0.1/x'), /https/);
  assert.equal(core.checkUrl('http://127.0.0.1/x', { testHosts: ['127.0.0.1'] }), '');
  assert.match(core.checkUrl('file:///etc/passwd'), /https/);
});

test('catalogue cleaning', () => {
  assert.throws(() => core.cleanCatalog({ success: false }));
  const c = core.cleanCatalog({ success: true, hosts: ['aerogyan.tech'], apps: [{ id: 'ok', name: 'A' }, { id: '../x', name: 'B' }, { id: 'n' }] });
  assert.deepEqual(c.apps.map((a) => a.id), ['ok']);
  assert.deepEqual(c.apps[0].platforms, {});
});

/* ---------------------------------------------------------------- ⭐ 1.0.2 — the signed trust manifest */
const trust = require('../src/lib/trust');
const REPO_TRUST = path.join(__dirname, '..', '..', '..', 'store', 'trust.json');
function testKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const raw = der.subarray(der.length - 32);
  return { privateKey, b64: raw.toString('base64'), id: trust.keyIdOf(raw) };
}
function signed(k, over = {}, signWith) {
  const payload = Object.assign({ type: 'aerogyan-store-trust', schema: 1, version: 100, keyId: k.id, issuedAt: '2026-11-22T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z', hosts: ['aerogyan.tech', 'shodh.aerogyan.tech', 'Bad Host!'], products: ['shodh'],
    android: { packages: {} }, desktop: { apps: { 'tech.aerogyan.shodh': { product: 'shodh', productName: 'Shodh', deb: 'shodh', minVersion: '1.2.0' }, 'com.apple.Safari': { productName: 'Safari' } } } }, over);
  const bytes = Buffer.from(JSON.stringify(payload));
  const sig = crypto.sign(null, Buffer.concat([Buffer.from('AeroGyan-Store-Trust/1\n'), bytes]), (signWith || k).privateKey);
  return JSON.stringify({ format: 'aerogyan-store-trust/1', keyId: payload.keyId, payload: bytes.toString('base64'), signature: sig.toString('base64') });
}

test('trust: the repository manifest verifies with the pinned key and covers today\'s products', () => {
  const m = trust.verify(fs.readFileSync(REPO_TRUST, 'utf8'));
  assert.ok(m.version > 1700000000);
  for (const h of core.PINNED_HOSTS) assert.ok(m.hosts.includes(h), h);
  for (const id of Object.keys(core.BUILTIN_APPS)) assert.equal(m.apps[id].productName, core.BUILTIN_APPS[id].productName, id);
  assert.equal(m.apps['tech.aerogyan.office.sheets'].product, 'office-sheets');
  assert.equal(m.apps['tech.aerogyan.pack.students'].deb, 'aerogyan-pack-students');
  assert.ok(!m.apps['tech.aerogyan.indpay'], 'IndPay has no desktop app');
});

test('trust: signature, key, expiry and rollback rules', () => {
  const k = testKey(), other = testKey();
  const keys = [k.b64];
  const m = trust.verify(signed(k), { keys });
  assert.deepEqual(m.hosts, ['aerogyan.tech', 'shodh.aerogyan.tech'], 'a malformed host is dropped');
  assert.ok(m.apps['tech.aerogyan.shodh'] && !m.apps['com.apple.Safari'], 'only tech.aerogyan.* app ids');
  // one changed byte in the payload
  const env = JSON.parse(signed(k));
  const pl = Buffer.from(env.payload, 'base64'); pl[pl.indexOf('shodh')] = 0x53;
  assert.throws(() => trust.verify(Object.assign({}, env, { payload: pl.toString('base64') }), { keys }), /signature/);
  assert.throws(() => trust.verify(signed(k, {}, other), { keys }), /signature/, 'signed by another key under our key id');
  assert.throws(() => trust.verify(signed(other), { keys }), /not pinned/);
  assert.throws(() => trust.verify(signed(k, { keyId: other.id }), { keys }), /not pinned|inside/);
  assert.throws(() => trust.verify(signed(k, { expiresAt: '2020-01-01T00:00:00Z' }), { keys }), /expired/);
  assert.throws(() => trust.verify(signed(k, { type: 'x' }), { keys }), /type/);
  assert.throws(() => trust.verify(signed(k, { version: 1.5 }), { keys }), /version/);
  assert.throws(() => trust.verify(signed(k, { version: 99 }), { keys, minVersion: 100 }), /rollback/);
  assert.equal(trust.verify(signed(k), { keys, minVersion: 100 }).version, 100, 'the same version again is fine');
  assert.throws(() => trust.verify('{"format":"x"}', { keys }), /not an AeroGyan/);
  // pick: the newest valid one, never below lastSeen
  const best = trust.pick([signed(k, { version: 120 }), signed(k, { version: 150, expiresAt: '2020-01-01T00:00:00Z' }), signed(other, { version: 999 }), 'junk', null], { keys, lastSeen: 110 });
  assert.equal(best.m.version, 120);
  assert.equal(trust.pick([signed(k, { version: 105 })], { keys, lastSeen: 110 }), null, 'an older manifest (a replay) is refused');
  assert.equal(trust.live(m, Date.parse('2100-01-01')), false, 'expired while the store runs → not used');
});

test('trust: the hosts and install ids it adds; built-in ones always hold', () => {
  const k = testKey();
  const m = trust.verify(signed(k), { keys: [k.b64] });
  assert.match(core.checkUrl('https://shodh.aerogyan.tech/download/mac'), /not an AeroGyan server/, 'unknown host without the manifest');
  assert.equal(core.checkUrl('https://shodh.aerogyan.tech/download/mac', { trustHosts: m.hosts }), '');
  assert.match(core.checkUrl('https://evil.example.com/x', { trustHosts: m.hosts }), /not an AeroGyan server/);
  const plat = (appId, productName, extra) => Object.assign({ available: true, appId, productName, version: '1.3.0', url: 'https://shodh.aerogyan.tech/download/mac', sha256: 'a'.repeat(64) }, extra || {});
  const shodh = { id: 'shodh', name: 'Shodh', web: 'https://shodh.aerogyan.tech/', platforms: { mac: plat('tech.aerogyan.shodh', 'Shodh', { appName: 'Shodh.app' }), deb: plat('tech.aerogyan.shodh', 'Shodh', { debPackage: 'shodh' }) } };
  const cat = { apps: [shodh,
    { id: 'aerogyan', name: 'AeroGyan', platforms: { windows: plat('tech.aerogyan.app', 'AeroGyan'), mac: plat('com.google.Chrome', 'Google Chrome') } },
    { id: 'ganit', name: 'Ganit', platforms: { windows: plat('tech.aerogyan.app', 'AeroGyan') } },
    { id: 'office-sheets', name: 'AeroGyan Sheets', platforms: { windows: plat('tech.aerogyan.office.sheets', 'AeroGyan Sheets') } },
    { id: 'office-notes', name: 'AeroGyan Notes', platforms: { windows: plat('tech.aerogyan.office.sheets', 'AeroGyan Sheets') } },
    { id: 'pack-students', name: 'AeroGyan for Students', platforms: { deb: plat('tech.aerogyan.pack.students', 'AeroGyan for Students', { debPackage: 'gnome-shell' }) } },
    { id: 'medico', name: 'Jivan Medico', platforms: { windows: plat('tech.aerogyan.medico', 'Google Chrome') } }] };
  const ids = (c) => Object.fromEntries(c.apps.map((a) => [a.id, Object.keys(a.platforms).sort().join(',')]));
  assert.deepEqual(ids(core.applyTrust(cat, null)), { shodh: '', aerogyan: 'windows', ganit: '', 'office-sheets': 'windows', 'office-notes': '', 'pack-students': '', medico: '' },
    'without the manifest: only built-in ids; another program, another product\'s id, a wrong name or .deb are removed');
  const withM = core.applyTrust(cat, m);
  assert.equal(ids(withM).shodh, 'deb,mac', 'the manifest adds Shodh');
  assert.equal(core.status(withM.apps[0], 'mac'), 'ready');
  assert.equal(core.status(core.applyTrust(cat, null).apps[0], 'mac'), 'web', 'untrusted → "Open in browser", still listed');
  const old = core.applyTrust({ apps: [Object.assign({}, shodh, { platforms: { mac: plat('tech.aerogyan.shodh', 'Shodh', { version: '1.1.9' }) } })] }, m);
  assert.equal(old.apps[0].platforms.mac.available, false, 'below the manifest\'s minVersion: never offered');
  assert.equal(old.apps[0].platforms.mac.belowMinimum, true);
  // web-only apps (IndPay; Office apps on a Mac without a pack) stay listed with the browser
  assert.equal(core.status({ id: 'indpay', web: 'https://indpay.aerogyan.tech/', platforms: { android: { available: true } } }, 'windows'), 'web');
});

test('Mac: started from the disk image or App Translocation (⭐ 1.0.2)', () => {
  const exe = (app) => app + '/Contents/MacOS/AeroGyan Store';
  const tr = '/private/var/folders/x1/abc/T/AppTranslocation/6F1C2D3E-1234-4ABC-9DEF-000000000000/d/AeroGyan Store.app';
  assert.deepEqual(core.macLaunchProblem(exe(tr)), { problem: 'translocated', app: tr });
  assert.deepEqual(core.macLaunchProblem(exe('/Volumes/AeroGyan Store 1.0.0/AeroGyan Store.app')), { problem: 'dmg', app: '/Volumes/AeroGyan Store 1.0.0/AeroGyan Store.app' });
  assert.equal(core.macLaunchProblem(exe('/Applications/AeroGyan Store.app')).problem, '');
  assert.equal(core.macLaunchProblem(exe('/Users/me/Applications/AeroGyan Store.app')).problem, '');
  assert.equal(core.macLaunchProblem(exe('/Volumes/Macintosh HD/Applications/AeroGyan Store.app')).problem, 'dmg', 'any /Volumes/… path is a mounted disk');
  assert.equal(core.macLaunchProblem('/usr/local/bin/electron').problem, '', 'not an app bundle (a dev run)');
  assert.equal(core.applicationsDir('/Users/me', true), '/Applications');
  assert.equal(core.applicationsDir('/Users/me/', false), '/Users/me/Applications');
});

/* ---------------------------------------------------------------- the downloader against a local server */
function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const allow = (u) => core.checkUrl(u, { testHosts: ['127.0.0.1'] });

test('download: resumes with Range + If-Range; a 200 answer restarts; the hash decides', async (t) => {
  const body = crypto.randomBytes(256 * 1024);
  const seen = [];
  let honour = true, dropOnce = true;
  const s = await server((req, res) => {
    seen.push({ range: req.headers.range || '', ifRange: req.headers['if-range'] || '' });
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    res.setHeader('ETag', '"v1"');
    if (m && honour) {
      const from = Number(m[1]);
      res.writeHead(206, { 'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}`, 'Content-Length': body.length - from });
      return res.end(body.subarray(from));
    }
    res.writeHead(200, { 'Content-Length': body.length });
    if (dropOnce) { dropOnce = false; res.write(body.subarray(0, 100000)); return setTimeout(() => res.destroy(), 30); }
    res.end(body);
  });
  t.after(() => s.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agdl-'));
  const url = `http://127.0.0.1:${s.address().port}/f`;
  const got = await download({ url, dest: path.join(dir, 'f.bin'), sha256: sha(body), size: body.length, check: allow, backoffMs: 10 });
  assert.equal(sha(fs.readFileSync(got)), sha(body));
  assert.ok(seen.length >= 2, 'the dropped download was retried');
  assert.match(seen[1].range, /^bytes=\d+-$/, 'the retry asked for the rest');
  assert.equal(seen[1].ifRange, '"v1"', 'with If-Range = the first ETag');
  assert.ok(!fs.existsSync(got + '.part'));

  // a server that ignores Range (200): the part is thrown away and the whole file fetched again
  honour = false; dropOnce = true; seen.length = 0;
  const got2 = await download({ url, dest: path.join(dir, 'g.bin'), sha256: sha(body), size: body.length, check: allow, backoffMs: 10 });
  assert.equal(sha(fs.readFileSync(got2)), sha(body));
});

test('download: a wrong hash is deleted; no hash / another host never fetch', async (t) => {
  const body = Buffer.from('hello store');
  let hits = 0;
  const s = await server((req, res) => { hits++; res.end(body); });
  t.after(() => s.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agdl-'));
  const url = `http://127.0.0.1:${s.address().port}/f`;
  await assert.rejects(download({ url, dest: path.join(dir, 'a'), sha256: 'a'.repeat(64), size: body.length, check: allow }), (e) => e.code === 'SHA_MISMATCH');
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing left behind');
  hits = 0;
  await assert.rejects(download({ url, dest: path.join(dir, 'b'), sha256: '', check: allow }), (e) => e.code === 'NO_SHA');
  await assert.rejects(download({ url: 'https://evil.example.com/f', dest: path.join(dir, 'c'), sha256: sha(body), check: allow }), (e) => e.code === 'BLOCKED_HOST');
  assert.equal(hits, 0);
  // a redirect to another host is refused too
  const r = await server((req, res) => { res.writeHead(302, { Location: 'https://evil.example.com/x' }); res.end(); });
  t.after(() => r.close());
  await assert.rejects(download({ url: `http://127.0.0.1:${r.address().port}/f`, dest: path.join(dir, 'd'), sha256: sha(body), check: allow }), (e) => e.code === 'BLOCKED_HOST');
});

test('download: cancel keeps the part for later', async (t) => {
  const body = crypto.randomBytes(512 * 1024);
  const s = await server((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    const from = m ? Number(m[1]) : 0;
    res.writeHead(m ? 206 : 200, Object.assign({ 'Content-Length': body.length - from, ETag: '"x"' }, m ? { 'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}` } : {}));
    if (m) return res.end(body.subarray(from));
    res.write(body.subarray(0, 4096));                       // then stall until cancelled
  });
  t.after(() => { s.closeAllConnections(); s.close(); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agdl-'));
  const dest = path.join(dir, 'f');
  const ctl = new AbortController();
  const p = download({ url: `http://127.0.0.1:${s.address().port}/f`, dest, sha256: sha(body), size: body.length, check: allow, signal: ctl.signal, onProgress: (x) => { if (x.received >= 4096) ctl.abort(); } });
  await assert.rejects(p, (e) => e.code === 'CANCELLED');
  assert.ok(fs.statSync(dest + '.part').size >= 4096, 'the part stays');
  const done = await download({ url: `http://127.0.0.1:${s.address().port}/f`, dest, sha256: sha(body), size: body.length, check: allow });
  assert.equal(sha(fs.readFileSync(done)), sha(body), 'resumed to the end');
});
