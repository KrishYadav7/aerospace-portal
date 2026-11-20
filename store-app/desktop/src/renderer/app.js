/* AeroGyan Store — the window (sandboxed; talks to the main process only through window.store). */
'use strict';
(function () {
  const S = window.store;
  const $ = (id) => document.getElementById(id);
  let st = { lang: 'en', role: '', os: 'windows' };
  let data = null;                 // {apps, installed, updates, targets, from, error, busy}
  let tab = 'foryou';
  let q = '';
  let openId = '';
  let lastFocus = null;
  const busy = new Map();          // id → {phase, received, total}

  /* ---------------------------------------------------------------- words */
  const t = (k, v) => {
    let s = (window.T[st.lang] && window.T[st.lang][k]) || window.T.en[k] || k;
    if (v) for (const [a, b] of Object.entries(v)) s = s.split('{' + a + '}').join(String(b));
    return s;
  };
  const nm = (a) => (st.lang === 'hi' && a.nameHi) || a.name;
  const ln = (a) => (st.lang === 'hi' && a.lineHi) || a.line || '';
  const desc = (a) => (st.lang === 'hi' && a.descriptionHi) || a.description || '';
  const size = (n) => { n = Number(n || 0); if (!n) return ''; return n >= 1048576 ? (n / 1048576).toFixed(n >= 104857600 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; };
  const date = (s) => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleDateString(st.lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); };

  /* element helper — text only, never HTML from the catalogue */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }

  function icon(a, px) {
    const box = h('div', { class: 'app-icon', 'aria-hidden': 'true' });
    box.style.setProperty('--c', /^#[0-9a-f]{3,8}$/i.test(a.color || '') ? a.color : '#4F46E5');
    box.style.setProperty('--s', px + 'px');
    const letter = h('span', { class: 'letter', text: (a.short || a.name || '?').replace(/^AeroGyan\s+/, '').charAt(0).toUpperCase() });
    box.append(letter);
    if (a.icon && /^https:\/\/([a-z0-9-]+\.)*aerogyan\.tech\//.test(a.icon)) {
      const img = h('img', { src: a.icon, alt: '', width: px, height: px, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
      img.addEventListener('load', () => box.classList.add('has-img'));
      img.addEventListener('error', () => img.remove());
      box.append(img);
    }
    return box;
  }

  /* ---------------------------------------------------------------- what an app can do here */
  function info(a) {
    const inst = (data.installed && data.installed[a.id]) || { installed: false };
    const tg = (data.targets && data.targets[a.id]) || { status: 'web' };
    const file = tg.plat ? a.platforms[tg.plat] : null;
    const update = data.updates.includes(a.id);
    return { inst, status: tg.status, plat: tg.plat, file, update, job: busy.get(a.id) };
  }

  function primary(a, i, big) {
    const B = (cls, label, fn, extra) => h('button', Object.assign({ type: 'button', class: 'btn ' + cls, onclick: (e) => { e.stopPropagation(); fn(); } }, extra || {}), label);
    if (i.job) {
      const pct = i.job.total ? Math.min(100, Math.round(i.job.received / i.job.total * 100)) : 0;
      const label = i.job.phase === 'verify' ? t('verifying') : i.job.phase === 'install' ? t('installing') : t('downloading', { p: pct });
      const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, h('i'));
      bar.firstChild.style.width = (i.job.phase === 'download' ? pct : 100) + '%';
      if (i.job.phase !== 'download') bar.classList.add('indet');
      return h('div', { class: 'job' }, h('span', { class: 'job-l', text: label }), bar,
        i.job.phase === 'download' ? B('ghost small', t('cancel'), () => S.cancel(a.id), { 'aria-label': t('cancel') + ' — ' + nm(a) }) : null);
    }
    if (a.id === 'store') return i.update ? B('primary', t('update'), () => doInstall(a)) : h('span', { class: 'pill ok', text: t('installedV', { v: i.inst.version || '' }) });
    if (i.inst.installed && i.update && i.status === 'ready') return B('primary', t('update'), () => doInstall(a), { 'aria-label': t('update') + ' ' + nm(a) });
    if (i.inst.installed) return B('tonal', t('open'), () => act(() => S.open(a.id)), { 'aria-label': t('open') + ' ' + nm(a) });
    if (i.status === 'ready') return B('primary', t('install'), () => doInstall(a), { 'aria-label': t('install') + ' ' + nm(a) });
    if (i.status === 'pack') return B('ghost', t('getPack'), () => showDetail(a.inPacks[0] && byId(a.inPacks[0]) ? a.inPacks[0] : a.id));
    if (i.status === 'soon') return h('span', { class: 'pill', text: t('soon') });
    return big ? B('tonal', t('openBrowser'), () => act(() => S.web(a.id))) : h('span', { class: 'pill', text: t('web') });
  }

  /* ---------------------------------------------------------------- the grid */
  const byId = (id) => data && data.apps.find((a) => a.id === id);
  function matches(a) {
    if (!q) return true;
    const s = [a.name, a.nameHi, a.line, a.lineHi, a.short, a.category, (a.features || []).join(' ')].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).every((w) => s.includes(w));
  }
  function forYou(a) {
    const r = st.role || 'everyone';
    const aud = a.audience || [];
    if (a.kind === 'store') return false;
    if (r === 'everyone') return a.kind !== 'office' && (a.kind !== 'pack');
    if (a.kind === 'office') return info(a).inst.installed;          // single Office apps: the pack is the suggestion; installed ones stay
    return aud.includes(r) || aud.includes('everyone') || a.featured;
  }
  function groupOf(a) {
    if (a.kind === 'store') return 'group_store';
    if (a.id === 'aerogyan') return 'group_main';
    if (a.kind === 'pack') return 'group_packs';
    if (a.kind === 'office') return (a.audience || []).includes('student') ? 'group_stu' : 'group_prof';
    return 'group_more';
  }
  const ORDER = ['group_main', 'group_packs', 'group_more', 'group_stu', 'group_prof', 'group_store'];

  function card(a) {
    const i = info(a);
    const meta = [];
    if (i.file && i.file.version) meta.push(i.update ? t('newV', { v: i.file.version }) : 'v' + i.file.version);
    if (i.file && i.file.size) meta.push(size(i.file.size));
    if (a.kind === 'pack' && a.includes) meta.push(t('packOf', { n: a.includes.length }));
    const c = h('article', { class: 'card' + (i.update ? ' has-update' : ''), 'data-id': a.id, tabindex: '0', role: 'button', 'aria-label': nm(a) + (ln(a) ? ' — ' + ln(a) : ''),
      onclick: () => showDetail(a.id), onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === c) { e.preventDefault(); showDetail(a.id); } } },
      icon(a, 52),
      h('div', { class: 'c-main' },
        h('h3', { class: 'c-name', text: nm(a) }),
        h('p', { class: 'c-line', text: ln(a) }),
        h('p', { class: 'c-meta' }, meta.join(' · '), i.inst.installed && a.id !== 'store' ? h('span', { class: 'pill ok tiny', text: t('installedV', { v: i.inst.version || '' }) }) : null)),
      h('div', { class: 'c-act' }, primary(a, i, false)));
    return c;
  }

  function render() {
    if (!data) return;
    const grid = $('grid');
    const keep = document.activeElement && document.activeElement.closest('.card') ? document.activeElement.closest('.card').dataset.id : '';
    grid.textContent = '';
    let list = data.apps.filter(matches);
    if (tab === 'foryou' && !q) list = list.filter(forYou);
    if (tab === 'updates') list = list.filter((a) => data.updates.includes(a.id));
    const ups = data.updates.length;
    $('upCount').hidden = !ups; $('upCount').textContent = String(ups);
    const upAll = $('updateAll');
    upAll.hidden = !(tab === 'updates' && ups) && !(ups > 1);
    upAll.textContent = t('updateAll', { n: ups });
    if (!list.length) {
      $('empty').hidden = false;
      $('empty').textContent = q ? t('emptySearch', { q }) : tab === 'updates' ? t('emptyUpdates') : t('empty');
    } else $('empty').hidden = true;
    const groups = {};
    for (const a of list) (groups[groupOf(a)] = groups[groupOf(a)] || []).push(a);
    for (const g of ORDER) {
      if (!groups[g]) continue;
      const sec = h('section', { class: 'group', 'aria-labelledby': 'g-' + g }, h('h2', { id: 'g-' + g, class: 'g-title', text: t(g) }));
      const wrap = h('div', { class: 'cards' });
      for (const a of groups[g]) wrap.append(card(a));
      sec.append(wrap);
      grid.append(sec);
    }
    grid.setAttribute('aria-busy', 'false');
    if (keep) { const el = grid.querySelector(`.card[data-id="${CSS.escape(keep)}"]`); if (el) el.focus(); }
    if (openId) renderDetail();
  }

  /* ---------------------------------------------------------------- detail */
  function showDetail(id) {
    if (!byId(id)) return;
    lastFocus = document.activeElement;
    openId = id;
    $('detail').hidden = false; $('scrim').hidden = false;
    renderDetail();
    $('dClose').focus();
  }
  function closeDetail() {
    openId = ''; $('detail').hidden = true; $('scrim').hidden = true;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }
  function renderDetail() {
    const a = byId(openId);
    if (!a) return closeDetail();
    const i = info(a);
    $('dIcon').textContent = ''; $('dIcon').append(icon(a, 88));
    $('dName').textContent = nm(a);
    $('dLine').textContent = ln(a);
    const acts = $('dActions'); acts.textContent = '';
    acts.append(primary(a, i, true));
    if (i.inst.installed && i.update && i.status === 'ready' && !i.job && a.id !== 'store') acts.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => act(() => S.open(a.id)) }, t('open')));
    if (a.web) acts.append(h('button', { type: 'button', class: 'btn ghost', onclick: () => act(() => S.web(a.id)) }, t('website')));
    if (i.inst.installed && a.id !== 'store' && !i.job) acts.append(h('button', { type: 'button', class: 'btn danger-ghost', onclick: () => doUninstall(a) }, t('uninstall')));

    const body = $('dBody'); body.textContent = '';
    if (i.status === 'pack') {
      const p = byId(a.inPacks[0]);
      body.append(h('div', { class: 'callout' }, t('inPack', { n: nm(a), p: p ? nm(p) : a.inPacks[0] }), ' ',
        p ? h('button', { type: 'button', class: 'link', onclick: () => showDetail(p.id) }, t('seePack')) : null));
    } else if (i.status === 'web') body.append(h('div', { class: 'callout' }, t('notOnThis', { n: nm(a) })));
    if (desc(a)) body.append(h('h3', { text: t('about') }), h('p', { text: desc(a) }));
    if (a.features && a.features.length) body.append(h('h3', { text: t('features') }), h('ul', { class: 'feat' }, a.features.map((f) => h('li', { text: f }))));
    if (i.file && i.file.notes) body.append(h('h3', { text: t('whatsNew') }), h('p', { class: 'notes', text: i.file.notes }));
    if (a.includes && a.includes.length) {
      body.append(h('h3', { text: t('includes') }), h('div', { class: 'chips' }, a.includes.map((x) => {
        const o = byId(x);
        return o ? h('button', { type: 'button', class: 'chip', onclick: () => showDetail(o.id) }, nm(o).replace(/^एरोज्ञान\s+|^AeroGyan\s+/, '')) : null;
      })));
    }
    // Linux: .deb or AppImage
    if (st.os === 'linux' && a.platforms.deb && a.platforms.linux && a.platforms.deb.available && a.platforms.linux.available && st.hasDpkg && a.id !== 'store') {
      const fs = h('fieldset', { class: 'fmt' }, h('legend', { text: t('linuxFormat') }));
      for (const [v, lbl] of [['deb', t('deb')], ['linux', t('appimage')]]) {
        const inp = h('input', { type: 'radio', name: 'fmt', value: v, checked: i.plat === v, onchange: async () => { await S.pref('linuxFormat', { id: a.id, format: v }); load(false); } });
        fs.append(h('label', {}, inp, ' ', lbl));
      }
      body.append(fs);
    }
    const rows = [];
    if (i.file && i.file.version) rows.push([t('version'), i.file.version]);
    if (i.inst.installed && i.inst.version) rows.push([t('yourVersion'), i.inst.version]);
    if (i.file && i.file.size) rows.push([t('size'), size(i.file.size)]);
    if (i.file && i.file.updatedAt) rows.push([t('updated'), date(i.file.updatedAt)]);
    if (i.file && i.file.fileName) rows.push([t('fileType'), i.file.fileName]);
    if (rows.length) body.append(h('dl', { class: 'facts' }, rows.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])));
    body.append(h('p', { class: 'muted small', text: t('verified') }));
  }

  /* ---------------------------------------------------------------- actions */
  function toast(msg, kind, action) {
    const el = h('div', { class: 'toast ' + (kind || ''), role: kind === 'error' ? 'alert' : 'status' }, h('span', { text: msg }), action || null,
      h('button', { type: 'button', class: 'icon-btn tiny', 'aria-label': 'Close', onclick: () => el.remove() }, '×'));
    $('toasts').append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 14000 : 6000);
  }
  async function act(fn) {
    const r = await fn();
    if (r && !r.ok) toast(r.message, 'error');
    return r;
  }
  async function doInstall(a) {
    const wasInstalled = info(a).inst.installed;
    busy.set(a.id, { phase: 'download', received: 0, total: 0 });
    render();
    const r = await S.install(a.id);
    busy.delete(a.id);
    if (r.ok) {
      const v = r.value || {};
      if (v.restarting) toast(t('restarting'), 'ok');
      else if (v.message === 'manual') toast(t('manual', { n: nm(a) }), 'info');
      else toast(wasInstalled ? t('updatedOk', { n: nm(a), v: v.version || '' }) : t('done', { n: nm(a) }), 'ok');
    } else if (r.code === 'CANCELLED') toast(t('cancelled'), 'info');
    else if (r.code === 'NO_SHA') toast(t('noSha'), 'error', h('button', { type: 'button', class: 'link', onclick: () => S.web(a.id, 'download') }, t('getFromSite')));
    else if (r.code === 'SHA_MISMATCH') toast(t('mismatch', { n: nm(a) }), 'error');
    else if (r.code === 'BLOCKED_HOST') toast(t('blocked'), 'error');
    else toast(t('failed', { n: nm(a), e: r.message }), 'error');
    await load(false);
  }
  async function doUninstall(a) {
    const r = await S.uninstall(a.id);
    if (!r.ok) toast(r.message, 'error');
    else if (r.value) toast(t('removed', { n: nm(a) }), 'ok');
    await load(false);
  }
  async function updateAll() {
    for (const id of data.updates.filter((x) => x !== 'store')) { const a = byId(id); if (a && !busy.has(id)) await doInstall(a); }
    if (data.updates.includes('store')) await doInstall(byId('store'));
  }

  /* ---------------------------------------------------------------- loading */
  async function load(refresh) {
    const r = await S.catalog(refresh);
    const n = $('notice');
    if (!r.ok) {
      $('grid').setAttribute('aria-busy', 'false');
      n.hidden = false; n.className = 'notice error'; n.textContent = t('loadFail', { e: r.message }) + ' ';
      n.append(h('button', { type: 'button', class: 'link', onclick: () => load(true) }, t('retry')));
      return;
    }
    data = r.value;
    for (const id of data.busy || []) if (!busy.has(id)) busy.set(id, { phase: 'download', received: 0, total: 0 });
    if (data.from === 'cache') { n.hidden = false; n.className = 'notice'; n.textContent = t('offline', { d: date(data.generatedAt) }); }
    else n.hidden = true;
    render();
    document.body.dataset.ready = '1';
  }

  function applyWords() {
    document.documentElement.lang = st.lang;
    document.title = t('store');
    $('brandName').textContent = t('store'); $('brandLine').textContent = t('tagline');
    $('q').placeholder = t('search'); $('q').setAttribute('aria-label', t('search'));
    $('skipLink').textContent = t('skip');
    $('tab-foryou').textContent = t('foryou'); $('tab-all').textContent = t('all');
    $('tab-updates').querySelector('.lbl').textContent = t('updates');
    $('refresh').setAttribute('aria-label', t('checkUpdates')); $('refresh').title = t('checkUpdates');
    $('autoUpLbl').textContent = t('autoUpdate');
    $('roleBtn').textContent = t('role', { r: t(st.role || 'everyone') }) + ' · ' + t('changeRole');
    $('ver').textContent = t('ver', { v: st.version || '' }) + ' · ' + t('os_' + st.os);
    for (const b of document.querySelectorAll('#langGroup button')) b.setAttribute('aria-pressed', String(b.dataset.lang === st.lang));
    $('wTitle').textContent = t('welcome'); $('wLine').textContent = t('welcomeLine');
    const roles = $('wRoles'); roles.textContent = '';
    for (const r of ['student', 'professor', 'everyone']) roles.append(h('button', { type: 'button', class: 'btn tonal big', onclick: () => pickRole(r) }, t(r)));
    render();
  }
  async function pickRole(r) {
    await S.pref('role', r); st.role = r;
    $('welcome').hidden = true;
    applyWords();
    $('q').focus();
  }
  function setTab(next, focus) {
    tab = next;
    for (const b of document.querySelectorAll('[role=tab]')) {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    render();
  }

  /* ---------------------------------------------------------------- wiring */
  document.querySelectorAll('[role=tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('tabs').addEventListener('keydown', (e) => {
    const tabs = [...document.querySelectorAll('[role=tab]')];
    const i = tabs.findIndex((b) => b.dataset.tab === tab);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setTab(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].dataset.tab, true); }
  });
  $('q').addEventListener('input', (e) => { q = e.target.value.trim(); render(); });
  $('updateAll').addEventListener('click', updateAll);
  $('refresh').addEventListener('click', async () => {
    $('refresh').classList.add('spin');
    await S.check(); await load(false);
    $('refresh').classList.remove('spin');
    toast(data && data.updates.length ? t('upAvail', { n: data.updates.length }) : t('upToDate'), 'info');
  });
  $('langGroup').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-lang]'); if (!b) return;
    st.lang = b.dataset.lang; await S.pref('lang', st.lang); applyWords();
  });
  $('autoUp').addEventListener('change', (e) => S.pref('autoUpdate', e.target.checked));
  $('roleBtn').addEventListener('click', () => { $('welcome').hidden = false; $('wRoles').querySelector('button').focus(); });
  $('dClose').addEventListener('click', closeDetail);
  $('scrim').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openId) closeDetail();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('q').focus(); }
    if (e.key === 'Tab' && openId) {                                    // keep focus inside the detail
      const f = [...$('detail').querySelectorAll('button, input, [tabindex="0"]')].filter((x) => !x.disabled && x.offsetParent);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });
  let raf = 0;
  S.onProgress((p) => {
    if (p.phase === 'done') return;
    busy.set(p.id, Object.assign(busy.get(p.id) || {}, p));
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
  });
  S.onCatalog(() => load(false));
  S.onTab((x) => setTab(x));
  S.onTheme((dark) => document.documentElement.classList.toggle('dark', !!dark));

  (async () => {
    const r = await S.state();
    if (r.ok) st = Object.assign(st, r.value);
    document.documentElement.classList.toggle('dark', !!st.dark);
    document.body.classList.add('os-' + st.os);
    $('autoUp').checked = !!st.autoUpdate;
    applyWords();
    if (!st.role) { $('welcome').hidden = false; setTimeout(() => $('wRoles').querySelector('button').focus(), 50); }
    await load(false);
  })();
})();
