/* ============================================================
   AeroGyan Store (desktop) — download + verify, plain Node (no Electron).
     download({url, dest, sha256, size, check, onProgress, signal}) → dest (verified)
   • only addresses `check(url)` allows (the host pin, core.checkUrl) — also after every redirect
   • resumable: <dest>.part + <dest>.part.json {url, etag, validator}; Range: bytes=<have>- with If-Range
     (the first answer's ETag, else its Last-Modified). 206 → append; 200 → the server ignored the range
     (the live nginx until deploy/store/nginx-ranges.sh) → start again from 0. A part of the full size is
     checked, not asked for again.
   • retries with backoff on network errors (slow mobile hotspots drop often), idle timeout 45 s
   • cancel: signal.abort() — the part stays for next time
   • verify: SHA-256 of the whole file must equal the catalogue's, else the file is deleted and
     err.code = 'SHA_MISMATCH'. No sha256 in the catalogue → err.code = 'NO_SHA' before anything is fetched.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { isSha256 } = require('./core');

function err(code, message) { const e = new Error(message); e.code = code; return e; }
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(err('CANCELLED', 'Cancelled')); }, { once: true });
});

function sha256File(fp) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(fp).on('error', reject).on('data', (b) => h.update(b)).on('end', () => resolve(h.digest('hex')));
  });
}

function readJSON(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { return null; } }
function sizeOf(fp) { try { return fs.statSync(fp).size; } catch (_) { return -1; } }

/* one HTTP request with redirects followed (each hop checked) → {res, url} */
function request(url, headers, check, signal, hops = 0) {
  return new Promise((resolve, reject) => {
    const why = check(url);
    if (why) return reject(err('BLOCKED_HOST', `Refused to download from ${url}: ${why}.`));
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: Object.assign({ 'User-Agent': 'AeroGyanStore-Desktop', 'Accept-Encoding': 'identity' }, headers) }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (hops >= 5) return reject(err('REDIRECTS', 'Too many redirects.'));
        const next = new URL(res.headers.location, url).toString();
        return request(next, headers, check, signal, hops + 1).then(resolve, reject);
      }
      resolve({ res, url });
    });
    req.setTimeout(45000, () => req.destroy(err('TIMEOUT', 'The server stopped answering.')));
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) req.destroy(err('CANCELLED', 'Cancelled'));
      signal.addEventListener('abort', () => req.destroy(err('CANCELLED', 'Cancelled')), { once: true });
    }
  });
}

/* fetch the rest of the file into part (one attempt) */
async function fetchOnce(o, part, meta, total) {
  let have = sizeOf(part);
  if (have < 0) have = 0;
  const headers = {};
  if (have > 0 && meta && meta.url === o.url) {
    headers.Range = `bytes=${have}-`;
    if (meta.validator) headers['If-Range'] = meta.validator;
  } else if (have > 0) {
    fs.rmSync(part, { force: true }); have = 0;
  }
  const { res } = await request(o.url, headers, o.check, o.signal);
  if (res.statusCode === 200 && have > 0) { have = 0; }                   // range ignored → whole file again
  else if (res.statusCode === 206) {
    const m = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(res.headers['content-range'] || '');
    if (!m || Number(m[1]) !== have) { res.resume(); fs.rmSync(part, { force: true }); throw err('RANGE', 'The server sent the wrong part — starting again.'); }
  } else if (res.statusCode !== 200) {
    res.resume();
    if (have > 0 && (res.statusCode === 416 || res.statusCode >= 500)) { fs.rmSync(part, { force: true }); throw err('RANGE', `Server answered ${res.statusCode} — starting again.`); }
    throw err('HTTP', `The server answered ${res.statusCode}.`);
  }
  const validator = res.headers.etag && !/^W\//.test(res.headers.etag) ? res.headers.etag : (res.headers.etag || res.headers['last-modified'] || '');
  fs.writeFileSync(part + '.json', JSON.stringify({ url: o.url, validator }));
  const len = Number(res.headers['content-length'] || 0);
  const full = res.statusCode === 206 ? have + len : len;
  const want = total || full || 0;
  if (o.size && full && full !== o.size && res.statusCode === 200) {
    // the server's file is not the catalogue's — the hash check decides, but say so early in the log
    o.log && o.log(`size ${full} differs from the catalogue's ${o.size}`);
  }
  const out = fs.createWriteStream(part, { flags: have > 0 && res.statusCode === 206 ? 'a' : 'w' });
  let got = res.statusCode === 206 ? have : 0;
  let last = 0;
  await new Promise((resolve, reject) => {
    let failed = false;
    // on any failure: stop, flush what arrived into the part (it is kept for the next attempt), then reject
    const fail = (e) => { if (failed) return; failed = true; res.unpipe(out); out.end(() => reject(e)); };
    res.on('data', (b) => {
      got += b.length;
      if (o.size && got > o.size + 1024 * 1024) { res.destroy(err('TOO_BIG', 'The file is larger than the catalogue says.')); return; }
      const now = Date.now();
      if (o.onProgress && now - last > 150) { last = now; o.onProgress({ received: got, total: want }); }
    });
    res.on('error', fail);
    res.on('aborted', () => fail(err('NET', 'The connection dropped.')));
    res.on('close', () => { if (!res.complete) fail(err('NET', 'The connection dropped.')); });
    out.on('error', (e) => { failed = true; reject(e); });
    out.on('finish', () => { if (!failed) resolve(); });
    res.pipe(out);
  });
  if (o.onProgress) o.onProgress({ received: got, total: want || got });
  return got;
}

async function download(o) {
  if (!isSha256(o.sha256)) throw err('NO_SHA', 'This file cannot be checked yet (no SHA-256 in the catalogue), so the store will not install it.');
  const why = o.check(o.url);
  if (why) throw err('BLOCKED_HOST', `Refused to download from ${o.url}: ${why}.`);
  fs.mkdirSync(path.dirname(o.dest), { recursive: true });
  const part = o.dest + '.part';
  // already downloaded and checked earlier
  if (sizeOf(o.dest) >= 0 && (await sha256File(o.dest)) === o.sha256) return o.dest;
  fs.rmSync(o.dest, { force: true });
  let meta = readJSON(part + '.json');
  const maxTries = o.tries || 6;
  for (let attempt = 1; ; attempt++) {
    if (o.signal && o.signal.aborted) throw err('CANCELLED', 'Cancelled');
    const have = sizeOf(part);
    if (o.size && have === o.size) break;                                    // complete part: verify, don't ask again
    if (o.size && have > o.size) fs.rmSync(part, { force: true });
    try {
      await fetchOnce(o, part, meta, o.size);
      break;
    } catch (e) {
      if (e.code === 'CANCELLED' || (o.signal && o.signal.aborted)) throw err('CANCELLED', 'Cancelled');
      if (['BLOCKED_HOST', 'REDIRECTS', 'TOO_BIG'].includes(e.code)) { fs.rmSync(part, { force: true }); throw e; }
      if (e.code === 'HTTP' && /4\d\d/.test(e.message) && !/408|429/.test(e.message)) throw e;
      if (attempt >= maxTries) throw e;
      o.log && o.log(`download attempt ${attempt} failed: ${e.message}`);
      meta = readJSON(part + '.json');
      await sleep(Math.min(16000, (o.backoffMs || 1000) * 2 ** (attempt - 1)), o.signal);
    }
  }
  if (o.onPhase) o.onPhase('verify');
  const sum = await sha256File(part);
  if (sum !== o.sha256) {
    fs.rmSync(part, { force: true }); fs.rmSync(part + '.json', { force: true });
    throw err('SHA_MISMATCH', `The downloaded file does not match AeroGyan's published SHA-256 (got ${sum.slice(0, 12)}…, expected ${o.sha256.slice(0, 12)}…). It was deleted and NOT installed.`);
  }
  fs.renameSync(part, o.dest);
  fs.rmSync(part + '.json', { force: true });
  return o.dest;
}

module.exports = { download, sha256File };
