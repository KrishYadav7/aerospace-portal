/* ============================================================
   Self-test — `electron . --aero-selftest=<folder> --catalog=<fake catalogue>` (test/smoke.js runs it,
   locally and on every CI system). Checks the window lists the catalogue's apps, the words switch to
   Hindi, search works, and the download + SHA-256 check:
     good      → downloaded and accepted
     tampered  → rejected (SHA_MISMATCH), the file deleted — also through the real Install button
     nosha     → refused before downloading (NO_SHA)
     badhost   → refused before any request (BLOCKED_HOST)
   Writes report.txt / report.json (+ screenshots) and quits: exit code 0 = all passed.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms, every = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(every); }
  return null;
}

exports.run = async function run(ctx) {
  const { app, dir, getWindow, loadCatalog, appById, targetOf, fetchVerified, log } = ctx;
  fs.mkdirSync(dir, { recursive: true });
  const lines = []; const results = []; let problems = 0;
  const rec = (status, name, detail) => {
    if (status === 'FAIL') problems++;
    results.push({ status, name, detail: detail || '' });
    lines.push(`${status.padEnd(5)} ${name}${detail ? ' — ' + detail : ''}`);
    log('[selftest]', status, name, detail || '');
  };
  const pass = (n, d) => rec('PASS', n, d), fail = (n, d) => rec('FAIL', n, d), info = (n, d) => rec('info', n, d);
  let done = false;
  const finish = () => {
    if (done) return; done = true;
    lines.push('', `RESULT: ${problems === 0 ? 'all checks passed' : problems + ' problem(s) found'}`);
    fs.writeFileSync(path.join(dir, 'report.txt'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ problems, results }, null, 1));
    setTimeout(() => app.exit(problems ? 1 : 0), 200);
  };
  setTimeout(() => { fail('finished in time', 'stopped after 150 s'); finish(); }, 150000);
  const shot = async (wc, name) => { try { fs.writeFileSync(path.join(dir, name), (await wc.capturePage()).toPNG()); } catch (e) { info('screenshot', e.message); } };

  try {
    info('version', `AeroGyan Store ${app.getVersion()} · Electron ${process.versions.electron} · ${process.platform} ${process.arch}`);
    info('catalogue', ctx.catalogUrl);
    const win = await waitUntil(() => getWindow(), 10000);
    if (!win) { fail('window opens'); return finish(); }
    const wc = win.webContents;
    const js = (code) => wc.executeJavaScript(code, true);
    const ready = await waitUntil(() => js('document.body.dataset.ready === "1"'), 30000);
    if (!ready) { fail('catalogue shown', await js('document.getElementById("notice").textContent').catch(() => '')); await shot(wc, 'not-ready.png'); return finish(); }
    pass('window opens and loads the catalogue');
    const { catalog } = await loadCatalog(false);
    const want = catalog.apps.map((a) => a.name);

    // first run: the role picker, then the All tab lists every app
    (await js('!document.getElementById("welcome").hidden')) ? pass('first run asks who uses the computer') : fail('first run asks who uses the computer');
    await js('document.querySelector("#wRoles button:nth-child(3)").click()');
    (await waitUntil(() => js('getComputedStyle(document.getElementById("welcome")).display === "none"'), 5000)) ? pass('picking a role closes the welcome') : fail('picking a role closes the welcome');
    await js('document.getElementById("tab-all").click()');
    await sleep(300);
    const names = await js('[...document.querySelectorAll(".card .c-name")].map((x) => x.textContent)');
    const missing = want.filter((n) => !names.includes(n));
    (names.length === want.length && !missing.length) ? pass('All lists every app of the catalogue', `${names.length} cards`) : fail('All lists every app', `${names.length} cards, want ${want.length}; missing ${missing.join(', ')}`);
    await shot(wc, '01-all.png');

    // search
    await js('(() => { const q = document.getElementById("q"); q.value = "tampered"; q.dispatchEvent(new Event("input")); })()');
    await sleep(150);
    const n1 = await js('document.querySelectorAll(".card").length');
    n1 === 1 ? pass('search filters the list') : fail('search filters the list', `${n1} cards`);
    await js('(() => { const q = document.getElementById("q"); q.value = ""; q.dispatchEvent(new Event("input")); })()');

    // Hindi
    await js('document.querySelector("#langGroup [data-lang=hi]").click()');
    await sleep(200);
    const hi = await js('document.getElementById("brandName").textContent + "|" + document.getElementById("tab-all").textContent');
    hi === 'एरोज्ञान स्टोर|सभी ऐप' ? pass('Hindi words', hi) : fail('Hindi words', hi);
    await shot(wc, '02-hindi.png');
    await js('document.querySelector("#langGroup [data-lang=en]").click()');

    // the download + SHA-256 check (main process code, the same the Install button uses)
    const tryFetch = async (id) => {
      const a = appById(id); const t = a && targetOf(a);
      if (!t) return { code: 'NO_TARGET' };
      try { const fp = await fetchVerified(a, t.plat, t.file, new AbortController(), null, null); return { fp }; } catch (e) { return { code: e.code, message: e.message, dest: path.join(app.getPath('userData'), 'downloads') }; }
    };
    let r = await tryFetch('good');
    (r.fp && fs.existsSync(r.fp)) ? pass('good file: downloaded and accepted', path.basename(r.fp)) : fail('good file accepted', JSON.stringify(r));
    r = await tryFetch('tampered');
    const left = fs.readdirSync(path.join(app.getPath('userData'), 'downloads')).filter((f) => /tamper/i.test(f));
    (r.code === 'SHA_MISMATCH' && /does not match/.test(r.message) && !left.length) ? pass('tampered file: rejected and deleted', r.message.slice(0, 80) + '…') : fail('tampered file rejected', JSON.stringify(r) + ' left: ' + left.join(','));
    r = await tryFetch('nosha');
    r.code === 'NO_SHA' ? pass('file without a SHA-256: refused') : fail('file without a SHA-256 refused', JSON.stringify(r));
    r = await tryFetch('badhost');
    (r.code === 'BLOCKED_HOST' && /not an AeroGyan server/.test(r.message)) ? pass('file on another server: refused before download', r.message) : fail('other server refused', JSON.stringify(r));
    const hits = await new Promise((resolve) => require('http').get(new URL('/hits', ctx.catalogUrl).toString(), (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)); }).on('error', () => resolve('')));
    /evil/.test(hits) ? fail('no request to the other server', hits) : pass('no request reached the other server');

    // through the window: Install on the tampered app shows the mismatch message
    await js('(() => { const q = document.getElementById("q"); q.value = "tampered"; q.dispatchEvent(new Event("input")); })()');
    await sleep(150);
    await js('document.querySelector(".card .btn.primary").click()');
    const toast = await waitUntil(() => js('[...document.querySelectorAll(".toast.error")].map((x) => x.textContent).join(" ")'), 20000);
    (toast && /did not match/.test(toast)) ? pass('Install button: tampered file → clear message', toast.slice(0, 90)) : fail('Install button: tampered message', String(toast));
    await shot(wc, '03-tampered.png');
    await js('(() => { const q = document.getElementById("q"); q.value = "No Hash"; q.dispatchEvent(new Event("input")); })()');
    await sleep(150);
    await js('document.querySelector(".card .btn.primary").click()');
    const toast2 = await waitUntil(() => js('[...document.querySelectorAll(".toast.error")].map((x) => x.textContent).join(" ")').then((s) => /cannot be checked/.test(s) && s), 20000);
    toast2 ? pass('Install button: no SHA-256 → refused, website offered') : fail('Install button: no SHA-256 message');
    // the detail pane opens and closes with the keyboard
    await js('document.querySelector(".card").click()');
    await sleep(200);
    const open = await js('!document.getElementById("detail").hidden && document.activeElement.id === "dClose"');
    await js('document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}))');
    const closed = await js('document.getElementById("detail").hidden && getComputedStyle(document.getElementById("detail")).display === "none"');
    (open && closed) ? pass('detail pane: focus moves in, Escape closes') : fail('detail pane keyboard', `${open} ${closed}`);
    // ⭐ 1.0.2 — the store's own update: a banner at the top with a big button
    await js('(() => { const q = document.getElementById("q"); q.value = ""; q.dispatchEvent(new Event("input")); })()');
    await sleep(150);
    const su = await js('(() => { const b = document.getElementById("selfUp"); return !b.hidden && getComputedStyle(b).display !== "none" ? document.getElementById("suTitle").textContent + " | " + document.getElementById("suBtn").textContent : ""; })()');
    /9\.9\.9/.test(su) && /Update now/.test(su) ? pass('a newer store: the update banner shows', su) : fail('store update banner', su);
    await shot(wc, '04-selfupdate.png');
    // ⭐ 1.0.2 — no installer for this computer: listed with a working "Open in browser" button, never hidden
    const web = await js('(() => { const c = document.querySelector(\'.card[data-id="webonly"]\'); const b = c && c.querySelector("button.web-open"); return b ? b.textContent : ""; })()');
    web === 'Open in browser' ? pass('a web-only app: listed with Open in browser') : fail('web-only app button', web);
    // ⭐ 1.0.2 — an install id that is not ours (not built in, not in the signed manifest): shown, never installable
    const st = appById('stranger');
    (st && !targetOf(st)) ? pass('an untrusted install id is removed (web only)') : fail('untrusted install id removed', JSON.stringify(st && st.platforms));
  } catch (e) {
    fail('self-test ran', e.stack || e.message);
  }
  finish();
};
