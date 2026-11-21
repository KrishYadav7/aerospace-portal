#!/usr/bin/env node
/* Test vectors for TrustTest / TrustStoreTest (app/src/test/resources/trust/*.json), signed with TEST keys made from
   fixed seeds — never the real catalogue key. Deterministic (Ed25519), so re-running gives the same files.
     node legacy-node/store-app/android/app/src/test/trust-vectors.mjs
   real.json is a copy of legacy-node/store/trust.json (signed by the real key on the owner's laptop). */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayload, sign, keyIdOf, rawPublic } from '../../../../../../tools/sign-catalog.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LN = path.resolve(HERE, '../../../../..');
const OUT = path.join(HERE, 'resources', 'trust');
fs.mkdirSync(OUT, { recursive: true });

const keyFromSeed = (label) => {
  const seed = crypto.createHash('sha256').update(label).digest();
  return crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
};
const k1 = keyFromSeed('aerogyan-store-trust-TEST-key-1');
const k2 = keyFromSeed('aerogyan-store-trust-TEST-key-2');
const pub1 = rawPublic(crypto.createPublicKey(k1)), pub2 = rawPublic(crypto.createPublicKey(k2));
const id1 = keyIdOf(pub1), id2 = keyIdOf(pub2);

const reg = JSON.parse(fs.readFileSync(path.join(LN, 'software', 'registry.json'), 'utf8'));
const office = JSON.parse(fs.readFileSync(path.join(LN, 'office', 'apps.json'), 'utf8'));
// a product the built-in pins do not know, and a minimum version for Ganak
reg.products.push({ id: 'shodh', name: 'Shodh', site: 'https://shodh.aerogyan.tech',
  android: { package: 'tech.aerogyan.shodh', signers: ['ab'.repeat(32)] } });
for (const p of reg.products) if (p.android && p.android.package === 'tech.aerogyan.ganak') p.android.minVersionCode = 5;

const now = new Date('2026-11-21T00:00:00Z');
const LONG = 365 * 100;                                     // valid for a century: the Pins tests use the real clock
const payload = (version, opts = {}) => buildPayload(reg, office, { version, now, days: LONG, keyId: id1, ...opts });
const write = (name, env) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(env, null, 1) + '\n');

write('valid.json', sign(payload(100), k1));
write('older.json', sign(payload(50), k1));
write('newer.json', sign(payload(200), k1));
// one payload byte changed after signing
const t = sign(payload(100), k1);
const b = Buffer.from(t.payload, 'base64');
const i = b.indexOf(Buffer.from('shodh.aerogyan.tech'));
b[i] = 't'.charCodeAt(0);                                  // "shodh.aerogyan.tech" → "thodh.aerogyan.tech"
write('tampered.json', { ...t, payload: b.toString('base64') });
// signed by test key 2 but claiming key 1's id (gets as far as the signature check)
write('wrong-key.json', sign(payload(100), k2));
// signed by test key 2 under its own id (a key that is not pinned)
write('unpinned-key.json', sign(payload(100, { keyId: id2 }), k2));
// envelope says key 1, the signed payload says another id
const mm = sign(payload(100, { keyId: '0000000000000000' }), k1);
write('keyid-mismatch.json', { ...mm, keyId: id1 });
// expired a day after 2020-01-01
write('expired.json', sign(buildPayload(reg, office, { version: 100, now: new Date('2020-01-01T00:00:00Z'), days: 1, keyId: id1 }), k1));
fs.copyFileSync(path.join(LN, 'store', 'trust.json'), path.join(OUT, 'real.json'));

console.log(`test key 1 ${pub1.toString('base64')} (id ${id1})\ntest key 2 ${pub2.toString('base64')} (id ${id2})`);
