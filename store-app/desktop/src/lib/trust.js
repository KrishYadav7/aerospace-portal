/* ============================================================
   AeroGyan Store (desktop) — the SIGNED trust manifest (⭐ 1.0.2, docs/store-trust.md). Pure: no Electron, no I/O.

   The store pins ONE thing besides its built-in hosts: the catalogue's Ed25519 public key(s) below. Whatever a validly
   signed, unexpired, not-rolled-back manifest (GET https://aerogyan.tech/api/store/trust = legacy-node/store/trust.json,
   signed OFFLINE by tools/sign-catalog.mjs) lists is trusted IN ADDITION to the built-in pins:
     hosts          more servers the store may download from (https only)
     desktop.apps   each install id (app id) with its product name / .deb name — the only ids the store installs,
                    finds or uninstalls, so a changed catalogue cannot point "Uninstall" at another program
     minVersion     a floor below which an installer is refused (an old, vulnerable build re-offered)
   The private key never touches the server: a server compromise cannot add a host or an app id.
   Same rules, same order as verify() in tools/sign-catalog.mjs. Unit-tested in test/unit.test.js.
   ============================================================ */
'use strict';
const crypto = require('crypto');

/* base64 of the raw 32-byte public keys; a key rotation ships a release with key #2 added, later one without key #1 */
const TRUST_KEYS = Object.freeze(['jfHxceRb/EeLxGp5rv+cbP+b+vgsnFtyQGtB5EJc9pA=']);
const FORMAT = 'aerogyan-store-trust/1';
const PREFIX = Buffer.from('AeroGyan-Store-Trust/1\n', 'utf8');
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const APPID = /^tech\.aerogyan\.[a-z0-9.-]{1,60}$/;

function keyIdOf(raw) { return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16); }

/* verify(text | object, {keys, now, minVersion}) → {version, expiresAt (ms), hosts[], apps{appId: {...}}} or throws */
function verify(input, opts = {}) {
  const keys = opts.keys || TRUST_KEYS;
  const now = opts.now === undefined ? Date.now() : opts.now;
  const minVersion = opts.minVersion || 0;
  let env;
  try { env = typeof input === 'string' ? JSON.parse(input) : input; } catch (_) { throw new Error('not JSON'); }
  if (!env || env.format !== FORMAT) throw new Error('not an AeroGyan store trust manifest');
  let pub = null;
  for (const b64 of keys) {
    const raw = Buffer.from(String(b64), 'base64');
    if (raw.length === 32 && keyIdOf(raw) === env.keyId) pub = crypto.createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });
  }
  if (!pub) throw new Error(`signed with key ${String(env.keyId).slice(0, 16)}, which is not pinned`);
  const bytes = Buffer.from(String(env.payload || ''), 'base64');
  const sig = Buffer.from(String(env.signature || ''), 'base64');
  if (sig.length !== 64 || !crypto.verify(null, Buffer.concat([PREFIX, bytes]), pub, sig)) throw new Error('the signature does not verify');
  let p;
  try { p = JSON.parse(bytes.toString('utf8')); } catch (_) { throw new Error('the payload is not JSON'); }
  if (!p || p.type !== 'aerogyan-store-trust' || p.schema !== 1) throw new Error('unknown manifest type');
  if (p.keyId !== env.keyId) throw new Error('keyId inside ≠ outside');
  if (!Number.isSafeInteger(p.version) || p.version < 1) throw new Error('bad version');
  const exp = Date.parse(p.expiresAt);
  if (!(exp > now)) throw new Error(`expired ${p.expiresAt}`);
  if (p.version < minVersion) throw new Error(`version ${p.version} is older than ${minVersion} (a rollback)`);
  const hosts = (Array.isArray(p.hosts) ? p.hosts : []).map((h) => String(h).trim().toLowerCase()).filter((h) => HOST.test(h));
  const apps = {};
  const src = (p.desktop && p.desktop.apps && typeof p.desktop.apps === 'object') ? p.desktop.apps : {};
  for (const [id, v] of Object.entries(src)) {
    if (!APPID.test(id) || !v || typeof v.productName !== 'string' || !v.productName.trim()) continue;
    apps[id] = { product: String(v.product || ''), productName: v.productName.trim(), deb: typeof v.deb === 'string' ? v.deb : '',
      minVersion: typeof v.minVersion === 'string' ? v.minVersion : '' };
  }
  return { version: p.version, expiresAt: exp, hosts, apps };
}

/* pick(candidates, {now, lastSeen}) → the newest manifest that verifies and is not older than lastSeen (or null).
   candidates: texts (the stored copy, the copy bundled in the app, a fresh download). */
function pick(candidates, opts = {}) {
  let best = null;
  for (const c of candidates) {
    if (!c) continue;
    try {
      const m = verify(c, { keys: opts.keys, now: opts.now, minVersion: opts.lastSeen || 0 });
      if (!best || m.version > best.m.version) best = { m, text: typeof c === 'string' ? c : JSON.stringify(c) };
    } catch (_) { /* ignored: unsigned, expired, rolled back */ }
  }
  return best;
}

/* still usable at `now` (a long-running store re-checks the expiry, not only at load) */
function live(m, now = Date.now()) { return !!(m && m.expiresAt > now); }

module.exports = { TRUST_KEYS, FORMAT, verify, pick, live, keyIdOf };
