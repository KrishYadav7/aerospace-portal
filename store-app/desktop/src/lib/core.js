/* ============================================================
   AeroGyan Store (desktop) — pure helpers, no Electron, no I/O.
   Unit-tested in test/unit.test.js:
     versions      compare 1.0.10 > 1.0.9, 1.0.0 > 1.0.0-rc.2
     nsisGuid      the uninstall-key name electron-builder gives an app id
     parseReg      `reg query … /s` output → keys and values
     parsePlist    `plutil -convert json -o - Info.plist` → id + version
     parseDpkg     `dpkg-query -W -f='${Status}\t${Version}'` → installed version
     osKey/target  which file of a catalogue entry fits this computer
     checkUrl      the host pin: only our own servers, only https
   ============================================================ */
'use strict';
const crypto = require('crypto');

/* ---------------------------------------------------------------- the host pin
   Only these servers may give the store a file — whatever the catalogue says. A compromised catalogue
   can therefore not send the store to another server; it would also need a matching sha256 (and, on
   Android, our signing key). The desktop installers carry no code-signing certificate of ours (none is
   bought yet), so on computers the checks are: pinned https host + sha256 from the catalogue. */
const PINNED_HOSTS = Object.freeze(['aerogyan.tech', 'medico.aerogyan.tech', 'drishya.aerogyan.tech', 'ganak.aerogyan.tech',
  'sankalak.aerogyan.tech', 'shilp.aerogyan.tech', 'indpay.aerogyan.tech']);   // ⭐ 1.0.1: Sankalak, Shilp (IndPay: hosts only — no desktop installers)

/* checkUrl(url, {catalogHosts, testHosts}) → '' when allowed, else the reason.
   testHosts (e.g. ['127.0.0.1']) is honoured only by an unpacked build run for a test (main.js). */
function checkUrl(raw, opts = {}) {
  let u;
  try { u = new URL(String(raw)); } catch (_) { return 'not a web address'; }
  const host = u.hostname.toLowerCase();
  const test = (opts.testHosts || []).includes(host);
  if (u.protocol !== 'https:' && !(test && u.protocol === 'http:')) return 'not https';
  if (u.username || u.password) return 'credentials in the address';
  if (!test && !PINNED_HOSTS.includes(host)) return `${host} is not an AeroGyan server`;
  if (!test && Array.isArray(opts.catalogHosts) && opts.catalogHosts.length && !opts.catalogHosts.includes(host)) return `${host} is not in the catalogue`;
  return '';
}

/* ---------------------------------------------------------------- versions */
function parseVer(v) {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(String(v || ''));
  if (!m) return null;
  return { nums: [m[1], m[2], m[3], m[4]].map((x) => Number(x || 0)), pre: m[5] || '' };
}
/* cmpVer(a, b): 1 when a is newer, -1 when older, 0 when the same (or either cannot be read) */
function cmpVer(a, b) {
  const x = parseVer(a), y = parseVer(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 4; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;               // a release is newer than its candidates
  if (!y.pre) return -1;
  const pa = x.pre.split('.'), pb = y.pre.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]), nb = /^\d+$/.test(pb[i]);
    if (na && nb && Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) > Number(pb[i]) ? 1 : -1;
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/* ---------------------------------------------------------------- Windows: the uninstall key
   electron-builder (app-builder-lib NsisTarget): guid = UUID.v5(appId, 50e065bc-3134-11e6-9bab-38c9862bdaf3);
   the key is Software\Microsoft\Windows\CurrentVersion\Uninstall\<guid> (lower case, no braces) in HKCU for a
   per-user install (ours), HKLM for a per-machine one. */
const EB_NAMESPACE = Buffer.from('50e065bc313411e69bab38c9862bdaf3', 'hex');
function nsisGuid(appId) {
  const h = crypto.createHash('sha1').update(EB_NAMESPACE).update(String(appId)).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/* parseReg(text) → { '<full key path>': { name: value } } (REG_SZ / REG_EXPAND_SZ / REG_DWORD as text) */
function parseReg(text) {
  const out = {};
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    if (/^HKEY_/i.test(line)) { cur = out[line] = out[line] || {}; continue; }
    const m = /^\s+(.*?)\s{2,}(REG_[A-Z_]+)(?:\s{2,}(.*))?$/.exec(line);
    if (m && cur) cur[m[1] === '(Default)' ? '' : m[1]] = m[3] === undefined ? '' : m[3];
  }
  return out;
}

/* findUninstall(keys, {appId, productName}) → the entry {key, DisplayName, DisplayVersion, …} or null:
   the key named by the GUID first, then a DisplayName equal to the product name (old installs, or a
   product built with its own guid). */
function findUninstall(keys, { appId, productName }) {
  const guid = appId ? nsisGuid(appId) : '';
  const list = Object.entries(keys || {});
  const last = (k) => k.split('\\').pop().replace(/[{}]/g, '').toLowerCase();
  let hit = guid && list.find(([k]) => last(k) === guid);
  if (!hit && productName) {
    const want = String(productName).trim().toLowerCase();
    hit = list.find(([, v]) => {
      const n = String(v.DisplayName || '').trim().toLowerCase();
      return n === want || (n.startsWith(want + ' ') && /^\d/.test(n.slice(want.length + 1)));   // "Name 1.2.3"
    });
  }
  return hit ? Object.assign({ key: hit[0] }, hit[1]) : null;
}

/* splitCommand('"C:\\x\\Uninstall A.exe" /currentuser /S') → ['C:\\x\\Uninstall A.exe', '/currentuser', '/S'] */
function splitCommand(cmd) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(cmd || '')))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/* ---------------------------------------------------------------- Mac / Linux parsers */
function parsePlist(json) {
  try {
    const p = typeof json === 'string' ? JSON.parse(json) : json;
    return { id: String(p.CFBundleIdentifier || ''), version: String(p.CFBundleShortVersionString || p.CFBundleVersion || ''), name: String(p.CFBundleName || '') };
  } catch (_) { return null; }
}
/* dpkg-query output "install ok installed\t1.2.3" → '1.2.3' ('' when not installed) */
function parseDpkg(text) {
  const [status, version] = String(text || '').trim().split('\t');
  if (!/\binstalled\b/.test(status || '') || /not-installed|config-files/.test(status || '')) return '';
  return (version || '').replace(/^\d+:/, '').trim();
}

/* ---------------------------------------------------------------- which file fits this computer */
function osKey(platform = process.platform) {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'mac' : 'linux';
}
const DESKTOP = ['windows', 'mac', 'linux', 'deb'];

/* target(app, os, {hasDpkg, prefer}) → {plat, file} where file = app.platforms[plat] (available or not) or null.
   Linux: the .deb where dpkg exists and the entry has one (unless prefer === 'linux'), else the AppImage. */
function target(app, os, opts = {}) {
  const P = (app && app.platforms) || {};
  if (os === 'windows') return P.windows ? { plat: 'windows', file: P.windows } : null;
  if (os === 'mac') return P.mac ? { plat: 'mac', file: P.mac } : null;
  const deb = P.deb, img = P.linux;
  const avail = (x) => !!(x && x.available);
  if (opts.prefer === 'linux' && avail(img)) return { plat: 'linux', file: img };
  if (opts.prefer === 'deb' && avail(deb) && opts.hasDpkg) return { plat: 'deb', file: deb };
  if (opts.hasDpkg && avail(deb)) return { plat: 'deb', file: deb };
  if (avail(img)) return { plat: 'linux', file: img };
  if (avail(deb)) return { plat: 'deb', file: deb };
  if (img) return { plat: 'linux', file: img };
  return deb ? { plat: 'deb', file: deb } : null;
}

/* status(app, os, opts) → 'ready' (a file to install) | 'soon' (made for this computer, not published yet) |
   'pack' (an Office app that comes in a pack here) | 'web' (open it in the browser) */
function status(app, os, opts) {
  const t = target(app, os, opts);
  if (t && t.file.available && t.file.url) return 'ready';
  if (t) return 'soon';
  if (app && Array.isArray(app.inPacks) && app.inPacks.length) return 'pack';
  return 'web';
}

/* forRole(app, role): the "For you" tab (role student | professor | everyone) */
function forRole(app, role) {
  const a = (app && app.audience) || [];
  if (!role || role === 'everyone') return true;
  return a.includes(role) || a.includes('everyone') || app.kind === 'store' || !!app.featured;
}

/* normalise a catalogue (drop anything malformed; never trust it for more than words and files) */
function cleanCatalog(c) {
  if (!c || c.success !== true || !Array.isArray(c.apps)) throw new Error('not a store catalogue');
  const apps = c.apps.filter((a) => a && typeof a.id === 'string' && /^[a-z0-9-]{1,60}$/.test(a.id) && typeof a.name === 'string')
    .map((a) => Object.assign({}, a, { platforms: a.platforms && typeof a.platforms === 'object' ? a.platforms : {} }));
  return { schema: c.schema, generatedAt: c.generatedAt, hosts: Array.isArray(c.hosts) ? c.hosts.map(String) : [], apps };
}

function isSha256(s) { return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s); }

module.exports = { PINNED_HOSTS, checkUrl, cmpVer, parseVer, nsisGuid, parseReg, findUninstall, splitCommand, parsePlist, parseDpkg,
  osKey, target, status, forRole, cleanCatalog, isSha256, DESKTOP };
