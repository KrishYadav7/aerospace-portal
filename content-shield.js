/* ============================================================
   AEROGYAN CONTENT SHIELD — site-wide capture deterrence
   (2026-10-04)
   ------------------------------------------------------------
   What a web page CAN do, and this file does:
     1. Black-out cover the instant a screenshot shortcut is
        pressed (PrintScreen, Win+Shift+S, Cmd+Shift+3/4/5/6,
        Ctrl+Shift+S) and poison the clipboard.
     2. Cover all content while the window loses focus or the
        tab is hidden (Snipping Tool / screen-capture overlays
        take focus; mobile app-switcher thumbnails are blank).
     3. Personal tiled watermark (name · username · date) on
        every logged-in page, so any photo or capture that does
        get through identifies who leaked it.
     4. Printing disabled (Ctrl/Cmd+P and the print stylesheet).
     5. No right-click, text selection, drag-to-desktop, copy,
        view-source or DevTools shortcuts outside form fields.
     6. Browser screen-recording API (getDisplayMedia) blocked.
     7. Every capture attempt is logged on the server against
        the student's account (visible to admins).

   What NO website can do: stop a phone camera, stop OS-level
   capture on every device (e.g. Android/iOS screenshot buttons,
   macOS Cmd+Shift+3 fires before the page is told), or remove
   hardware/HDMI capture. The watermark is the answer to those.
   ============================================================ */
(function () {
  'use strict';
  if (window.__AERO_SHIELD__) return;
  window.__AERO_SHIELD__ = true;

  const CFG = Object.assign({
    coverOnBlur: true,        // hide content when the window loses focus
    watermark: true,          // personal tiled watermark for logged-in users
    report: true              // log capture attempts to the server
  }, window.AERO_SHIELD_CONFIG || {});

  const ALLOW_SEL = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], .allow-select, .pdfv-pages, .quiz-answer-input';

  function currentUser() {
    try { return JSON.parse(sessionStorage.getItem('aero_user') || 'null'); } catch (e) { return null; }
  }
  function isAdmin() {
    const u = currentUser();
    return !!(u && String(u.role || '').toLowerCase() === 'admin');
  }

  /* ---------- 1. Styles ---------- */
  const css = `
    html.aero-shield body { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
    html.aero-shield :is(${ALLOW_SEL}), html.aero-shield :is(${ALLOW_SEL}) * { -webkit-user-select: text; user-select: text; }
    html.aero-shield img, html.aero-shield canvas, html.aero-shield video { -webkit-user-drag: none; user-drag: none; }
    #aeroShieldCover {
      position: fixed; inset: 0; z-index: 2147483647; display: none;
      align-items: center; justify-content: center; flex-direction: column; gap: 12px;
      background: radial-gradient(circle at 50% 40%, #1e1b4b 0%, #0b1226 70%); color: #e2e8f0;
      font: 500 15px Inter, system-ui, sans-serif; text-align: center; padding: 24px; cursor: pointer;
    }
    #aeroShieldCover.on { display: flex; }
    #aeroShieldCover .s-ic { width: 64px; height: 64px; border-radius: 18px; display: flex; align-items: center; justify-content: center;
      background: linear-gradient(135deg, #6366f1, #06b6d4); font-size: 28px; box-shadow: 0 10px 30px rgba(99,102,241,.4); }
    #aeroShieldCover strong { font-size: 19px; color: #fff; }
    #aeroShieldCover small { color: #94a3b8; font-size: 13px; max-width: 420px; line-height: 1.5; }
    #aeroShieldWm {
      position: fixed; inset: 0; z-index: 2147482000; pointer-events: none; background-repeat: repeat;
    }
    @media print {
      html body > * { display: none !important; }
      html body::before {
        content: "Printing is disabled on AeroGyan to protect course content.";
        display: block !important; margin: 40vh auto 0; text-align: center; font: 600 18px sans-serif; color: #111;
      }
    }
  `;
  const style = document.createElement('style');
  style.id = 'aeroShieldStyle';
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
  document.documentElement.classList.add('aero-shield');

  /* ---------- 2. Cover ---------- */
  let cover = null, coverTimer = null, coverReason = '';
  function ensureCover() {
    if (cover || !document.body) return cover;
    cover = document.createElement('div');
    cover.id = 'aeroShieldCover';
    cover.setAttribute('role', 'alert');
    cover.innerHTML = '<div class="s-ic">🔒</div><strong>Content protected</strong><small id="aeroShieldMsg"></small>';
    cover.addEventListener('click', () => hide(true));
    document.body.appendChild(cover);
    return cover;
  }
  function show(reason, ms) {
    if (!ensureCover()) return;
    coverReason = reason;
    const msg = cover.querySelector('#aeroShieldMsg');
    if (msg) {
      msg.textContent = reason === 'capture'
        ? 'Screenshots and screen recording are not permitted on AeroGyan. This attempt has been recorded.'
        : 'Content is hidden while AeroGyan is not the active window. Click here or return to continue.';
    }
    cover.classList.add('on');
    clearTimeout(coverTimer);
    if (ms) coverTimer = setTimeout(() => hide(false), ms);
  }
  function hide(force) {
    if (!cover) return;
    if (!force && coverReason === 'capture' && coverTimer) return;
    clearTimeout(coverTimer); coverTimer = null;
    cover.classList.remove('on');
    coverReason = '';
  }

  /* ---------- 3. Report ---------- */
  let lastReport = 0;
  function report(kind) {
    if (!CFG.report) return;
    const now = Date.now();
    if (now - lastReport < 8000) return;
    lastReport = now;
    let token = null;
    try { token = sessionStorage.getItem('aero_token'); } catch (e) {}
    if (!token) return;
    try {
      fetch('/api/security/capture-attempt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ kind, path: (location.hash || location.pathname).slice(0, 120) }),
        keepalive: true
      }).catch(() => {});
    } catch (e) {}
  }

  function poisonClipboard() {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText('Content protected — screenshots are not permitted on AeroGyan.').catch(() => {});
      }
    } catch (e) {}
  }

  function onCapture(kind) {
    show('capture', 2500);
    poisonClipboard();
    report(kind);
  }

  /* ---------- 4. Keyboard ---------- */
  function inField(t) {
    return !!(t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
  }
  document.addEventListener('keydown', (e) => {
    const k = e.key || '';
    const mod = e.metaKey || e.ctrlKey;
    if (k === 'PrintScreen' || e.keyCode === 44) { e.preventDefault(); onCapture('printscreen'); return; }
    if (e.shiftKey && (e.metaKey || e.ctrlKey) && ['3', '4', '5', '6', 's', 'S'].includes(k)) {
      e.preventDefault(); e.stopPropagation(); onCapture('shortcut'); return;
    }
    if (mod && (k === 'p' || k === 'P')) { e.preventDefault(); e.stopPropagation(); onCapture('print'); return; }
    if (mod && !e.shiftKey && (k === 's' || k === 'S' || k === 'u' || k === 'U')) { e.preventDefault(); e.stopPropagation(); return; }
    if (k === 'F12' || (mod && e.shiftKey && ['I', 'J', 'C', 'i', 'j', 'c'].includes(k)) ||
        (e.metaKey && e.altKey && ['I', 'J', 'C', 'i', 'j', 'c'].includes(k))) {
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (mod && (k === 'c' || k === 'C' || k === 'x' || k === 'X') && !inField(e.target) && !allowedSelection()) {
      e.preventDefault();
    }
  }, true);
  /* Windows only reports PrintScreen on key-UP */
  document.addEventListener('keyup', (e) => {
    if (e.key === 'PrintScreen' || e.keyCode === 44) { e.preventDefault(); onCapture('printscreen'); }
  }, true);

  function allowedSelection() {
    try {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return false;
      const n = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
      return !!(n && n.closest && n.closest(ALLOW_SEL));
    } catch (e) { return false; }
  }

  /* ---------- 5. Mouse / clipboard ---------- */
  document.addEventListener('contextmenu', (e) => { if (!inField(e.target)) e.preventDefault(); }, true);
  document.addEventListener('dragstart', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'IMG' || t.tagName === 'CANVAS' || t.tagName === 'VIDEO' || t.tagName === 'A')) e.preventDefault();
  }, true);
  ['copy', 'cut'].forEach(evt => document.addEventListener(evt, (e) => {
    if (inField(e.target)) return;
    if (document.querySelector('#pdfViewerModal.active') && allowedSelection()) return;   // PDF viewer has its own copy rules
    e.preventDefault();
  }, true));
  window.addEventListener('beforeprint', () => { report('print'); });

  /* ---------- 6. Focus / visibility ---------- */
  let lastFsChange = 0;
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(ev =>
    document.addEventListener(ev, () => { lastFsChange = Date.now(); }));
  let suspendedUntil = 0;

  function blurCoverAllowed() {
    if (!CFG.coverOnBlur) return false;
    if (isAdmin()) return false;                       // admins manage files / open pickers all day
    if (Date.now() < suspendedUntil) return false;
    if (Date.now() - lastFsChange < 1200) return false; // fullscreen toggles fire blur+focus
    return true;
  }
  window.addEventListener('blur', () => {
    if (!blurCoverAllowed()) return;
    /* Clicking into an embedded player (YouTube iframe) also blurs the
       window — that's not leaving the site, so don't cover. */
    setTimeout(() => {
      const a = document.activeElement;
      if (a && a.tagName === 'IFRAME') return;
      if (document.hasFocus && document.hasFocus()) return;
      show('focus');
    }, 0);
  });
  window.addEventListener('focus', () => { if (coverReason === 'focus') hide(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (blurCoverAllowed() || CFG.coverOnBlur) show('focus'); }
    else if (coverReason === 'focus') setTimeout(() => hide(true), 120);
  });
  /* File pickers blur the window — callers can pause the focus cover. */
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest && e.target.closest('input[type="file"], label');
    if (t && (t.matches('input[type="file"]') || t.querySelector('input[type="file"]'))) suspendedUntil = Date.now() + 60000;
  }, true);
  document.addEventListener('change', (e) => {
    if (e.target && e.target.matches && e.target.matches('input[type="file"]')) suspendedUntil = Date.now() + 1500;
  }, true);

  /* ---------- 7. Screen-recording API ---------- */
  try {
    const md = navigator.mediaDevices;
    if (md && typeof md.getDisplayMedia === 'function' && !md.__aeroShielded) {
      md.getDisplayMedia = function () {
        onCapture('screen-record');
        return Promise.reject(new DOMException('Screen capture is disabled on AeroGyan.', 'NotAllowedError'));
      };
      md.__aeroShielded = true;
    }
  } catch (e) {}

  /* ---------- 8. Personal watermark ---------- */
  let wm = null, wmKey = '';
  function wmSvg(text) {
    const esc = String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const dark = /dark|dim/.test(document.documentElement.getAttribute('data-theme') || '');
    const fill = dark ? 'rgba(255,255,255,0.07)' : 'rgba(15,23,42,0.06)';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="260">' +
      '<text x="210" y="130" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="13" font-weight="600" fill="' + fill + '" ' +
      'transform="rotate(-24 210 130)">' + esc + '</text></svg>';
    return 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")';
  }
  function syncWatermark() {
    if (!CFG.watermark || !document.body) return;
    const u = currentUser();
    if (!u || isAdmin()) { if (wm) { wm.remove(); wm = null; wmKey = ''; } return; }
    const d = new Date();
    const text = (u.fullName || u.username || 'Student') + ' · @' + (u.username || '') + ' · ' +
      d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const key = text + '|' + (document.documentElement.getAttribute('data-theme') || '');
    if (!wm) {
      wm = document.createElement('div');
      wm.id = 'aeroShieldWm';
      wm.setAttribute('aria-hidden', 'true');
      document.body.appendChild(wm);
    }
    if (key !== wmKey) { wm.style.backgroundImage = wmSvg(text); wmKey = key; }
  }
  /* Keep it present: logins, logouts, theme changes, and anyone deleting it in DevTools */
  function boot() {
    ensureCover();
    syncWatermark();
    setInterval(syncWatermark, 5000);
    try {
      new MutationObserver(() => { if (wm && !document.body.contains(wm)) { wm = null; wmKey = ''; syncWatermark(); } })
        .observe(document.body, { childList: true });
      new MutationObserver(syncWatermark).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.AeroShield = {
    cover: show, uncover: () => hide(true), refreshWatermark: syncWatermark,
    suspend(ms) { suspendedUntil = Date.now() + (ms || 30000); }
  };
})();
