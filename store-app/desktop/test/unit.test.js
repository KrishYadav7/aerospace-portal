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
    'sankalak.aerogyan.tech', 'shilp.aerogyan.tech', 'indpay.aerogyan.tech', 'ganit.aerogyan.tech'];   // 1.0.1: Sankalak, Shilp, IndPay, Ganit
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
