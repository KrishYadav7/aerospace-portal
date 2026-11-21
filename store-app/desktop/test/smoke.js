#!/usr/bin/env node
/* ============================================================
   Smoke test of the desktop store (run locally and on each CI system):
     node test/smoke.js [electron binary]     (from VS Code: env -u ELECTRON_RUN_AS_NODE node test/smoke.js)
   Starts a fake catalogue on http://127.0.0.1:<port> (good / tampered / no-sha / other-host apps, every
   platform), launches the store with --aero-selftest (src/selftest.js) and AEROGYAN_STORE_TEST_HOSTS=127.0.0.1
   (honoured only by an unpacked run), and fails unless every check passed.
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const GOOD = crypto.randomBytes(300 * 1024);
const TAMPERED = Buffer.concat([GOOD.subarray(0, 1000), Buffer.from('evil'), GOOD.subarray(1004)]);
const hits = [];

function entry(id, name, url, sum, extra) {
  const appId = id === 'store' ? 'tech.aerogyan.store' : id === 'stranger' ? 'com.example.stranger' : 'tech.aerogyan.test.' + id;
  const f = { available: true, version: '1.2.3', size: GOOD.length, url, fileName: `${id}-1.2.3`, updatedAt: '2026-11-20T00:00:00Z' };
  if (sum) f.sha256 = sum;
  const P = {};
  for (const [plat, ext] of [['windows', '.exe'], ['mac', '.dmg'], ['linux', '.AppImage'], ['deb', '.deb']]) {
    P[plat] = Object.assign({}, f, { fileName: f.fileName + ext, appId, productName: name, version: id === 'store' ? '9.9.9' : f.version, installer: plat === 'windows' ? 'nsis' : plat });
  }
  return Object.assign({ id, kind: 'app', product: id, name, nameHi: name + ' (हिं)', line: `${name} for the smoke test`, audience: ['everyone'], color: '#4F46E5', web: 'https://aerogyan.tech/', platforms: P }, extra || {});
}

const server = http.createServer((req, res) => {
  hits.push(req.url);
  const base = `http://127.0.0.1:${server.address().port}`;
  if (req.url.startsWith('/api/store')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ success: true, schema: 1, generatedAt: new Date().toISOString(), hosts: ['aerogyan.tech'], apps: [
      entry('good', 'Good App', base + '/files/good.bin', sha(GOOD)),
      entry('tampered', 'Tampered App', base + '/files/tampered.bin', sha(GOOD)),         // the server sends other bytes
      entry('nosha', 'No Hash App', base + '/files/good.bin', ''),
      entry('badhost', 'Other Host App', 'https://evil.example.com/files/good.bin', sha(GOOD)),
      entry('webonly', 'Web Only App', '', '', { platforms: {} }),
      // ⭐ 1.0.2 — a newer store (the banner nobody can miss); its files are never downloaded by the smoke test
      Object.assign(entry('store', 'AeroGyan Store', base + '/files/good.bin', sha(GOOD)), { kind: 'store', web: 'https://aerogyan.tech/#store' }),
      // ⭐ 1.0.2 — an id that is neither built in nor in the signed manifest: listed, never installable
      Object.assign(entry('stranger', 'Stranger App', base + '/files/good.bin', sha(GOOD)), {})
    ] }));
  }
  if (req.url === '/hits') return res.end(hits.join('\n'));
  if (req.url === '/files/good.bin' || req.url === '/files/tampered.bin') {
    const body = req.url.includes('tampered') ? TAMPERED : GOOD;
    res.setHeader('Content-Length', body.length);
    res.setHeader('ETag', '"' + sha(body).slice(0, 16) + '"');
    return res.end(body);
  }
  res.statusCode = 404; res.end();
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agstore-smoke-'));
  const electron = process.argv[2] || require('electron');
  const args = [];
  if (!process.argv[2]) args.push(path.join(__dirname, '..'));
  if (process.platform === 'linux') args.push('--no-sandbox');
  args.push(`--aero-selftest=${dir}`, `--catalog=http://127.0.0.1:${port}/api/store?for=desktop`);
  const env = Object.assign({}, process.env, { AEROGYAN_STORE_TEST_HOSTS: '127.0.0.1' });
  delete env.ELECTRON_RUN_AS_NODE;
  console.log('running', electron, args.join(' '));
  const child = spawn(electron, args, { env, stdio: 'inherit' });
  child.on('exit', (code) => {
    server.close();
    let report = '';
    try { report = fs.readFileSync(path.join(dir, 'report.txt'), 'utf8'); } catch (_) {}
    console.log('\n' + report);
    if (process.env.SMOKE_OUT) { try { fs.cpSync(dir, process.env.SMOKE_OUT, { recursive: true }); } catch (_) {} }
    const okReport = /RESULT: all checks passed/.test(report);
    console.log(okReport && code === 0 ? 'SMOKE OK' : `SMOKE FAILED (exit ${code})`);
    process.exit(okReport && code === 0 ? 0 : 1);
  });
});
