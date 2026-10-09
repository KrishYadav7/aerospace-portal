/* ============================================================
   ⭐ AEROGYAN NOTES (2026-10-09) — handwritten notebooks
   ------------------------------------------------------------
   Loaded on demand the first time a student opens "My Notes"
   (nobody else downloads or runs it).

   Built to stay light on CPU and memory:
   • ink is stored as vectors (delta-encoded integer points), never
     as images — a full page is usually 5–60 KB;
   • only the pages on or near the screen own a <canvas>; pages that
     scroll away give their canvas memory back immediately;
   • the paper (ruled / grid / dots) is pure CSS — zero drawing cost;
   • a pen stroke is drawn segment-by-segment straight onto the page
     canvas once per animation frame — the page is never redrawn
     while you write; only erasing / undo redraw that one page;
   • canvases are capped in pixels, so zooming in can't blow memory;
   • autosave sends just the page that changed, debounced, and keeps
     an on-device copy until the server confirms it.
   ============================================================ */
(function () {
  'use strict';
  if (window.AeroNotes) return;

  /* ---------- constants ---------- */
  const PW = 2000, PH = 2828;                 // page size in ink units (A4 ratio)
  const API = '/api/notes';
  const MAX_CANVAS_PX = 4200000;              // per page canvas (≈16 MB) — caps memory when zoomed
  const SAVE_DELAY = 1200;
  const COVERS = {
    indigo: ['#4338ca', '#7c3aed'], violet: ['#6d28d9', '#c026d3'], rose: ['#e11d48', '#fb7185'],
    amber: ['#b45309', '#f59e0b'], emerald: ['#047857', '#34d399'], teal: ['#0f766e', '#2dd4bf'],
    sky: ['#0369a1', '#38bdf8'], slate: ['#1e293b', '#64748b'], crimson: ['#881337', '#be123c'], forest: ['#14532d', '#22c55e']
  };
  const PAPERS = [
    { id: 'lined', label: 'Ruled' }, { id: 'grid', label: 'Grid' },
    { id: 'dotted', label: 'Dotted' }, { id: 'eng', label: 'Engineering' },
    { id: 'cornell', label: 'Cornell' }, { id: 'blank', label: 'Blank' }
  ];
  const PAPER_COLORS = {
    white: { label: 'White', bg: '#ffffff', rule: 'rgba(37,99,235,.17)', strong: 'rgba(37,99,235,.30)', margin: 'rgba(239,68,68,.38)', dark: false },
    cream: { label: 'Cream', bg: '#fbf6e8', rule: 'rgba(146,104,48,.20)', strong: 'rgba(146,104,48,.34)', margin: 'rgba(220,38,38,.32)', dark: false },
    night: { label: 'Night', bg: '#151a27', rule: 'rgba(148,163,184,.16)', strong: 'rgba(148,163,184,.30)', margin: 'rgba(244,114,182,.38)', dark: true }
  };
  const INKS_LIGHT = ['#111827', '#1d4ed8', '#dc2626', '#15803d', '#7e22ce', '#ea580c'];
  const INKS_DARK = ['#f8fafc', '#93c5fd', '#fca5a5', '#86efac', '#d8b4fe', '#fdba74'];
  const HILITES = ['#facc15', '#4ade80', '#60a5fa', '#f472b6', '#fb923c'];
  const SIZES = { pen: [4, 7, 12], hl: [26, 40, 60], eraser: [16, 34, 70], text: [34, 46, 64] };
  const GAP = { lined: 76, grid: 60, dotted: 60, eng: 30 };
  const MARGIN_X = 230, TOP_Y = 228;
  const CORNELL_X = 560, CORNELL_Y = PH - 560;
  const TOOL_PEN = 1, TOOL_HL = 2, TOOL_SHAPE = 3, TOOL_DASH = 4;   // 3/4 = straight-edged shapes (solid / dashed)
  /* a wide, friendly palette for "any colour" + a free picker */
  const PALETTE = [
    '#000000', '#374151', '#6b7280', '#9ca3af', '#d1d5db', '#ffffff', '#7f1d1d', '#b91c1c',
    '#ef4444', '#f87171', '#9a3412', '#ea580c', '#f97316', '#fb923c', '#a16207', '#ca8a04',
    '#eab308', '#facc15', '#3f6212', '#65a30d', '#84cc16', '#14532d', '#15803d', '#22c55e',
    '#134e4a', '#0f766e', '#14b8a6', '#164e63', '#0e7490', '#06b6d4', '#1e3a8a', '#1d4ed8',
    '#3b82f6', '#60a5fa', '#312e81', '#4f46e5', '#6366f1', '#581c87', '#7e22ce', '#a855f7',
    '#831843', '#be185d', '#ec4899', '#f9a8d4', '#78350f', '#92400e', '#b45309', '#d6a46c'
  ];
  const SHAPES = [
    { id: 'line', label: 'Line' }, { id: 'arrow', label: 'Arrow' }, { id: 'darrow', label: 'Double arrow' },
    { id: 'rect', label: 'Rectangle' }, { id: 'circle', label: 'Circle' }, { id: 'ellipse', label: 'Ellipse' },
    { id: 'triangle', label: 'Triangle' }, { id: 'rtriangle', label: 'Right triangle' }, { id: 'hexagon', label: 'Polygon' },
    { id: 'axes', label: 'X–Y axes' }, { id: 'axes3', label: '3D axes' }, { id: 'numline', label: 'Number line' },
    { id: 'parabola', label: 'Parabola' }, { id: 'sine', label: 'Sine wave' }, { id: 'angle', label: 'Angle' }
  ];
  /* tiny line icons for the shape picker (24×24) */
  const SHAPE_ICONS = {
    line: '<path d="M4 20L20 4"/>', arrow: '<path d="M4 20L20 4M11 4h9v9"/>', darrow: '<path d="M4 20L20 4M11 4h9v9M13 20H4v-9"/>',
    rect: '<rect x="3.5" y="6" width="17" height="12" rx="1"/>', circle: '<circle cx="12" cy="12" r="8.5"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="9.5" ry="6"/>', triangle: '<path d="M12 4l9 16H3z"/>', rtriangle: '<path d="M4 4v16h16z"/>',
    hexagon: '<path d="M7.5 4.2h9L21 12l-4.5 7.8h-9L3 12z"/>', axes: '<path d="M2 12h20M12 22V2M19 9l3 3-3 3M9 5l3-3 3 3"/>',
    axes3: '<path d="M10 14V2M10 14h12M10 14l-7 7M7 5l3-3 3 3M19 11l3 3-3 3"/>', numline: '<path d="M2 12h20M5 9v6M9 9v6M12 8v8M15 9v6M19 9v6"/>',
    parabola: '<path d="M4 3c2 12 5 17 8 17s6-5 8-17"/>', sine: '<path d="M2 12c2.5-8 5-8 7.5 0s5 8 7.5 0 3-6 5-6"/>', angle: '<path d="M4 19h16M4 19L16 5M10 19a6 6 0 0 0-2-4.5"/>'
  };
  const shapeSvg = (id) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SHAPE_ICONS[id] || ''}</svg>`;

  /* ---------- helpers ---------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  const toast = (m, t) => { try { (window.showToast || console.log)(m, t || 'info'); } catch (_) {} };
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (_) { return false; } };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (_) {} };
  const ago = (d) => {
    const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 7) return Math.round(s / 86400) + ' d ago';
    return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method, cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (e) { const err = new Error('offline'); err.offline = true; throw err; }
    let j = null;
    try { j = await res.json(); } catch (_) {}
    if (!res.ok || !j || j.success === false) {
      const err = new Error((j && j.message) || ('HTTP ' + res.status)); err.status = res.status; throw err;
    }
    return j;
  }
  function courses() {
    try { return (typeof liveCourses !== 'undefined' && Array.isArray(liveCourses)) ? liveCourses : []; } catch (_) { return []; }
  }
  function courseName(id) {
    const c = courses().find(x => String(x.id || x._id) === String(id));
    return c ? (c.code ? c.code + ' · ' : '') + c.name : '';
  }

  /* ---------- ink encoding (what is stored) ----------
     page = {v:1, s:[[tool, color, width, x0,y0,p0, dx,dy,p, …]], t:[[x,y,w,size,color,text]]}
     points are integers in page units; x/y after the first are deltas; p = pressure 0–15 */
  const HEX = /^#[0-9a-f]{6}$/i;
  function encodePage(d) {
    const s = d.s.map(st => {
      const p = st.pts, out = [st.tool, st.c, Math.round(st.w)];
      let lx = 0, ly = 0;
      for (let i = 0; i < p.length; i += 3) {
        const x = Math.round(p[i]), y = Math.round(p[i + 1]);
        out.push(x - lx, y - ly, p[i + 2] | 0); lx = x; ly = y;
      }
      return out;
    });
    const t = d.t.map(x => [Math.round(x.x), Math.round(x.y), Math.round(x.w), Math.round(x.s), x.c, x.txt]);
    return JSON.stringify({ v: 1, s, t });
  }
  function decodePage(str) {
    const d = { s: [], t: [] };
    if (!str) return d;
    let j;
    try { j = JSON.parse(str); } catch (_) { return d; }
    if (!j || j.v !== 1) return d;
    (Array.isArray(j.s) ? j.s : []).forEach(a => {
      if (!Array.isArray(a) || a.length < 6) return;
      const tool = (a[0] === TOOL_HL || a[0] === TOOL_SHAPE || a[0] === TOOL_DASH) ? a[0] : TOOL_PEN;
      const c = HEX.test(a[1]) ? a[1] : '#111827';
      const w = clamp(Number(a[2]) || 6, 1, 200);
      const pts = [];
      let x = 0, y = 0;
      for (let i = 3; i + 2 < a.length; i += 3) {
        x += Number(a[i]) || 0; y += Number(a[i + 1]) || 0;
        pts.push(clamp(x, -50, PW + 50), clamp(y, -50, PH + 50), clamp(a[i + 2] | 0, 0, 15));
      }
      if (pts.length) d.s.push(withBox({ tool, c, w, pts }));
    });
    (Array.isArray(j.t) ? j.t : []).forEach(a => {
      if (!Array.isArray(a) || typeof a[5] !== 'string') return;
      d.t.push({ x: clamp(+a[0] || 0, 0, PW), y: clamp(+a[1] || 0, 0, PH), w: clamp(+a[2] || 600, 80, PW), s: clamp(+a[3] || 46, 16, 160),
        c: HEX.test(a[4]) ? a[4] : '#111827', txt: a[5].slice(0, 5000) });
    });
    return d;
  }
  function withBox(st) {
    const p = st.pts;
    let a = Infinity, b = Infinity, c = -Infinity, e = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < a) a = p[i]; if (p[i] > c) c = p[i];
      if (p[i + 1] < b) b = p[i + 1]; if (p[i + 1] > e) e = p[i + 1];
    }
    st.bb = [a, b, c, e];
    return st;
  }

  /* ---------- drawing ---------- */
  const pf = (q) => 0.45 + (q / 15) * 0.95;      // pressure → width factor
  function penSeg(ctx, st, i) {                   // segment ending at mid(i-1, i)
    const p = st.pts;
    const bx = p[(i - 1) * 3], by = p[(i - 1) * 3 + 1], bq = p[(i - 1) * 3 + 2];
    const cx = p[i * 3], cy = p[i * 3 + 1];
    let mx0, my0;
    if (i === 1) { mx0 = bx; my0 = by; }
    else { mx0 = (p[(i - 2) * 3] + bx) / 2; my0 = (p[(i - 2) * 3 + 1] + by) / 2; }
    ctx.lineWidth = st.w * pf(bq);
    ctx.beginPath();
    ctx.moveTo(mx0, my0);
    ctx.quadraticCurveTo(bx, by, (bx + cx) / 2, (by + cy) / 2);
    ctx.stroke();
  }
  function penTail(ctx, st) {
    const p = st.pts, n = p.length / 3;
    ctx.strokeStyle = st.c; ctx.fillStyle = st.c;
    if (n === 1) {
      ctx.beginPath(); ctx.arc(p[0], p[1], st.w * pf(p[2]) / 2, 0, Math.PI * 2); ctx.fill(); return;
    }
    const bx = p[(n - 2) * 3], by = p[(n - 2) * 3 + 1];
    const cx = p[(n - 1) * 3], cy = p[(n - 1) * 3 + 1], cq = p[(n - 1) * 3 + 2];
    ctx.lineWidth = st.w * pf(cq);
    ctx.beginPath(); ctx.moveTo((bx + cx) / 2, (by + cy) / 2); ctx.lineTo(cx, cy); ctx.stroke();
  }
  function drawPen(ctx, st) {
    ctx.strokeStyle = st.c; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const n = st.pts.length / 3;
    for (let i = 1; i < n; i++) penSeg(ctx, st, i);
    penTail(ctx, st);
  }
  function drawHL(ctx, st) {
    const p = st.pts, n = p.length / 3;
    ctx.save();
    ctx.globalAlpha = 0.36; ctx.strokeStyle = st.c; ctx.lineWidth = st.w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(p[0], p[1]);
    if (n === 1) ctx.lineTo(p[0] + 0.5, p[1]);
    for (let i = 1; i < n - 1; i++) {
      const x = p[i * 3], y = p[i * 3 + 1];
      ctx.quadraticCurveTo(x, y, (x + p[i * 3 + 3]) / 2, (y + p[i * 3 + 4]) / 2);
    }
    if (n > 1) ctx.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
    ctx.stroke(); ctx.restore();
  }
  function wrapLines(ctx, t) {
    ctx.font = `500 ${t.s}px Inter, "Segoe UI", system-ui, sans-serif`;
    const out = [];
    String(t.txt).split('\n').forEach(par => {
      const words = par.split(/(\s+)/);
      let line = '';
      words.forEach(wd => {
        const test = line + wd;
        if (line && ctx.measureText(test).width > t.w) { out.push(line.trimEnd()); line = wd.trimStart(); }
        else line = test;
        while (ctx.measureText(line).width > t.w && line.length > 1) {      // very long word
          let k = line.length - 1;
          while (k > 1 && ctx.measureText(line.slice(0, k)).width > t.w) k--;
          out.push(line.slice(0, k)); line = line.slice(k);
        }
      });
      out.push(line);
    });
    return out;
  }
  function textBox(ctx, t) {
    const lines = wrapLines(ctx, t);
    return { lines, h: Math.max(1, lines.length) * t.s * 1.32 };
  }
  function drawText(ctx, t) {
    const { lines } = textBox(ctx, t);
    ctx.fillStyle = t.c; ctx.textBaseline = 'top';
    lines.forEach((ln, i) => ctx.fillText(ln, t.x, t.y + i * t.s * 1.32 + t.s * 0.08));
  }
  /* straight-edged shapes: p = 0 starts a new sub-path (e.g. an arrow head), 1 continues it */
  function drawShape(ctx, st) {
    const p = st.pts, n = p.length / 3;
    ctx.save();
    ctx.strokeStyle = st.c; ctx.lineWidth = st.w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (st.tool === TOOL_DASH) ctx.setLineDash([st.w * 2.6, st.w * 2.4]);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (i === 0 || p[i * 3 + 2] === 0) ctx.moveTo(p[i * 3], p[i * 3 + 1]); else ctx.lineTo(p[i * 3], p[i * 3 + 1]);
    }
    if (n === 1) ctx.lineTo(p[0] + 0.5, p[1]);
    ctx.stroke(); ctx.restore();
  }
  const isShape = (st) => st.tool === TOOL_SHAPE || st.tool === TOOL_DASH;
  function drawStroke(ctx, st) { if (st.tool === TOOL_HL) drawHL(ctx, st); else if (isShape(st)) drawShape(ctx, st); else drawPen(ctx, st); }
  function drawContent(ctx, d, skipText, skip) {
    for (const st of d.s) if (st.tool === TOOL_HL && !(skip && skip.has(st))) drawHL(ctx, st);   // highlighter under ink
    for (const st of d.s) if (st.tool !== TOOL_HL && !(skip && skip.has(st))) { if (isShape(st)) drawShape(ctx, st); else drawPen(ctx, st); }
    d.t.forEach((t, i) => { if (i !== skipText && !(skip && skip.has(t))) drawText(ctx, t); });   // skipText = index being edited
  }
  function drawPaper(ctx, paper, color) {
    const pc = PAPER_COLORS[color] || PAPER_COLORS.white;
    ctx.fillStyle = pc.bg; ctx.fillRect(0, 0, PW, PH);
    if (paper === 'lined') {
      ctx.fillStyle = pc.rule;
      for (let y = TOP_Y; y < PH - 40; y += GAP.lined) ctx.fillRect(0, y, PW, 2.4);
      ctx.fillStyle = pc.margin; ctx.fillRect(MARGIN_X, 0, 2.6, PH);
    } else if (paper === 'grid') {
      ctx.fillStyle = pc.rule;
      for (let y = GAP.grid; y < PH; y += GAP.grid) ctx.fillRect(0, y, PW, 2);
      for (let x = GAP.grid; x < PW; x += GAP.grid) ctx.fillRect(x, 0, 2, PH);
    } else if (paper === 'dotted') {
      ctx.fillStyle = pc.strong;
      for (let y = GAP.dotted; y < PH; y += GAP.dotted) for (let x = GAP.dotted; x < PW; x += GAP.dotted) { ctx.beginPath(); ctx.arc(x, y, 3.2, 0, 6.283); ctx.fill(); }
    } else if (paper === 'eng') {                        // engineering: fine grid, bold every 5th line
      for (let k = 1; k * GAP.eng < PH; k++) { ctx.fillStyle = k % 5 ? pc.rule : pc.strong; ctx.fillRect(0, k * GAP.eng, PW, k % 5 ? 1.4 : 2.4); }
      for (let k = 1; k * GAP.eng < PW; k++) { ctx.fillStyle = k % 5 ? pc.rule : pc.strong; ctx.fillRect(k * GAP.eng, 0, k % 5 ? 1.4 : 2.4, PH); }
    } else if (paper === 'cornell') {                    // Cornell: cue column, notes area, summary box
      ctx.fillStyle = pc.rule;
      for (let y = TOP_Y; y < PH - 40; y += GAP.lined) ctx.fillRect(0, y, PW, 2.4);
      ctx.fillStyle = pc.margin; ctx.fillRect(CORNELL_X, TOP_Y - GAP.lined, 3, CORNELL_Y - TOP_Y + GAP.lined);
      ctx.fillStyle = pc.strong; ctx.fillRect(0, CORNELL_Y, PW, 4); ctx.fillRect(0, TOP_Y - GAP.lined, PW, 4);
    }
  }

  /* =========================================================
     SHAPES — geometry for the shape tool and "draw & hold" snapping
     Every shape becomes an ordinary stored stroke (tool 3/4) made of
     straight segments, so saving, erasing, undo and PDF export all
     treat it exactly like ink.
     ========================================================= */
  function snapAngle(x0, y0, x1, y1) {                    // pull near-horizontal / vertical / 45° lines onto the angle
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
    if (len < 1) return [x1, y1];
    const a = Math.atan2(dy, dx), step = Math.PI / 12;      // 15° steps
    const snapped = Math.round(a / step) * step;
    if (Math.abs(a - snapped) > 0.07) return [x1, y1];      // ≈ 4°
    return [x0 + Math.cos(snapped) * len, y0 + Math.sin(snapped) * len];
  }
  function arrowHead(out, tx, ty, fx, fy, w) {            // wings at the tip (tx,ty) of a line coming from (fx,fy)
    const a = Math.atan2(ty - fy, tx - fx), L = Math.max(26, w * 4.2), spread = 0.46;
    out.push(tx - L * Math.cos(a - spread), ty - L * Math.sin(a - spread), 0, tx, ty, 1, tx - L * Math.cos(a + spread), ty - L * Math.sin(a + spread), 1);
  }
  function ellipsePts(out, cx, cy, rx, ry, n) {
    n = n || Math.round(clamp((rx + ry) / 6, 36, 120));
    for (let i = 0; i <= n; i++) { const t = (i / n) * Math.PI * 2; out.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t), i ? 1 : 0); }
  }
  function polyPts(out, pts, close) {
    pts.forEach((q, i) => out.push(q[0], q[1], i ? 1 : 0));
    if (close) out.push(pts[0][0], pts[0][1], 1);
  }
  /* (x0,y0) = where the drag started, (x1,y1) = where it is now */
  function shapePoints(kind, x0, y0, x1, y1, w) {
    const out = [];
    if (kind === 'line' || kind === 'arrow' || kind === 'darrow' || kind === 'angle' || kind === 'numline') [x1, y1] = snapAngle(x0, y0, x1, y1);
    let l = Math.min(x0, x1), r = Math.max(x0, x1), t = Math.min(y0, y1), b = Math.max(y0, y1);
    const bw = r - l, bh = b - t;
    const square = bw > 0 && bh > 0 && Math.abs(bw - bh) / Math.max(bw, bh) < 0.07;   // nearly square → exactly square
    if (square && (kind === 'rect' || kind === 'ellipse' || kind === 'hexagon')) {
      const s2 = Math.max(bw, bh); r = (x1 >= x0) ? l + s2 : r; l = r - s2; b = (y1 >= y0) ? t + s2 : b; t = b - s2;
    }
    const cx = (l + r) / 2, cy = (t + b) / 2;
    switch (kind) {
      case 'line': out.push(x0, y0, 0, x1, y1, 1); break;
      case 'arrow': out.push(x0, y0, 0, x1, y1, 1); arrowHead(out, x1, y1, x0, y0, w); break;
      case 'darrow': out.push(x0, y0, 0, x1, y1, 1); arrowHead(out, x1, y1, x0, y0, w); arrowHead(out, x0, y0, x1, y1, w); break;
      case 'rect': polyPts(out, [[l, t], [r, t], [r, b], [l, b]], true); break;
      case 'circle': { const rad = Math.hypot(x1 - x0, y1 - y0); ellipsePts(out, x0, y0, rad, rad); break; }   // from the centre
      case 'ellipse': ellipsePts(out, cx, cy, (r - l) / 2, (b - t) / 2); break;
      case 'triangle': polyPts(out, [[cx, t], [r, b], [l, b]], true); break;
      case 'rtriangle': polyPts(out, [[l, t], [l, b], [r, b]], true); break;
      case 'hexagon': { const rad = Math.min(r - l, b - t) / 2, q = []; for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; q.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]); } polyPts(out, q, true); break; }
      case 'axes':
        out.push(l, cy, 0, r, cy, 1); arrowHead(out, r, cy, l, cy, w);
        out.push(cx, b, 0, cx, t, 1); arrowHead(out, cx, t, cx, b, w); break;
      case 'axes3': {
        const ox = l + bw * 0.38, oy = t + bh * 0.62;
        out.push(ox, oy, 0, ox, t, 1); arrowHead(out, ox, t, ox, oy, w);                  // z
        out.push(ox, oy, 0, r, oy, 1); arrowHead(out, r, oy, ox, oy, w);                  // y
        const ex = l, ey = Math.min(b, oy + (ox - l) * 0.9);
        out.push(ox, oy, 0, ex, ey, 1); arrowHead(out, ex, ey, ox, oy, w); break;          // x (towards you)
      }
      case 'numline': {
        out.push(x0, y0, 0, x1, y1, 1); arrowHead(out, x1, y1, x0, y0, w); arrowHead(out, x0, y0, x1, y1, w);
        const len = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / (len || 1), uy = (y1 - y0) / (len || 1), tick = Math.max(16, w * 2.4);
        const n = Math.max(2, Math.min(20, Math.round(len / 90)));
        for (let i = 1; i < n; i++) { const px = x0 + ux * len * i / n, py = y0 + uy * len * i / n; out.push(px - uy * tick, py + ux * tick, 0, px + uy * tick, py - ux * tick, 1); }
        break;
      }
      case 'parabola': { const n = 48; for (let i = 0; i <= n; i++) { const u = -1 + 2 * i / n; out.push(cx + u * bw / 2, b - (1 - u * u) * bh, i ? 1 : 0); } break; }
      case 'sine': { const n = 72; for (let i = 0; i <= n; i++) { const u = i / n; out.push(l + u * bw, cy - Math.sin(u * Math.PI * 4) * bh / 2, i ? 1 : 0); } break; }
      case 'angle': {
        const len = Math.max(Math.hypot(x1 - x0, y1 - y0), 1), a2 = Math.atan2(y1 - y0, x1 - x0);
        out.push(x0 + len, y0, 0, x0, y0, 1, x1, y1, 1);                                     // base ray → vertex → second ray
        const rad = Math.min(len * 0.28, 160), n = 24;
        let a = a2; if (a > 0) a -= Math.PI * 2;                                             // sweep the short way from the base ray
        const sweep = (Math.abs(a) > Math.PI) ? a + Math.PI * 2 : a;
        for (let i = 0; i <= n; i++) { const tt = sweep * i / n; out.push(x0 + rad * Math.cos(tt), y0 + rad * Math.sin(tt), i ? 1 : 0); }
        break;
      }
      default: out.push(x0, y0, 0, x1, y1, 1);
    }
    return out;
  }

  /* ---- draw & hold: turn a rough line / circle / triangle / box into a clean one ---- */
  function rdp(pts, eps) {                                 // Ramer–Douglas–Peucker on [[x,y],…]
    if (pts.length < 3) return pts.slice();
    let idx = 0, dmax = 0;
    const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i++) { const d = Math.sqrt(segDist2(pts[i][0], pts[i][1], ax, ay, bx, by)); if (d > dmax) { dmax = d; idx = i; } }
    if (dmax <= eps) return [pts[0], pts[pts.length - 1]];
    return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
  }
  function recognize(raw) {
    const P = []; for (let i = 0; i < raw.length; i += 3) P.push([raw[i], raw[i + 1]]);
    if (P.length < 6) return null;
    let len = 0; for (let i = 1; i < P.length; i++) len += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    if (len < 60) return null;
    const [sx, sy] = P[0], [ex, ey] = P[P.length - 1], gap = Math.hypot(ex - sx, ey - sy);
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    P.forEach(([x, y]) => { if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y; });
    const size = Math.max(r - l, b - t);
    /* straight line: the path never strays far from the chord */
    if (gap / len > 0.6) {
      let dev = 0; P.forEach(([x, y]) => { dev = Math.max(dev, Math.sqrt(segDist2(x, y, sx, sy, ex, ey))); });
      if (dev < Math.max(14, gap * 0.06)) { const [x1, y1] = snapAngle(sx, sy, ex, ey); return [sx, sy, 0, x1, y1, 1]; }
    }
    if (gap > Math.max(0.22 * len, 50)) return null;        // open curve — leave it as ink
    /* closed: polygon first (corners), then ellipse */
    const eps = Math.max(14, size * 0.07);
    let poly = rdp(P, eps);
    if (Math.hypot(poly[0][0] - poly[poly.length - 1][0], poly[0][1] - poly[poly.length - 1][1]) < eps * 2.2) poly = poly.slice(0, -1);
    // merge a start point that sits on an edge
    if (poly.length >= 4) {
      const a = poly[poly.length - 1], c = poly[1], m = poly[0];
      if (Math.sqrt(segDist2(m[0], m[1], a[0], a[1], c[0], c[1])) < eps) poly = poly.slice(1);
    }
    const cx = (l + r) / 2, cy = (t + b) / 2, rx = (r - l) / 2 || 1, ry = (b - t) / 2 || 1;
    let dev = 0; P.forEach(([x, y]) => { dev += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1); }); dev /= P.length;
    if (poly.length === 3 && dev > 0.1) { const out = []; polyPts(out, poly, true); return out; }
    if (poly.length === 4 && dev > 0.09) {
      const axisAligned = poly.every((q, i) => { const n2 = poly[(i + 1) % 4], ang = Math.abs(Math.atan2(n2[1] - q[1], n2[0] - q[0])) % (Math.PI / 2); return ang < 0.16 || ang > Math.PI / 2 - 0.16; });
      const out = []; polyPts(out, axisAligned ? [[l, t], [r, t], [r, b], [l, b]] : poly, true); return out;
    }
    if (dev < 0.14) {
      const out = [];
      if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.16) { const rad = (rx + ry) / 2; ellipsePts(out, cx, cy, rad, rad); }
      else ellipsePts(out, cx, cy, rx, ry);
      return out;
    }
    return null;
  }

  /* ---------- state ---------- */
  const S = {
    root: null, mode: 'library', list: null, usage: null, filter: '', loadingList: false,
    nb: null, pages: [], byId: new Map(), scroller: null, io: null,
    tool: 'pen', penColor: 0, hlColor: 0, size: { pen: 1, hl: 1, eraser: 1, text: 1 }, customInk: null,
    zoom: 1, base: 0.4, fingerDraw: lsGet('aero_nt_finger') !== '0', penSeen: false,
    undo: [], redo: [], status: 'saved', saveTimer: 0, saving: false, retryMs: 4000,
    active: null, touches: new Map(), gesture: null, editing: null, overlay: null,
    remountTimer: 0, loadQueue: new Set(), loadTimer: 0, current: 0,
    palms: new Set(), lastPenAt: 0,
    penHex: null, hlHex: null,                          // a custom colour picked from the palette (null = preset)
    shape: lsGet('aero_nt_shape') || 'line', dashed: false,
    eraseMode: lsGet('aero_nt_erase') === 'stroke' ? 'stroke' : 'precise',
    snap: lsGet('aero_nt_snap') !== '0',                // draw & hold → clean shape
    sel: null,                                          // lasso selection {page, items:[{kind,item}]}
    sideOpen: null, thumbIo: null, thumbQueue: new Set(), thumbTimer: 0
  };
  const penInk = () => S.penHex || inks()[S.penColor] || inks()[0];
  const hlInk = () => S.hlHex || HILITES[S.hlColor] || HILITES[0];
  function recentColors() { try { const a = JSON.parse(lsGet('aero_nt_recent') || '[]'); return Array.isArray(a) ? a.filter(c => HEX.test(c)).slice(0, 8) : []; } catch (_) { return []; } }
  function rememberColor(hex) { const a = recentColors().filter(c => c.toLowerCase() !== hex.toLowerCase()); a.unshift(hex); lsSet('aero_nt_recent', JSON.stringify(a.slice(0, 8))); }
  const nightPaper = () => !!(S.nb && (PAPER_COLORS[S.nb.paperColor] || {}).dark);
  const inks = () => nightPaper() ? INKS_DARK : INKS_LIGHT;
  const scale = () => S.base * S.zoom;

  /* ---------- full window & full screen ----------
     An open notebook always takes the whole window (the site header,
     footer and page scroll step aside — the ← button brings them back).
     Where the browser allows it, the ⤢ button also hides the browser's
     own bars (true full screen). */
  function setEditing(on) {
    if (S.root) S.root.classList.toggle('nt-editing', !!on);
    document.documentElement.classList.toggle('aero-nt-full', !!on);
  }
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  const fsSupported = () => !/AeroGyanApp\//.test(navigator.userAgent || '') && !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);   // the Android app is already full screen
  function enterFullscreen() {
    const el = document.documentElement, fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!fn) return;
    try { const r = fn.call(el, { navigationUI: 'hide' }); if (r && r.catch) r.catch(() => toast('Full screen is not available here.', 'info')); } catch (_) {}
    S.fsByUs = true;
  }
  function exitFullscreen() {
    if (!S.fsByUs) return;
    S.fsByUs = false;
    if (!fsElement()) return;
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    try { const r = fn && fn.call(document); if (r && r.catch) r.catch(() => {}); } catch (_) {}
  }
  function syncFsButton() {
    const b = S.root && S.root.querySelector('[data-act="fullscreen"]'); if (!b) return;
    const on = !!fsElement();
    b.innerHTML = `<i class="fas ${on ? 'fa-compress' : 'fa-expand'}"></i>`;
    b.title = on ? 'Exit full screen' : 'Full screen';
    b.setAttribute('aria-label', b.title);
    b.classList.toggle('on', on);
  }
  document.addEventListener('fullscreenchange', syncFsButton);
  document.addEventListener('webkitfullscreenchange', syncFsButton);

  /* =========================================================
     LIBRARY
     ========================================================= */
  /* ⚡ the shelf is kept on this device (per student) so "My Notes" opens
     instantly; the server copy replaces it a moment later */
  function listKey() {
    try { const u = (typeof currentUser !== 'undefined' && currentUser) || null; return u ? 'aero_nt_list_' + (u._id || u.id || u.username) : null; } catch (_) { return null; }
  }
  function cachedList() {
    const k = listKey(); if (!k) return null;
    try { const o = JSON.parse(lsGet(k) || 'null'); return o && Array.isArray(o.list) ? o : null; } catch (_) { return null; }
  }
  function saveListCache() {
    const k = listKey(); if (!k || !S.list) return;
    lsSet(k, JSON.stringify({ list: S.list.slice(0, 200).map(n => ({ id: n.id, title: n.title, cover: n.cover, paper: n.paper, paperColor: n.paperColor, courseId: n.courseId, pageCount: n.pageCount, updatedAt: n.updatedAt, bytes: n.bytes })), usage: S.usage }));
  }
  async function loadList(force) {
    if (S.list && !force) return S.list;
    S.loadingList = true;
    try {
      const j = await api('GET', API);
      S.list = j.notebooks || []; S.usage = j.usage || null; S.listAt = Date.now();
      saveListCache();
    } catch (e) {
      if (!S.list) S.list = null;
      throw e;
    } finally { S.loadingList = false; }
    return S.list;
  }
  function coverStyle(key) {
    const c = COVERS[key] || COVERS.indigo;
    return `--nt-c1:${c[0]};--nt-c2:${c[1]}`;
  }
  function renderLibrary() {
    const root = S.root; if (!root) return;
    S.mode = 'library';
    setEditing(false);
    const list = S.list;
    const q = S.filter.trim().toLowerCase();
    const shown = (list || []).filter(n => !q || (n.title + ' ' + courseName(n.courseId)).toLowerCase().includes(q));
    const usage = S.usage ? Math.round((S.usage.bytes / S.usage.limit) * 100) : 0;
    root.innerHTML = `
      <div class="nt-lib">
        <div class="nt-lib-head">
          <div>
            <h2><i class="fas fa-book-open"></i> My Notes</h2>
            <p>Handwrite or type notes for your courses. Everything saves automatically.</p>
          </div>
          <div class="nt-lib-actions">
            <div class="nt-search"><i class="fas fa-magnifying-glass"></i><input type="search" id="ntSearch" placeholder="Search notebooks" value="${esc(S.filter)}" aria-label="Search notebooks"></div>
            <button type="button" class="btn btn-primary" data-nt="new"><i class="fas fa-plus"></i> New notebook</button>
          </div>
        </div>
        ${list === null ? `<div class="nt-empty"><i class="fas fa-spinner fa-spin"></i><p>Loading your notebooks…</p></div>`
          : !list.length ? `
          <div class="nt-empty nt-empty-first">
            <div class="nt-empty-art" aria-hidden="true"><span></span><span></span><span></span></div>
            <h3>Start your first notebook</h3>
            <p>Write with a stylus, your finger or a mouse — ruled, grid or dotted paper, highlighters and typed text.</p>
            <button type="button" class="btn btn-primary" data-nt="new"><i class="fas fa-plus"></i> New notebook</button>
          </div>`
          : `
          <div class="nt-grid">
            <button type="button" class="nt-card nt-card-new" data-nt="new" aria-label="New notebook">
              <span class="nt-new-ic"><i class="fas fa-plus"></i></span><span>New notebook</span>
            </button>
            ${shown.map(n => `
              <div class="nt-card" data-open="${esc(n.id)}" tabindex="0" role="button" aria-label="Open ${esc(n.title)}">
                <div class="nt-cover" style="${coverStyle(n.cover)}">
                  <span class="nt-cover-label"><b>${esc(n.title)}</b>${n.courseId && courseName(n.courseId) ? `<small>${esc(courseName(n.courseId))}</small>` : ''}</span>
                  <span class="nt-cover-paper nt-paper-${esc(n.paper)}"></span>
                </div>
                <div class="nt-card-meta">
                  <div><b>${esc(n.title)}</b><span>${n.pageCount} page${n.pageCount === 1 ? '' : 's'} · ${esc(ago(n.updatedAt))}</span></div>
                  <button type="button" class="nt-more" data-menu="${esc(n.id)}" aria-label="Notebook options"><i class="fas fa-ellipsis-vertical"></i></button>
                </div>
              </div>`).join('')}
          </div>
          ${q && !shown.length ? `<div class="nt-empty"><p>No notebook matches “${esc(S.filter)}”.</p></div>` : ''}
          ${S.usage ? `<div class="nt-usage"><span style="width:${Math.min(100, usage)}%"></span></div><div class="nt-usage-txt">${(S.usage.bytes / 1048576).toFixed(1)} MB of ${(S.usage.limit / 1048576).toFixed(0)} MB used</div>` : ''}`}
      </div>`;
  }
  function onLibraryClick(e) {
    const nw = e.target.closest('[data-nt="new"]');
    if (nw) return openNotebookDialog(null);
    const m = e.target.closest('[data-menu]');
    if (m) { e.stopPropagation(); return notebookMenu(m.dataset.menu, m); }
    const o = e.target.closest('[data-open]');
    if (o) return openNotebook(o.dataset.open);
  }

  /* ---------- small UI helpers (no alert/prompt — they break the Android app) ---------- */
  function popup(html, onClick, opts) {
    closePopup();
    const ov = document.createElement('div');
    ov.className = 'nt-pop-ov' + (opts && opts.center ? ' is-center' : '');
    ov.innerHTML = `<div class="nt-pop ${opts && opts.cls || ''}" role="dialog" aria-modal="true">${html}</div>`;
    ov.addEventListener('click', (e) => { if (e.target === ov) closePopup(); else onClick && onClick(e, ov); });
    document.body.appendChild(ov);
    S.popup = ov;
    if (opts && opts.anchor && !opts.center) {
      const r = opts.anchor.getBoundingClientRect(), box = ov.firstElementChild;
      const w = Math.min((opts && opts.width) || 280, innerWidth - 16);
      box.style.position = 'fixed'; box.style.width = w + 'px';
      box.style.left = clamp(r.right - w, 8, innerWidth - w - 8) + 'px';
      const below = r.bottom + 6, h = box.offsetHeight || 240;
      box.style.top = (below + h < innerHeight - 8 ? below : Math.max(8, r.top - h - 6)) + 'px';
    }
    const f = ov.querySelector('[autofocus]'); if (f) setTimeout(() => f.focus(), 30);
    return ov;
  }
  function closePopup() { if (S.popup) { S.popup.remove(); S.popup = null; } }
  function confirmBox(title, text, ok, danger) {
    return new Promise(resolve => {
      popup(`<h3>${esc(title)}</h3><p>${text}</p><div class="nt-pop-actions"><button type="button" class="btn btn-outline" data-a="no">Cancel</button><button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-a="yes">${esc(ok)}</button></div>`,
        (e) => { const a = e.target.closest('[data-a]'); if (!a) return; closePopup(); resolve(a.dataset.a === 'yes'); }, { center: true, cls: 'nt-dialog' });
    });
  }

  function openNotebookDialog(nb) {
    const editing = !!nb;
    const cur = nb || { title: '', cover: 'indigo', paper: 'lined', paperColor: 'white', courseId: null };
    const cs = courses();
    const html = `
      <h3>${editing ? 'Notebook settings' : 'New notebook'}</h3>
      <label class="nt-field"><span>Title</span><input type="text" id="ntTitle" maxlength="120" value="${esc(cur.title)}" placeholder="e.g. Aerodynamics — lecture notes" autofocus></label>
      <div class="nt-field"><span>Cover</span><div class="nt-swatches" id="ntCovers">${Object.keys(COVERS).map(k =>
        `<button type="button" class="nt-cover-dot ${k === cur.cover ? 'on' : ''}" data-cover="${k}" style="${coverStyle(k)}" aria-label="${k}"></button>`).join('')}</div></div>
      <div class="nt-field"><span>Paper</span><div class="nt-papers" id="ntPapers">${PAPERS.map(p =>
        `<button type="button" class="nt-paper-opt ${p.id === cur.paper ? 'on' : ''}" data-paper="${p.id}"><span class="nt-paper-prev nt-paper-${p.id}"></span>${p.label}</button>`).join('')}</div></div>
      <div class="nt-field"><span>Paper colour</span><div class="nt-seg" id="ntPaperColors">${Object.entries(PAPER_COLORS).map(([k, v]) =>
        `<button type="button" class="${k === cur.paperColor ? 'on' : ''}" data-pcolor="${k}"><i style="background:${v.bg}"></i>${v.label}</button>`).join('')}</div></div>
      ${cs.length ? `<label class="nt-field"><span>Course (optional)</span><select id="ntCourse"><option value="">— None —</option>${cs.map(c =>
        `<option value="${esc(c.id || c._id)}" ${String(c.id || c._id) === String(cur.courseId) ? 'selected' : ''}>${esc((c.code ? c.code + ' · ' : '') + c.name)}</option>`).join('')}</select></label>` : ''}
      <div class="nt-pop-actions"><button type="button" class="btn btn-outline" data-a="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" data-a="save">${editing ? 'Save' : 'Create notebook'}</button></div>`;
    const pick = { cover: cur.cover, paper: cur.paper, paperColor: cur.paperColor };
    const ov = popup(html, async (e, ovEl) => {
      const cv = e.target.closest('[data-cover]'), pp = e.target.closest('[data-paper]'), pc = e.target.closest('[data-pcolor]');
      if (cv) { pick.cover = cv.dataset.cover; ovEl.querySelectorAll('[data-cover]').forEach(b => b.classList.toggle('on', b === cv)); return; }
      if (pp) { pick.paper = pp.dataset.paper; ovEl.querySelectorAll('[data-paper]').forEach(b => b.classList.toggle('on', b === pp)); return; }
      if (pc) { pick.paperColor = pc.dataset.pcolor; ovEl.querySelectorAll('[data-pcolor]').forEach(b => b.classList.toggle('on', b === pc)); return; }
      const a = e.target.closest('[data-a]'); if (!a) return;
      if (a.dataset.a === 'cancel') return closePopup();
      const body = Object.assign({}, pick, {
        title: ($('#ntTitle', ovEl).value || '').trim() || 'Untitled notebook',
        courseId: ($('#ntCourse', ovEl) || {}).value || null
      });
      a.disabled = true;
      try {
        if (editing) {
          const j = await api('PUT', `${API}/${nb.id}`, body);
          Object.assign(nb, j.notebook);
          if (S.nb && S.nb.id === nb.id) { Object.assign(S.nb, j.notebook); applyPaper(); updateTitle(); }
          const li = (S.list || []).find(x => x.id === nb.id); if (li) Object.assign(li, j.notebook);
          closePopup();
          if (S.mode === 'library') renderLibrary();
        } else {
          body.pageId = newId();
          const j = await api('POST', API, body);
          (S.list = S.list || []).unshift(j.notebook);
          closePopup();
          openNotebook(j.notebook.id, j);
        }
      } catch (err) { a.disabled = false; toast(err.offline ? 'You are offline — try again when connected.' : err.message, 'error'); }
    }, { center: true, cls: 'nt-dialog' });
    const t = $('#ntTitle', ov);
    if (t) t.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ov.querySelector('[data-a="save"]').click(); } });
  }

  function notebookMenu(id, anchor) {
    const nb = (S.list || []).find(x => x.id === id); if (!nb) return;
    popup(`<button type="button" data-a="open"><i class="fas fa-book-open"></i> Open</button>
      <button type="button" data-a="edit"><i class="fas fa-pen"></i> Rename, cover & paper</button>
      <button type="button" data-a="pdf"><i class="fas fa-file-pdf"></i> Export as PDF</button>
      <button type="button" class="danger" data-a="del"><i class="fas fa-trash"></i> Delete notebook</button>`,
    async (e) => {
      const a = e.target.closest('[data-a]'); if (!a) return;
      closePopup();
      if (a.dataset.a === 'open') openNotebook(id);
      else if (a.dataset.a === 'edit') openNotebookDialog(nb);
      else if (a.dataset.a === 'pdf') exportPdfById(id);
      else if (a.dataset.a === 'del') {
        if (!(await confirmBox('Delete notebook?', `“${esc(nb.title)}” and all its ${nb.pageCount} page(s) will be deleted. This cannot be undone.`, 'Delete', true))) return;
        try {
          await api('DELETE', `${API}/${id}`);
          S.list = S.list.filter(x => x.id !== id);
          try { Object.keys(localStorage).filter(k => k.indexOf('aero_nt_' + id + '_') === 0).forEach(lsDel); } catch (_) {}
          renderLibrary(); toast('Notebook deleted.', 'success');
        } catch (err) { toast(err.message, 'error'); }
      }
    }, { anchor, cls: 'nt-menu' });
  }

  /* =========================================================
     EDITOR
     ========================================================= */
  async function openNotebook(id, created) {
    S.openingId = id;
    try { await openNotebookNow(id, created); } finally { if (S.openingId === id) S.openingId = null; }
  }
  async function openNotebookNow(id, created) {
    await closeEditor(true);
    S.mode = 'editor';
    try { history.pushState(null, '', '#/notes/' + id); } catch (_) {}
    setEditing(true);
    S.root.innerHTML = `<div class="nt-empty"><i class="fas fa-spinner fa-spin"></i><p>Opening notebook…</p></div>`;
    let j = created;
    try { if (!j) j = await api('GET', `${API}/${id}`); }
    catch (e) {
      toast(e.offline ? 'You are offline — this notebook could not be opened.' : e.message, 'error');
      try { history.replaceState(null, '', '#/notes'); } catch (_) {}
      S.mode = 'library'; renderLibrary(); return;
    }
    S.nb = j.notebook;
    S.pages = (j.pages || []).map(p => ({ id: p.id, rev: p.rev || 0, paper: p.paper || '', d: null, dirty: false, ver: 0, isNew: false }));
    S.byId = new Map(S.pages.map(p => [p.id, p]));
    S.undo = []; S.redo = []; S.zoom = 1; S.current = 0;
    S.status = 'saved';
    if (created) S.pages.forEach(p => { p.d = { s: [], t: [] }; });
    buildEditor();
  }

  function toolBtn(tool, icon, label) {
    return `<button type="button" class="nt-tool ${S.tool === tool ? 'on' : ''}" data-tool="${tool}" title="${label}" aria-label="${label}" aria-pressed="${S.tool === tool}"><i class="fas ${icon}"></i></button>`;
  }
  function buildEditor() {
    const root = S.root;
    root.innerHTML = `
      <div class="nt-editor">
        <div class="nt-bar">
          <div class="nt-bar-l">
            <button type="button" class="nt-ibtn" data-act="back" title="All notebooks" aria-label="All notebooks"><i class="fas fa-arrow-left"></i></button>
            <button type="button" class="nt-ibtn nt-side-btn" data-act="side" title="Pages" aria-label="Show pages"><i class="fas fa-table-columns"></i></button>
            <button type="button" class="nt-title" data-act="settings" title="Notebook settings"><span id="ntTitleTxt"></span><i class="fas fa-chevron-down"></i></button>
            <span class="nt-status" id="ntStatus" aria-live="polite"></span>
          </div>
          <div class="nt-bar-c" role="toolbar" aria-label="Tools">
            ${toolBtn('pen', 'fa-pen', 'Pen (P) — hold at the end of a stroke to snap a clean shape')}
            ${toolBtn('hl', 'fa-highlighter', 'Highlighter (H)')}
            ${toolBtn('eraser', 'fa-eraser', 'Eraser (E)')}
            <button type="button" class="nt-tool" data-tool="shape" title="Shapes (S)" aria-label="Shapes" aria-pressed="false">${shapeSvg('triangle')}</button>
            ${toolBtn('lasso', 'fa-object-ungroup', 'Lasso select (L) — circle ink to move, recolour, copy or delete it')}
            ${toolBtn('text', 'fa-font', 'Text (T)')}
            ${toolBtn('hand', 'fa-hand', 'Scroll / move (Space)')}
            <span class="nt-sep"></span>
            <div class="nt-opts" id="ntOpts"></div>
            <div class="nt-colors" id="ntColors"></div>
            <span class="nt-sep"></span>
            <div class="nt-sizes" id="ntSizes"></div>
          </div>
          <div class="nt-bar-r">
            <button type="button" class="nt-ibtn" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo"><i class="fas fa-rotate-left"></i></button>
            <button type="button" class="nt-ibtn" data-act="redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><i class="fas fa-rotate-right"></i></button>
            <button type="button" class="nt-ibtn" data-act="zoomout" title="Zoom out" aria-label="Zoom out"><i class="fas fa-magnifying-glass-minus"></i></button>
            <button type="button" class="nt-zoom" data-act="zoomfit" id="ntZoom" title="Fit width">100%</button>
            <button type="button" class="nt-ibtn" data-act="zoomin" title="Zoom in" aria-label="Zoom in"><i class="fas fa-magnifying-glass-plus"></i></button>
            <button type="button" class="nt-ibtn nt-primary" data-act="addpage" title="Add a page" aria-label="Add a page"><i class="fas fa-file-circle-plus"></i></button>
            ${fsSupported() ? `<button type="button" class="nt-ibtn nt-fs" data-act="fullscreen" title="Full screen" aria-label="Full screen"><i class="fas fa-expand"></i></button>` : ''}
            <button type="button" class="nt-ibtn" data-act="more" title="More" aria-label="More"><i class="fas fa-ellipsis"></i></button>
          </div>
        </div>
        <div class="nt-body">
          <aside class="nt-side" id="ntSide" aria-label="Pages">
            <div class="nt-side-head">
              <b>Pages <span id="ntSideCount"></span></b>
              <button type="button" class="nt-ibtn" data-act="sideadd" title="Add a page at the end" aria-label="Add a page at the end"><i class="fas fa-plus"></i></button>
              <button type="button" class="nt-ibtn nt-side-x" data-act="sideclose" title="Close" aria-label="Close pages"><i class="fas fa-xmark"></i></button>
            </div>
            <div class="nt-thumbs" id="ntThumbs"></div>
          </aside>
          <div class="nt-side-scrim" data-act="sideclose"></div>
          <div class="nt-scroller" id="ntScroller" tabindex="-1">
            <div class="nt-pages" id="ntPages"></div>
          </div>
          <div class="nt-pagechip" id="ntPageChip"></div>
        </div>
      </div>`;
    S.scroller = $('#ntScroller', root);
    S.pagesEl = $('#ntPages', root);
    S.sideEl = $('#ntSide', root); S.thumbsEl = $('#ntThumbs', root);
    if (S.sideOpen == null) { const v = lsGet('aero_nt_side'); S.sideOpen = v ? v === '1' : innerWidth >= 1100; }
    if (innerWidth < 900) S.sideOpen = false;            // phones / small tablets: the drawer starts closed
    root.querySelector('.nt-editor').classList.toggle('nt-side-open', !!S.sideOpen);
    updateTitle(); renderToolOptions(); setStatus(S.status); syncFsButton();
    computeBase();
    applyPaper();
    S.pages.forEach(p => S.pagesEl.appendChild(pageShell(p)));
    applyScale();
    setupObserver();
    renderSidebar();
    wireEditor();
  }
  function pageShell(p) {
    const el = document.createElement('div');
    el.className = 'nt-page';
    el.dataset.pid = p.id;
    el.innerHTML = `<div class="nt-page-foot"><span class="nt-page-num"></span><button type="button" class="nt-page-more" data-pmenu="${p.id}" aria-label="Page options"><i class="fas fa-ellipsis"></i></button></div>`;
    p.el = el;
    paintPaperClass(p);
    return el;
  }
  function paintPaperClass(p) {
    const paper = p.paper || S.nb.paper, pc = ' nt-paper-' + paper + ' nt-pc-' + (S.nb.paperColor || 'white');
    if (p.el) p.el.className = 'nt-page' + pc;
    if (p.thumbEl) p.thumbEl.firstElementChild.className = 'nt-thumb-paper' + pc;
  }
  function renumber() {
    S.pages.forEach((p, i) => { const n = p.el && p.el.querySelector('.nt-page-num'); if (n) n.textContent = (i + 1) + ' / ' + S.pages.length; });
  }
  function applyPaper() {
    if (!S.pagesEl) return;
    const pc = PAPER_COLORS[S.nb.paperColor] || PAPER_COLORS.white;
    const st = S.pagesEl.style;
    st.setProperty('--nt-paper', pc.bg); st.setProperty('--nt-rule', pc.rule);
    st.setProperty('--nt-rule-strong', pc.strong); st.setProperty('--nt-margin', pc.margin);
    if (S.thumbsEl) { const t2 = S.thumbsEl.style; t2.setProperty('--nt-paper', pc.bg); t2.setProperty('--nt-rule', pc.rule); t2.setProperty('--nt-rule-strong', pc.strong); t2.setProperty('--nt-margin', pc.margin); }
    S.pages.forEach(paintPaperClass);
    renderToolOptions();
  }
  /* one toolbar row when everything fits, two rows otherwise — measured
     against the widest tool (pen: colours + sizes) so switching tools
     never makes the bar jump between one and two rows */
  function fitBar() {
    const bar = S.root && S.root.querySelector('.nt-bar'); if (!bar) return;
    const c = bar.querySelector('.nt-bar-c'), r = bar.querySelector('.nt-bar-r');
    bar.classList.remove('nt-bar-2row');
    if (getComputedStyle(bar).gridTemplateAreas.indexOf('c c') >= 0) { bar.classList.add('nt-bar-2row'); return; }  // narrow-screen CSS already stacks it
    const centre = Math.max(c.scrollWidth, S.centreMax || 0);
    S.centreMax = Math.max(S.centreMax || 0, c.scrollWidth);
    const kids = Array.from(r.children).filter(k => k.offsetWidth);
    const rNeed = kids.reduce((t, k) => t + k.offsetWidth, 0) + Math.max(0, kids.length - 1) * 4;
    const side = Math.max(rNeed, 240);
    if (Math.max(centre, 640) + side * 2 + 44 > bar.clientWidth) bar.classList.add('nt-bar-2row');
  }
  function updateTitle() { const t = $('#ntTitleTxt'); if (t && S.nb) t.textContent = S.nb.title; }
  function computeBase() {
    const w = S.scroller ? S.scroller.clientWidth : 800;
    S.base = clamp((w - (w < 640 ? 16 : 56)) / PW, 0.12, 0.46);
  }
  function applyScale() {
    const u = scale();
    S.pagesEl.style.setProperty('--u', String(u));
    S.pagesEl.style.setProperty('--nt-pw', (PW * u).toFixed(1) + 'px');
    S.pagesEl.style.setProperty('--nt-ph', (PH * u).toFixed(1) + 'px');
    const z = $('#ntZoom'); if (z) z.textContent = Math.round(S.zoom * 100) + '%';
    renumber();
    if (S.sel) showSelectionUI();
  }
  function renderToolOptions() {
    const cEl = $('#ntColors'), sEl = $('#ntSizes'), oEl = $('#ntOpts'); if (!cEl || !sEl) return;
    const t = S.tool;
    const custom = (hex, hl) => `<button type="button" class="nt-color nt-custom ${hex ? 'on' : ''} ${hl ? 'nt-hl' : ''}" data-act="pickcolor" style="${hex ? '--c:' + hex : ''}" title="Any colour…" aria-label="Any colour"></button>`;
    if (t === 'pen' || t === 'text' || t === 'shape') {
      const list = inks();
      cEl.innerHTML = list.map((c, i) => `<button type="button" class="nt-color ${!S.penHex && S.penColor === i ? 'on' : ''}" data-color="${i}" style="--c:${c}" aria-label="Colour ${i + 1}"></button>`).join('') + custom(S.penHex);
    } else if (t === 'hl') {
      cEl.innerHTML = HILITES.map((c, i) => `<button type="button" class="nt-color nt-hl ${!S.hlHex && S.hlColor === i ? 'on' : ''}" data-color="${i}" style="--c:${c}" aria-label="Highlighter ${i + 1}"></button>`).join('') + custom(S.hlHex, true);
    } else cEl.innerHTML = '';
    if (oEl) {
      if (t === 'shape') oEl.innerHTML = `<button type="button" class="nt-shape-pick" data-act="pickshape" title="Choose a shape" aria-label="Choose a shape">${shapeSvg(S.shape)}<i class="fas fa-chevron-down"></i></button>
        <button type="button" class="nt-dash ${S.dashed ? 'on' : ''}" data-act="dash" title="Dashed line" aria-label="Dashed line" aria-pressed="${S.dashed}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 12h3M10.5 12h3M18 12h3"/></svg></button>`;
      else if (t === 'eraser') oEl.innerHTML = `<div class="nt-seg nt-seg-sm" role="group" aria-label="Eraser type"><button type="button" class="${S.eraseMode === 'precise' ? 'on' : ''}" data-erase="precise" title="Erase only what you rub">Precise</button><button type="button" class="${S.eraseMode === 'stroke' ? 'on' : ''}" data-erase="stroke" title="Remove whole strokes">Stroke</button></div>`;
      else if (t === 'lasso') oEl.innerHTML = `<span class="nt-hint"><i class="fas fa-circle-info"></i> Draw around ink to select it</span>`;
      else oEl.innerHTML = '';
    }
    const key = t === 'pen' || t === 'shape' ? 'pen' : t === 'hl' ? 'hl' : t === 'eraser' ? 'eraser' : t === 'text' ? 'text' : null;
    sEl.innerHTML = key ? [0, 1, 2].map(i => `<button type="button" class="nt-size ${S.size[key] === i ? 'on' : ''}" data-size="${i}" aria-label="Size ${i + 1}"><i style="--d:${[5, 9, 14][i]}px"></i></button>`).join('') : '';
    cEl.parentElement.querySelectorAll('.nt-sep').forEach(s => { s.style.display = (key || t === 'lasso') ? '' : 'none'; });
    if (t !== 'lasso') clearSelection();
    S.root.querySelectorAll('[data-tool]').forEach(b => { const on = b.dataset.tool === t; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    if (S.scroller) S.scroller.dataset.tool = t;
    fitBar();
  }
  function setStatus(st, msg) {
    S.status = st;
    const el = $('#ntStatus'); if (!el) return;
    const map = {
      saved: '<i class="fas fa-circle-check"></i> Saved',
      unsaved: '<i class="fas fa-pen-nib"></i> Editing…',
      saving: '<i class="fas fa-arrows-rotate fa-spin"></i> Saving…',
      offline: '<i class="fas fa-cloud-arrow-up"></i> Offline — kept on this device',
      error: '<i class="fas fa-triangle-exclamation"></i> ' + esc(msg || 'Not saved — retrying')
    };
    el.innerHTML = map[st] || '';
    el.className = 'nt-status is-' + st;
  }

  /* ---------- virtualisation: only near-screen pages own a canvas ---------- */
  function setupObserver() {
    if (S.io) S.io.disconnect();
    S.io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const p = S.byId.get(en.target.dataset.pid); if (!p) continue;
        if (en.isIntersecting) mountPage(p); else unmountPage(p);
      }
      updateCurrent();
    }, { root: S.scroller, rootMargin: '700px 0px' });
    S.pages.forEach(p => S.io.observe(p.el));
  }
  function updateCurrent() {
    if (!S.scroller) return;
    const mid = S.scroller.scrollTop + S.scroller.clientHeight / 2;
    let idx = 0;
    for (let i = 0; i < S.pages.length; i++) { const el = S.pages[i].el; if (el.offsetTop <= mid) idx = i; else break; }
    const changed = S.current !== idx;
    S.current = idx;
    const chip = $('#ntPageChip'); if (chip) chip.textContent = `Page ${idx + 1} of ${S.pages.length}`;
    if (changed || !S._thumbOn) markCurrentThumb();
  }
  function canvasSize() {
    const u = scale(), cw = PW * u, ch = PH * u;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    while (cw * ch * dpr * dpr > MAX_CANVAS_PX && dpr > 0.5) dpr *= 0.88;
    return { w: Math.round(cw * dpr), h: Math.round(ch * dpr) };
  }
  function mountPage(p) {
    if (!p.canvas) {
      const c = document.createElement('canvas');
      c.className = 'nt-ink';
      p.el.insertBefore(c, p.el.firstChild);
      p.canvas = c; p.ctx = c.getContext('2d');
    }
    sizeCanvas(p);
    if (p.d) renderPage(p); else queueLoad(p);
  }
  function sizeCanvas(p) {
    const { w, h } = canvasSize();
    if (p.canvas.width !== w || p.canvas.height !== h) { p.canvas.width = w; p.canvas.height = h; p.sized = true; }
    p.k = w / PW;
  }
  function unmountPage(p) {
    if (!p.canvas || (S.active && S.active.page === p)) return;
    if (S.sel && S.sel.page === p) clearSelection();
    p.canvas.width = 0; p.canvas.height = 0;            // hands the pixel memory back
    p.canvas.remove(); p.canvas = null; p.ctx = null;
    /* far-away, saved pages also drop their parsed ink (re-read when needed) */
    if (!p.dirty && p.d && Math.abs(S.pages.indexOf(p) - S.current) > 12) { p.raw = encodePage(p.d); p.d = null; }
  }
  function renderPage(p) {
    if (!p.ctx || !p.d) return;
    const ctx = p.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
    ctx.setTransform(p.k, 0, 0, p.k, 0, 0);
    drawContent(ctx, p.d, S.editing && S.editing.page === p ? S.editing.idx : null, S.sel && S.sel.page === p ? S.sel.hidden : null);
  }
  let renderQueued = new Set(), renderRaf = 0;
  function scheduleRender(p) {
    renderQueued.add(p);
    if (!renderRaf) renderRaf = requestAnimationFrame(() => { renderRaf = 0; renderQueued.forEach(renderPage); renderQueued.clear(); });
  }

  /* ---------- page ink loading (batched) ---------- */
  function queueLoad(p) {
    if (p.d || p.loading) return;
    if (p.raw != null) { p.d = decodePage(p.raw); p.raw = null; renderPage(p); return; }
    S.loadQueue.add(p.id);
    clearTimeout(S.loadTimer);
    S.loadTimer = setTimeout(flushLoads, 40);
  }
  async function flushLoads() {
    const ids = Array.from(S.loadQueue).slice(0, 12);
    ids.forEach(id => S.loadQueue.delete(id));
    if (!ids.length || !S.nb) return;
    const nbId = S.nb.id;
    ids.forEach(id => { const p = S.byId.get(id); if (p) p.loading = true; });
    try {
      const j = await api('GET', `${API}/${nbId}/pages?ids=${encodeURIComponent(ids.join(','))}`);
      if (!S.nb || S.nb.id !== nbId) return;
      (j.pages || []).forEach(r => {
        const p = S.byId.get(r.id); if (!p) return;
        p.loading = false; p.rev = r.rev; if (r.paper !== undefined) p.paper = r.paper || '';
        /* unsynced copy on this device that is newer than the server's? use it */
        const bk = lsGet(`aero_nt_${nbId}_${p.id}`);
        let data = r.data;
        if (bk) {
          try {
            const b = JSON.parse(bk);
            if (b && typeof b.data === 'string' && (b.rev || 0) >= (r.rev || 0)) { data = b.data; p.dirty = true; scheduleSave(); }
            else lsDel(`aero_nt_${nbId}_${p.id}`);
          } catch (_) { lsDel(`aero_nt_${nbId}_${p.id}`); }
        }
        p.d = decodePage(data);
        paintPaperClass(p);
        if (p.ctx) renderPage(p);
        p.thumbRaw = null; drawThumb(p);
      });
    } catch (e) {
      ids.forEach(id => { const p = S.byId.get(id); if (p) { p.loading = false; } });
      if (e.offline) setStatus('offline');
      setTimeout(() => ids.forEach(id => { const p = S.byId.get(id); if (p && p.canvas && !p.d) queueLoad(p); }), 5000);
    }
    if (S.loadQueue.size) flushLoads();
  }

  /* ---------- saving ---------- */
  function markDirty(p) {
    p.dirty = true; p.ver++;
    scheduleThumb(p);
    if (S.status !== 'saving') setStatus('unsaved');
    scheduleSave();
  }
  function scheduleSave(delay) {
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(saveNow, delay == null ? SAVE_DELAY : delay);
  }
  async function saveNow() {
    clearTimeout(S.saveTimer);
    if (S.saving || !S.nb) return;
    if (S.active) { scheduleSave(500); return; }        // never pause the main thread mid-stroke
    const nbId = S.nb.id;
    const dirty = S.pages.filter(p => p.dirty && p.d);
    if (!dirty.length) { if (S.status !== 'saved') setStatus('saved'); return; }
    S.saving = true; setStatus('saving');
    try {
      for (const p of dirty) {
        const ver = p.ver;
        const data = encodePage(p.d);
        lsSet(`aero_nt_${nbId}_${p.id}`, JSON.stringify({ rev: p.rev, data }));     // crash-safe copy
        const idx = S.pages.indexOf(p);
        const body = { data };
        if (p.isNew) { body.after = idx > 0 ? S.pages[idx - 1].id : ''; body.paper = p.paper || ''; }
        if (p.paperChanged) { body.paper = p.paper || ''; }
        const j = await api('PUT', `${API}/${nbId}/pages/${p.id}`, body);
        p.rev = j.rev; p.isNew = false; p.paperChanged = false;
        if (p.ver === ver) { p.dirty = false; lsDel(`aero_nt_${nbId}_${p.id}`); }
        if (j.notebook && S.nb && S.nb.id === nbId) { S.nb.updatedAt = j.notebook.updatedAt; S.nb.pageCount = j.notebook.pageCount; }
      }
      S.retryMs = 4000;
      S.saving = false;
      if (S.pages.some(p => p.dirty)) return saveNow();
      setStatus('saved');
      const li = (S.list || []).find(x => S.nb && x.id === S.nb.id);
      if (li && S.nb) { li.updatedAt = new Date().toISOString(); li.pageCount = S.pages.length; }
    } catch (e) {
      S.saving = false;
      if (e.status === 413) { setStatus('error', e.message); toast(e.message, 'error'); return; }
      setStatus(e.offline ? 'offline' : 'error');
      S.retryMs = Math.min(60000, S.retryMs * 1.6);
      scheduleSave(S.retryMs);
    }
  }
  function hasUnsaved() { return S.pages.some(p => p.dirty); }

  /* ---------- input ---------- */
  function pagePoint(p, e) {
    const r = p.el.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * PW, (e.clientY - r.top) / r.height * PH];
  }
  function pressureOf(e) {
    if (e.pointerType === 'pen') return clamp(Math.round((e.pressure || 0.5) * 15), 1, 15);
    return 8;
  }
  function pageFromEvent(e) {
    const el = e.target.closest && e.target.closest('.nt-page');
    return el ? S.byId.get(el.dataset.pid) : null;
  }
  /* ---------- stylus first: palm rejection ----------
     A resting palm or wrist touches the glass before (and while) the
     pencil writes. Those touches must never scroll, zoom or draw, and
     they must never steal the pencil's stroke. */
  const PALM_MS = 900;                                   // touches this soon after the pen are treated as palm
  function penBusy() { return !!(S.active && S.active.pointerType === 'pen') || (performance.now() - (S.lastPenAt || 0) < PALM_MS); }
  function dropTouches() {
    S.touches.forEach((_, id) => S.palms.add(id));
    S.touches.clear(); S.gesture = null;
    if (S.pan && S.pan.pointerType === 'touch') { S.pan = null; if (S.scroller) S.scroller.classList.remove('is-panning'); }
    if (S.active && S.active.pointerType === 'touch') cancelStroke();
  }
  function onPointerDown(e) {
    stopFling();
    if (e.target.closest('.nt-page-foot') || e.target.closest('.nt-textedit') || e.target.closest('.nt-sel-bar')) return;
    if (e.pointerType === 'pen') {
      S.lastPenAt = performance.now();
      if (!S.penSeen) {
        S.penSeen = true;
        if (S.fingerDraw && lsGet('aero_nt_finger') === null) {
          S.fingerDraw = false;
          toast('Stylus detected — write with the pencil, scroll with your finger.', 'info');
        }
      }
      dropTouches();                                     // the palm landed first — forget it
    }
    if (S.active && S.active.pointerId !== e.pointerId && S.active.pointerType === e.pointerType && e.pointerType !== 'touch') finishActive();
    if (S.active && S.active.pointerId === e.pointerId) finishActive();   // a lost pointerup — keep that stroke
    if (e.pointerType === 'touch') {
      if (S.penSeen && penBusy()) { S.palms.add(e.pointerId); return; }   // palm while writing
      S.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (S.touches.size >= 2) {                         // two fingers → scroll / zoom, cancel a finger stroke
        if (S.active && S.active.pointerType === 'touch') cancelStroke();
        startGesture();
        return;
      }
    }
    const drawsHere = !(e.pointerType === 'touch' && (!S.fingerDraw || S.tool === 'hand')) &&
                      !(S.tool === 'hand') && e.button !== 1;
    if (!drawsHere) { startPan(e); return; }
    const p = pageFromEvent(e);
    if (!p) return;
    if (!p.d) { if (p.raw != null) { p.d = decodePage(p.raw); p.raw = null; } else { queueLoad(p); return; } }
    if (S.editing) { commitText(); if (S.tool === 'text') return; }
    e.preventDefault();
    S.current = S.pages.indexOf(p);
    if (S.tool === 'text') return startText(p, pagePoint(p, e), e.pointerType);
    try { p.el.setPointerCapture(e.pointerId); } catch (_) {}
    const [x, y] = pagePoint(p, e);
    const base = { page: p, pointerId: e.pointerId, pointerType: e.pointerType, raf: 0 };
    if (S.tool === 'eraser') {
      S.active = Object.assign(base, { kind: 'erase', removed: [], addedSet: new Set(), last: [x, y] });
      eraseAt(p, x, y);
      return;
    }
    if (S.tool === 'shape') {
      S.active = Object.assign(base, { kind: 'shape', x0: x, y0: y, x1: x, y1: y });
      showOverlay(p);
      return;
    }
    if (S.tool === 'lasso') {
      if (S.sel && S.sel.page === p && insideSel(x, y)) { startMove(Object.assign(base, { kind: 'move', sx: x, sy: y, dx: 0, dy: 0 })); return; }
      clearSelection();
      S.active = Object.assign(base, { kind: 'lasso', path: [x, y] });
      showOverlay(p);
      return;
    }
    const isHl = S.tool === 'hl';
    const st = {
      tool: isHl ? TOOL_HL : TOOL_PEN,
      c: isHl ? hlInk() : penInk(),
      w: isHl ? SIZES.hl[S.size.hl] : SIZES.pen[S.size.pen],
      pts: [x, y, pressureOf(e)]
    };
    S.active = Object.assign(base, { kind: 'stroke', st, drawn: 1,
                 min: Math.max(0.8, 1.1 / (scale() * (window.devicePixelRatio || 1))), hx: e.clientX, hy: e.clientY });
    if (isHl) showOverlay(p); else armHold(S.active);
  }
  /* draw & hold: keep the pen still for a moment at the end of a stroke and a
     rough line / circle / ellipse / triangle / box becomes a clean one */
  function armHold(a) {
    clearTimeout(a.hold);
    if (!S.snap || a.snapped || a.st.tool !== TOOL_PEN) return;
    a.hold = setTimeout(() => trySnap(a), 620);
  }
  function trySnap(a) {
    if (S.active !== a || a.snapped) return;
    const pts = recognize(a.st.pts); if (!pts) return;
    a.snapped = true;
    a.st = { tool: TOOL_SHAPE, c: a.st.c, w: a.st.w, pts };
    renderPage(a.page);                                   // wipes the rough ink (not stored yet)
    if (a.page.ctx) { a.page.ctx.setTransform(a.page.k, 0, 0, a.page.k, 0, 0); drawShape(a.page.ctx, a.st); }
    try { if (navigator.vibrate) navigator.vibrate(10); } catch (_) {}
  }
  function onPointerMove(e) {
    if (e.pointerType === 'touch' && S.palms.has(e.pointerId)) return;
    if (e.pointerType === 'pen' && S.active && S.active.pointerType === 'pen') S.lastPenAt = performance.now();
    if (e.pointerType === 'touch' && S.touches.has(e.pointerId)) {
      S.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (S.gesture) { moveGesture(); return; }
    }
    if (S.pan && S.pan.pointerId === e.pointerId) {
      const pn = S.pan, now = performance.now(), dt = Math.max(1, now - pn.lt);
      S.scroller.scrollLeft = pn.sl - (e.clientX - pn.x);
      S.scroller.scrollTop = pn.st - (e.clientY - pn.y);
      pn.vx = pn.vx * 0.6 + ((e.clientX - pn.lx) / dt) * 0.4; pn.vy = pn.vy * 0.6 + ((e.clientY - pn.ly) / dt) * 0.4;
      pn.lx = e.clientX; pn.ly = e.clientY; pn.lt = now;
      return;
    }
    const a = S.active; if (!a || a.pointerId !== e.pointerId) return;
    e.preventDefault();
    let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (!evs || !evs.length) evs = [e];
    if (a.kind === 'shape' || a.kind === 'lasso' || a.kind === 'move') {
      const [x, y] = pagePoint(a.page, evs[evs.length - 1]);
      if (a.kind === 'shape') { a.x1 = x; a.y1 = y; }
      else if (a.kind === 'move') { a.dx = x - a.sx; a.dy = y - a.sy; }
      else for (const ev of evs) { const q = pagePoint(a.page, ev), L = a.path.length; if (Math.abs(q[0] - a.path[L - 2]) + Math.abs(q[1] - a.path[L - 1]) > 4) a.path.push(q[0], q[1]); }
      if (!a.raf) a.raf = requestAnimationFrame(() => drawAux(a));
      return;
    }
    if (a.kind === 'erase') {                            // walk the path so a quick swipe can't skip a stroke
      const r = SIZES.eraser[S.size.eraser] * 0.6;
      for (const ev of evs) {
        const [x, y] = pagePoint(a.page, ev), [lx, ly] = a.last;
        const n = Math.min(40, Math.ceil(Math.hypot(x - lx, y - ly) / r));
        for (let i = 1; i <= n; i++) eraseAt(a.page, lx + (x - lx) * i / n, ly + (y - ly) * i / n);
        a.last = [x, y];
      }
      return;
    }
    if (a.snapped) return;                               // already turned into a clean shape
    if (Math.abs(e.clientX - a.hx) + Math.abs(e.clientY - a.hy) > 7) { a.hx = e.clientX; a.hy = e.clientY; armHold(a); }
    const pts = a.st.pts;
    for (const ev of evs) {
      const [x, y] = pagePoint(a.page, ev);
      const lx = pts[pts.length - 3], ly = pts[pts.length - 2];
      if (Math.abs(x - lx) + Math.abs(y - ly) < a.min) continue;
      pts.push(x, y, pressureOf(ev));
    }
    /* ink is drawn right here, in the event — pointer events already arrive
       once per display frame, so waiting for the next frame only adds lag.
       The translucent highlighter redraws its overlay once per frame. */
    if (a.st.tool === TOOL_HL) { if (!a.raf) a.raf = requestAnimationFrame(() => drawLive(a)); }
    else drawLive(a);
  }
  /* previews that live on the overlay: shape being dragged, lasso path, moving selection */
  function drawAux(a) {
    a.raf = 0;
    if (S.active !== a) return;
    const o = S.overlay;
    if (a.kind === 'move') {
      const u = scale(), tr = `translate(${(a.dx * u).toFixed(1)}px, ${(a.dy * u).toFixed(1)}px)`;
      if (o) o.c.style.transform = tr;
      if (S.sel && S.sel.box) S.sel.box.style.transform = tr;
      return;
    }
    if (!o) return;
    o.ctx.setTransform(1, 0, 0, 1, 0, 0); o.ctx.clearRect(0, 0, o.c.width, o.c.height);
    o.ctx.setTransform(a.page.k, 0, 0, a.page.k, 0, 0);
    if (a.kind === 'shape') {
      drawShape(o.ctx, { tool: S.dashed ? TOOL_DASH : TOOL_SHAPE, c: penInk(), w: SIZES.pen[S.size.pen], pts: shapePoints(S.shape, a.x0, a.y0, a.x1, a.y1, SIZES.pen[S.size.pen]) });
    } else if (a.kind === 'lasso') {
      const P = a.path, k = 1 / a.page.k * (window.devicePixelRatio || 1);
      o.ctx.save(); o.ctx.lineWidth = 2.2 * k; o.ctx.setLineDash([8 * k, 6 * k]); o.ctx.strokeStyle = '#4f46e5'; o.ctx.fillStyle = 'rgba(99,102,241,.07)';
      o.ctx.beginPath(); o.ctx.moveTo(P[0], P[1]); for (let i = 2; i < P.length; i += 2) o.ctx.lineTo(P[i], P[i + 1]);
      o.ctx.closePath(); o.ctx.fill(); o.ctx.stroke(); o.ctx.restore();
    }
  }
  function drawLive(a, force) {
    a.raf = 0;
    if (a.snapped) return;
    if (S.active !== a && !force) return;
    const n = a.st.pts.length / 3;
    if (a.st.tool === TOOL_HL) {                         // translucent: redraw on the light overlay only
      const o = S.overlay; if (!o) return;
      o.ctx.setTransform(1, 0, 0, 1, 0, 0); o.ctx.clearRect(0, 0, o.c.width, o.c.height);
      o.ctx.setTransform(a.page.k, 0, 0, a.page.k, 0, 0); drawHL(o.ctx, a.st);
      return;
    }
    const ctx = a.page.ctx; if (!ctx) return;
    ctx.setTransform(a.page.k, 0, 0, a.page.k, 0, 0);
    ctx.strokeStyle = a.st.c; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let i = Math.max(1, a.drawn); i < n; i++) penSeg(ctx, a.st, i);  // only the NEW segments
    a.drawn = n;
  }
  function onPointerUp(e) {
    if (e.pointerType === 'touch' && S.palms.has(e.pointerId)) { S.palms.delete(e.pointerId); return; }
    if (S.editing && S.editing.needFocus && e.type === 'pointerup') {
      S.editing.needFocus = false;
      try { S.editing.ta.focus({ preventScroll: true }); } catch (_) {}
    }
    if (e.pointerType === 'pen') S.lastPenAt = performance.now();
    if (e.pointerType === 'touch') {
      S.touches.delete(e.pointerId);
      if (S.gesture && S.touches.size < 2) endGesture();
    }
    if (S.pan && S.pan.pointerId === e.pointerId) {
      const pn = S.pan; S.pan = null; S.scroller.classList.remove('is-panning');
      if (e.pointerType === 'touch' && e.type === 'pointerup' && performance.now() - pn.lt < 80) startFling(pn.vx, pn.vy);
      return;
    }
    const a = S.active; if (!a || a.pointerId !== e.pointerId) return;
    finishActive();
  }
  function commitErase(a) {
    const added = Array.from(a.addedSet || []);
    if (a.removed.length || added.length) { pushUndo({ k: 'replace', pid: a.page.id, removed: a.removed, added }); markDirty(a.page); }
  }
  function finishActive() {
    const a = S.active; if (!a) return;
    S.active = null;
    if (a.raf) cancelAnimationFrame(a.raf);
    clearTimeout(a.hold);
    const p = a.page;
    if (a.kind === 'erase') { commitErase(a); return; }
    if (a.kind === 'lasso') { hideOverlay(); finishLasso(p, a.path); return; }
    if (a.kind === 'move') { finishMove(a); return; }
    if (a.kind === 'shape') {
      hideOverlay();
      if (Math.hypot(a.x1 - a.x0, a.y1 - a.y0) < 12) return;          // a tap, not a shape
      const w = SIZES.pen[S.size.pen];
      const st = withBox({ tool: S.dashed ? TOOL_DASH : TOOL_SHAPE, c: penInk(), w, pts: shapePoints(S.shape, a.x0, a.y0, a.x1, a.y1, w).map((v, i) => i % 3 === 2 ? v : Math.round(v)) });
      p.d.s.push(st);
      if (p.ctx) { p.ctx.setTransform(p.k, 0, 0, p.k, 0, 0); drawShape(p.ctx, st); }
      pushUndo({ k: 'add', pid: p.id, kind: 's', item: st });
      markDirty(p);
      return;
    }
    if (!a.snapped) drawLive(a, true);
    const st = withBox(a.st);
    st.pts = st.pts.map((v, i) => i % 3 === 2 ? v : Math.round(v));   // integers, as stored
    p.d.s.push(st);
    hideOverlay();
    if (st.tool === TOOL_HL) renderPage(p);               // highlighter goes under the ink
    else if (a.snapped) { /* already drawn clean */ }
    else if (p.ctx) { p.ctx.setTransform(p.k, 0, 0, p.k, 0, 0); penTail(p.ctx, st); }
    pushUndo({ k: 'add', pid: p.id, kind: 's', item: st });
    markDirty(p);
  }
  function cancelStroke() {
    const a = S.active; if (!a) return;
    S.active = null; hideOverlay(); clearTimeout(a.hold);
    if (a.kind === 'erase') commitErase(a);
    else if (a.kind === 'move') { if (S.sel) S.sel.hidden = null; if (S.sel && S.sel.box) S.sel.box.style.transform = ''; renderPage(a.page); }
    else if (a.kind !== 'lasso' && a.kind !== 'shape') renderPage(a.page);
  }
  function showOverlay(p) {
    if (!S.overlay) {
      const c = document.createElement('canvas'); c.className = 'nt-ink nt-overlay';
      S.overlay = { c, ctx: c.getContext('2d') };
    }
    const o = S.overlay;
    o.c.width = p.canvas.width; o.c.height = p.canvas.height;
    p.el.appendChild(o.c);
  }
  function hideOverlay() {
    const o = S.overlay; if (!o) return;
    o.c.remove(); o.c.width = 0; o.c.height = 0;          // no memory kept between strokes
    o.c.style.transform = '';
  }

  /* ---------- eraser (whole strokes, like GoodNotes' stroke eraser) ---------- */
  function segDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
    let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0; t = clamp(t, 0, 1);
    const x = ax + t * dx - px, y = ay + t * dy - py; return x * x + y * y;
  }
  function strokeHit(st, x, y, lim) {
    const pts = st.pts, shape = isShape(st);
    if (pts.length === 3) return (pts[0] - x) ** 2 + (pts[1] - y) ** 2 <= lim;
    for (let k = 3; k < pts.length; k += 3) {
      if (shape && pts[k + 2] === 0) continue;            // gap between sub-paths
      if (segDist2(x, y, pts[k - 3], pts[k - 2], pts[k], pts[k + 1]) <= lim) return true;
    }
    return false;
  }
  /* precise eraser: cut the stroke where the eraser touches it, keep the rest */
  function splitStroke(st, x, y, lim, step) {
    const src = st.pts, shape = isShape(st), P = [];
    for (let i = 0; i < src.length; i += 3) {
      const nx = src[i], ny = src[i + 1], nq = src[i + 2];
      if (i && !(shape && nq === 0)) {
        const px = src[i - 3], py = src[i - 2], pq = src[i - 1], gap = Math.hypot(nx - px, ny - py);
        const n = Math.min(400, Math.ceil(gap / step) - 1);
        for (let k = 1; k <= n; k++) { const f = k / (n + 1); P.push(px + (nx - px) * f, py + (ny - py) * f, shape ? 1 : Math.round(pq + (nq - pq) * f)); }
      }
      P.push(nx, ny, nq);
    }
    const pieces = []; let cur = [];
    const flush = () => { if (cur.length >= 6) { if (shape) cur[2] = 0; pieces.push(withBox({ tool: st.tool, c: st.c, w: st.w, pts: cur })); } cur = []; };
    for (let i = 0; i < P.length; i += 3) {
      if ((P[i] - x) ** 2 + (P[i + 1] - y) ** 2 <= lim) flush();
      else { if (shape && P[i + 2] === 0) flush(); cur.push(P[i], P[i + 1], P[i + 2]); }
    }
    flush();
    return pieces;
  }
  function eraseAt(p, x, y) {
    const a = S.active, r = SIZES.eraser[S.size.eraser];
    const d = p.d; let hit = false;
    for (let i = d.s.length - 1; i >= 0; i--) {
      const st = d.s[i], bb = st.bb, pad = r + st.w;
      if (x < bb[0] - pad || x > bb[2] + pad || y < bb[1] - pad || y > bb[3] + pad) continue;
      const lim = (r + st.w / 2) * (r + st.w / 2);
      if (!strokeHit(st, x, y, lim)) continue;
      const pieces = S.eraseMode === 'precise' ? splitStroke(st, x, y, lim, Math.max(3, r / 2.5)) : [];
      d.s.splice(i, 1, ...pieces);
      if (a.addedSet.has(st)) a.addedSet.delete(st); else a.removed.push({ kind: 's', idx: i, item: st });
      pieces.forEach(pc => a.addedSet.add(pc));
      hit = true;
    }
    const mctx = measureCtx();
    for (let i = d.t.length - 1; i >= 0; i--) {
      const t = d.t[i], h = textBox(mctx, t).h;
      if (x >= t.x - r && x <= t.x + t.w + r && y >= t.y - r && y <= t.y + h + r) { a.removed.push({ kind: 't', idx: i, item: t }); d.t.splice(i, 1); hit = true; }
    }
    if (hit) scheduleRender(p);
  }
  let _mctx = null;
  function measureCtx() { if (!_mctx) _mctx = document.createElement('canvas').getContext('2d'); return _mctx; }

  /* =========================================================
     LASSO SELECTION — move, recolour, duplicate, delete
     ========================================================= */
  function pointInPoly(x, y, P) {
    let inside = false;
    for (let i = 0, j = P.length - 2; i < P.length; j = i, i += 2) {
      const xi = P[i], yi = P[i + 1], xj = P[j], yj = P[j + 1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
    }
    return inside;
  }
  function itemBox(it) {
    if (it.kind === 's') { const b = it.item.bb, h = it.item.w / 2; return [b[0] - h, b[1] - h, b[2] + h, b[3] + h]; }
    const t = it.item, h = textBox(measureCtx(), t).h; return [t.x, t.y, t.x + t.w, t.y + h];
  }
  function selBox(items) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    items.forEach(it => { const q = itemBox(it); a = Math.min(a, q[0]); b = Math.min(b, q[1]); c = Math.max(c, q[2]); d = Math.max(d, q[3]); });
    return [a, b, c, d];
  }
  function finishLasso(p, path) {
    if (!p.d || path.length < 8) return;
    const items = [];
    p.d.s.forEach(st => {
      const n = st.pts.length / 3, stepN = Math.max(1, Math.floor(n / 30)); let tot = 0, ins = 0;
      for (let i = 0; i < n; i += stepN) { tot++; if (pointInPoly(st.pts[i * 3], st.pts[i * 3 + 1], path)) ins++; }
      if (tot && ins / tot >= 0.5) items.push({ kind: 's', item: st });
    });
    const mctx = measureCtx();
    p.d.t.forEach(t => { const h = textBox(mctx, t).h; if (pointInPoly(t.x + Math.min(t.w, 300) / 2, t.y + h / 2, path)) items.push({ kind: 't', item: t }); });
    if (!items.length) { toast('Nothing inside — draw a loop around your writing.', 'info'); return; }
    select(p, items);
  }
  function select(p, items) {
    clearSelection();
    S.sel = { page: p, items, hidden: null };
    showSelectionUI();
  }
  function insideSel(x, y) {
    if (!S.sel) return false;
    const [a, b, c, d] = selBox(S.sel.items), pad = 24;
    return x >= a - pad && x <= c + pad && y >= b - pad && y <= d + pad;
  }
  function showSelectionUI() {
    const sl = S.sel; if (!sl || !sl.page.el) return;
    if (sl.box) sl.box.remove(); if (sl.bar) sl.bar.remove();
    const u = scale(), [a, b, c, d] = selBox(sl.items), pad = 14;
    const box = document.createElement('div');
    box.className = 'nt-sel';
    Object.assign(box.style, { left: ((a - pad) * u) + 'px', top: ((b - pad) * u) + 'px', width: ((c - a + pad * 2) * u) + 'px', height: ((d - b + pad * 2) * u) + 'px' });
    const bar = document.createElement('div');
    bar.className = 'nt-sel-bar';
    bar.innerHTML = `<span class="nt-sel-n">${sl.items.length} selected</span>
      <button type="button" data-sel="color" title="Colour" aria-label="Change colour"><i class="fas fa-palette"></i></button>
      <button type="button" data-sel="dup" title="Duplicate" aria-label="Duplicate"><i class="fas fa-clone"></i></button>
      <button type="button" data-sel="del" class="danger" title="Delete" aria-label="Delete"><i class="fas fa-trash"></i></button>
      <button type="button" data-sel="done" title="Done" aria-label="Done"><i class="fas fa-check"></i></button>`;
    const topPx = (b - pad) * u - 46;
    Object.assign(bar.style, { left: Math.max(4, (a - pad) * u) + 'px', top: (topPx > 4 ? topPx : (d + pad) * u + 8) + 'px' });
    sl.page.el.appendChild(box); sl.page.el.appendChild(bar);
    sl.box = box; sl.bar = bar;
  }
  function clearSelection() {
    const sl = S.sel; if (!sl) return;
    S.sel = null;
    if (sl.box) sl.box.remove(); if (sl.bar) sl.bar.remove();
    if (sl.hidden) renderPage(sl.page);
  }
  function startMove(a) {
    const sl = S.sel, p = a.page;
    S.active = a;
    sl.hidden = new Set(sl.items.map(it => it.item));
    renderPage(p);                                        // page without the selection…
    showOverlay(p);                                       // …and the selection on the overlay, moved by CSS only
    const o = S.overlay;
    o.ctx.setTransform(p.k, 0, 0, p.k, 0, 0);
    sl.items.forEach(it => { if (it.kind === 's') drawStroke(o.ctx, it.item); else drawText(o.ctx, it.item); });
  }
  function moveItems(items, dx, dy) {
    items.forEach(it => {
      if (it.kind === 's') { const q = it.item.pts; for (let i = 0; i < q.length; i += 3) { q[i] = Math.round(q[i] + dx); q[i + 1] = Math.round(q[i + 1] + dy); } withBox(it.item); }
      else { it.item.x = Math.round(it.item.x + dx); it.item.y = Math.round(it.item.y + dy); }
    });
  }
  function finishMove(a) {
    const sl = S.sel, p = a.page;
    hideOverlay();
    if (sl) { sl.hidden = null; if (sl.box) sl.box.style.transform = ''; }
    if (sl && (Math.abs(a.dx) > 0.5 || Math.abs(a.dy) > 0.5)) {
      const dx = Math.round(a.dx), dy = Math.round(a.dy);
      moveItems(sl.items, dx, dy);
      pushUndo({ k: 'move', pid: p.id, items: sl.items.slice(), dx, dy });
      markDirty(p);
    }
    renderPage(p);
    if (S.sel) showSelectionUI();
  }
  function cloneItem(it) {
    if (it.kind === 's') return { kind: 's', item: withBox({ tool: it.item.tool, c: it.item.c, w: it.item.w, pts: it.item.pts.slice() }) };
    return { kind: 't', item: Object.assign({}, it.item) };
  }
  function selectionAction(act, btn) {
    const sl = S.sel; if (!sl) return;
    const p = sl.page;
    if (act === 'done') { clearSelection(); return; }
    if (act === 'del') {
      const rem = [];
      ['s', 't'].forEach(kind => {
        const arr = kind === 't' ? p.d.t : p.d.s;
        sl.items.filter(it => it.kind === kind).map(it => ({ it, idx: arr.indexOf(it.item) })).filter(o => o.idx >= 0)
          .sort((x, y) => y.idx - x.idx).forEach(o => { arr.splice(o.idx, 1); rem.push({ kind, idx: o.idx, item: o.it.item }); });
      });
      clearSelection();
      if (rem.length) { pushUndo({ k: 'replace', pid: p.id, removed: rem, added: [] }); markDirty(p); renderPage(p); }
      return;
    }
    if (act === 'dup') {
      const copies = sl.items.map(cloneItem);
      moveItems(copies, 40, 40);
      copies.forEach(c => (c.kind === 't' ? p.d.t : p.d.s).push(c.item));
      pushUndo({ k: 'addMany', pid: p.id, items: copies });
      markDirty(p); renderPage(p); select(p, copies);
      return;
    }
    if (act === 'color') {
      const items = sl.items.slice();
      const first = items[0] && (items[0].item.c);
      colorPicker(btn, (hex) => {
        const last = S.undo[S.undo.length - 1];
        if (last && last.k === 'recolor' && last.items === items) last.after = hex;
        else pushUndo({ k: 'recolor', pid: p.id, items, before: items.map(it => it.item.c), after: hex });
        items.forEach(it => { it.item.c = hex; });
        markDirty(p); renderPage(p);
      }, first);
    }
  }

  /* ---------- text boxes ---------- */
  function startText(p, pt, ptype) {
    const ctx = p.ctx; if (!ctx) return;
    let idx = -1;
    for (let i = p.d.t.length - 1; i >= 0; i--) {
      const t = p.d.t[i], h = textBox(ctx, t).h;
      if (pt[0] >= t.x - 10 && pt[0] <= t.x + t.w + 10 && pt[1] >= t.y - 10 && pt[1] <= t.y + h + 10) { idx = i; break; }
    }
    let t, before = null;
    if (idx >= 0) { t = p.d.t[idx]; before = Object.assign({}, t); }
    else {
      const size = SIZES.text[S.size.text];
      const x = clamp(pt[0], 20, PW - 300), y = clamp(pt[1] - size * 0.6, 10, PH - size * 2);
      t = { x, y, w: Math.min(1100, PW - x - 60), s: size, c: penInk(), txt: '' };
      p.d.t.push(t); idx = p.d.t.length - 1;
    }
    S.editing = { page: p, idx, before, t };
    renderPage(p);
    const u = scale();
    const ta = document.createElement('textarea');
    ta.className = 'nt-textedit';
    ta.value = t.txt;
    ta.setAttribute('aria-label', 'Text');
    Object.assign(ta.style, {
      left: (t.x * u) + 'px', top: (t.y * u) + 'px', width: (t.w * u) + 'px',
      fontSize: (t.s * u) + 'px', lineHeight: '1.32', color: t.c, minHeight: (t.s * u * 1.5) + 'px'
    });
    const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); commitText(); }
    });
    ta.addEventListener('blur', () => setTimeout(() => { if (S.editing && S.editing.ta === ta) commitText(); }, 0));
    p.el.appendChild(ta);
    S.editing.ta = ta;
    grow();
    /* mouse: focus now. Pencil / finger: iPad & Android only open the keyboard
       for a focus made on the lift (pointerup), so onPointerUp does it then. */
    S.editing.needFocus = ptype === 'touch' || ptype === 'pen';
    if (!S.editing.needFocus) setTimeout(() => { if (S.editing && S.editing.ta === ta && document.activeElement !== ta) { try { ta.focus({ preventScroll: true }); } catch (_) {} } }, 0);
  }
  function commitText() {
    const ed = S.editing; if (!ed) return;
    S.editing = null;
    const { page: p, t, before } = ed;
    const txt = ed.ta.value.replace(/\s+$/, '');
    ed.ta.remove();
    const idx = p.d.t.indexOf(t);
    if (!txt) {
      if (idx >= 0) p.d.t.splice(idx, 1);
      if (before) { pushUndo({ k: 'erase', pid: p.id, items: [{ kind: 't', idx, item: before }] }); markDirty(p); }
    } else if (!before) {
      t.txt = txt; pushUndo({ k: 'add', pid: p.id, kind: 't', item: t }); markDirty(p);
    } else if (before.txt !== txt) {
      t.txt = txt; pushUndo({ k: 'edit', pid: p.id, item: t, before: before.txt, after: txt }); markDirty(p);
    }
    renderPage(p);
  }

  /* ---------- scrolling & zoom gestures ---------- */
  /* finger scrolling is done by hand (the canvas area has touch-action:none so a
     stylus never scrolls by accident) — a short glide afterwards keeps it natural */
  let fling = 0;
  function stopFling() { if (fling) cancelAnimationFrame(fling); fling = 0; }
  function startFling(vx, vy) {
    stopFling();
    if (Math.abs(vx) + Math.abs(vy) < 0.15) return;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(40, now - last); last = now;
      if (!S.scroller) { fling = 0; return; }
      S.scroller.scrollLeft -= vx * dt; S.scroller.scrollTop -= vy * dt;
      const f = Math.pow(0.994, dt); vx *= f; vy *= f;
      fling = Math.abs(vx) + Math.abs(vy) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    fling = requestAnimationFrame(step);
  }
  function startPan(e) {
    stopFling();
    S.pan = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, sl: S.scroller.scrollLeft, st: S.scroller.scrollTop,
              lx: e.clientX, ly: e.clientY, lt: performance.now(), vx: 0, vy: 0 };
    S.scroller.classList.add('is-panning');
    try { S.scroller.setPointerCapture(e.pointerId); } catch (_) {}
  }
  function touchMid() {
    const t = Array.from(S.touches.values()).slice(0, 2);
    return { x: (t[0].x + t[1].x) / 2, y: (t[0].y + t[1].y) / 2, d: Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y) || 1 };
  }
  function startGesture() {
    S.pan = null;
    const m = touchMid();
    S.gesture = { m, zoom: S.zoom, sl: S.scroller.scrollLeft, st: S.scroller.scrollTop };
  }
  function moveGesture() {
    const g = S.gesture, m = touchMid();
    const z = clamp(g.zoom * (m.d / g.m.d), 0.5, 3);
    if (Math.abs(z - S.zoom) > 0.01) setZoom(z, m.x, m.y, true);
    S.scroller.scrollTop -= (m.y - (g.lastY == null ? m.y : g.lastY));
    S.scroller.scrollLeft -= (m.x - (g.lastX == null ? m.x : g.lastX));
    g.lastX = m.x; g.lastY = m.y;
  }
  function endGesture() { S.gesture = null; }
  function setZoom(z, cx, cy, live) {
    z = clamp(z, 0.5, 3);
    if (!S.scroller) return;
    const r = S.scroller.getBoundingClientRect();
    const ax = (cx == null ? r.width / 2 : cx - r.left), ay = (cy == null ? r.height / 2 : cy - r.top);
    const fx = (S.scroller.scrollLeft + ax) / S.zoom, fy = (S.scroller.scrollTop + ay) / S.zoom;
    S.zoom = z;
    applyScale();
    S.scroller.scrollLeft = fx * z - ax; S.scroller.scrollTop = fy * z - ay;
    clearTimeout(S.remountTimer);
    S.remountTimer = setTimeout(() => {                 // re-rasterise once the zoom settles
      S.pages.forEach(p => { if (p.canvas) { sizeCanvas(p); renderPage(p); } });
      if (S.editing) commitText();
    }, live ? 180 : 60);
  }

  /* ---------- undo / redo ---------- */
  function pushUndo(op) { S.undo.push(op); if (S.undo.length > 150) S.undo.shift(); S.redo.length = 0; }
  function applyOp(op, reverse) {
    const p = S.byId.get(op.pid); if (!p || !p.d) return false;
    clearSelection();
    const arrOf = (kind) => kind === 't' ? p.d.t : p.d.s;
    const drop = (kind, item) => { const arr = arrOf(kind), i = arr.indexOf(item); if (i >= 0) arr.splice(i, 1); };
    if (op.k === 'replace') {                             // eraser / delete: some items out, some pieces in
      if (reverse) {
        op.added.forEach(it => drop('s', it));
        op.removed.slice().reverse().forEach(r => { const arr = arrOf(r.kind); arr.splice(Math.min(r.idx, arr.length), 0, r.item); });
      } else {
        op.removed.forEach(r => drop(r.kind, r.item));
        op.added.forEach(it => p.d.s.push(it));
      }
    } else if (op.k === 'addMany') {
      if (reverse) op.items.forEach(it => drop(it.kind, it.item)); else op.items.forEach(it => arrOf(it.kind).push(it.item));
    } else if (op.k === 'move') {
      moveItems(op.items, reverse ? -op.dx : op.dx, reverse ? -op.dy : op.dy);
    } else if (op.k === 'recolor') {
      op.items.forEach((it, i) => { it.item.c = reverse ? op.before[i] : op.after; });
    } else if (op.k === 'add') {
      const arr = op.kind === 't' ? p.d.t : p.d.s;
      if (reverse) { const i = arr.indexOf(op.item); if (i >= 0) arr.splice(i, 1); } else arr.push(op.item);
    } else if (op.k === 'erase') {
      if (reverse) op.items.slice().reverse().forEach(r => (r.kind === 't' ? p.d.t : p.d.s).splice(Math.min(r.idx, (r.kind === 't' ? p.d.t : p.d.s).length), 0, r.item));
      else op.items.forEach(r => { const arr = r.kind === 't' ? p.d.t : p.d.s; const i = arr.indexOf(r.item); if (i >= 0) arr.splice(i, 1); });
    } else if (op.k === 'edit') {
      op.item.txt = reverse ? op.before : op.after;
    } else if (op.k === 'clear') {
      if (reverse) { p.d.s = op.before.s; p.d.t = op.before.t; } else { p.d.s = []; p.d.t = []; }
    }
    renderPage(p); markDirty(p);
    const el = p.el; if (el && S.scroller) {
      const top = el.offsetTop, bot = top + el.offsetHeight;
      if (bot < S.scroller.scrollTop || top > S.scroller.scrollTop + S.scroller.clientHeight) S.scroller.scrollTop = top - 20;
    }
    return true;
  }
  function undo() { if (S.editing) commitText(); const op = S.undo.pop(); if (!op) return; applyOp(op, true); S.redo.push(op); }
  function redo() { const op = S.redo.pop(); if (!op) return; applyOp(op, false); S.undo.push(op); }

  /* ---------- pages ---------- */
  function addPage(afterIdx, data, paper) {
    const at = afterIdx == null ? S.pages.length - 1 : afterIdx;
    const prev = S.pages[at];
    const p = { id: newId(), rev: 0, paper: paper != null ? paper : (prev ? prev.paper : ''), d: data || { s: [], t: [] }, dirty: false, ver: 0, isNew: true };
    S.pages.splice(at + 1, 0, p);
    S.byId.set(p.id, p);
    const shell = pageShell(p);
    const next = S.pages[at + 2];
    if (next && next.el) S.pagesEl.insertBefore(shell, next.el); else S.pagesEl.appendChild(shell);
    S.io.observe(shell);
    renumber();
    renderSidebar();
    markDirty(p);
    saveNow();
    setTimeout(() => { S.scroller.scrollTo({ top: shell.offsetTop - 16, behavior: 'smooth' }); }, 30);
  }
  async function deletePage(p) {
    if (S.pages.length <= 1) return toast('A notebook needs at least one page.', 'info');
    if (!(await confirmBox('Delete this page?', `Page ${S.pages.indexOf(p) + 1} and everything on it will be deleted.`, 'Delete page', true))) return;
    try {
      if (!p.isNew) await api('DELETE', `${API}/${S.nb.id}/pages/${p.id}`);
      if (S.sel && S.sel.page === p) clearSelection();
      S.io.unobserve(p.el); unmountPage(p); p.el.remove();
      S.pages.splice(S.pages.indexOf(p), 1); S.byId.delete(p.id);
      lsDel(`aero_nt_${S.nb.id}_${p.id}`);
      S.undo = S.undo.filter(o => o.pid !== p.id); S.redo = S.redo.filter(o => o.pid !== p.id);
      renumber(); renderSidebar(); updateCurrent();
    } catch (e) { toast(e.message, 'error'); }
  }
  function duplicatePage(p) {
    let d = p.d; if (!d) d = decodePage(p.raw != null ? p.raw : (p.thumbRaw || ''));
    const copy = decodePage(encodePage(d));
    addPage(S.pages.indexOf(p), copy, p.paper || '');
    toast('Page duplicated.', 'success');
  }
  /* reorder: local first, then the server (after any brand-new page has been saved) */
  function movePage(from, to, scrollTo) {
    if (from === to || to < 0 || to >= S.pages.length) return;
    const [pg] = S.pages.splice(from, 1);
    S.pages.splice(to, 0, pg);
    const next = S.pages[to + 1];
    if (next && next.el) S.pagesEl.insertBefore(pg.el, next.el); else S.pagesEl.appendChild(pg.el);
    renumber(); renderSidebar(); updateCurrent();
    if (scrollTo) jumpToPage(pg.id);
    clearTimeout(S.orderTimer); S.orderTries = 0;
    S.orderTimer = setTimeout(sendOrder, 700);
  }
  async function sendOrder() {
    if (!S.nb) return;
    if (S.pages.some(p => p.isNew) || S.saving) {
      if (++S.orderTries > 40) { toast('Page order not saved — check your connection.', 'error'); return; }
      saveNow(); S.orderTimer = setTimeout(sendOrder, 700); return;
    }
    try { await api('PUT', `${API}/${S.nb.id}`, { order: S.pages.map(p => p.id) }); }
    catch (e) {
      if (e.offline && ++S.orderTries <= 40) { S.orderTimer = setTimeout(sendOrder, 4000); return; }
      toast(e.status === 409 ? 'Page order changed elsewhere — reopen the notebook.' : (e.message || 'Page order not saved.'), 'error');
    }
  }
  function jumpToPage(pid) {
    const p = S.byId.get(pid); if (!p || !p.el || !S.scroller) return;
    S.scroller.scrollTo({ top: Math.max(0, p.el.offsetTop - 12), behavior: 'smooth' });
    if (innerWidth < 900 && S.sideOpen) toggleSidebar(false);
  }

  /* ---------- pages sidebar: lazy thumbnails, jump, drag to reorder ---------- */
  const THUMB_W = 116, THUMB_H = Math.round(THUMB_W * PH / PW);
  function toggleSidebar(force) {
    S.sideOpen = force == null ? !S.sideOpen : !!force;
    const ed = S.root && S.root.querySelector('.nt-editor'); if (!ed) return;
    ed.classList.toggle('nt-side-open', S.sideOpen);
    if (innerWidth >= 900) {
      lsSet('aero_nt_side', S.sideOpen ? '1' : '0');
      requestAnimationFrame(() => { computeBase(); setZoom(S.zoom); fitBar(); });   // the paper column changed width
    }
    if (S.sideOpen) { markCurrentThumb(true); }
  }
  function renderSidebar() {
    if (!S.thumbsEl) return;
    if (S.thumbIo) S.thumbIo.disconnect();
    S.pages.forEach(unmountThumb);
    S.thumbsEl.style.setProperty('--u', String(THUMB_W / PW));
    S.thumbsEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    S.pages.forEach((p, i) => {
      const el = document.createElement('div');
      el.className = 'nt-thumb'; el.dataset.pid = p.id; el.tabIndex = 0;
      el.setAttribute('role', 'button'); el.setAttribute('aria-label', 'Go to page ' + (i + 1));
      el.innerHTML = `<div class="nt-thumb-paper"></div><span class="nt-thumb-n">${i + 1}</span><button type="button" class="nt-thumb-grip" aria-label="Drag to reorder page ${i + 1}" title="Drag to reorder"><i class="fas fa-grip-lines"></i></button>`;
      p.thumbEl = el; paintPaperClass(p);
      frag.appendChild(el);
    });
    S.thumbsEl.appendChild(frag);
    const cnt = $('#ntSideCount'); if (cnt) cnt.textContent = '(' + S.pages.length + ')';
    S.thumbIo = new IntersectionObserver((ents) => {
      ents.forEach(en => { const p = S.byId.get(en.target.dataset.pid); if (!p) return; if (en.isIntersecting) mountThumb(p); else unmountThumb(p); });
    }, { root: S.thumbsEl, rootMargin: '300px 0px' });
    S.pages.forEach(p => S.thumbIo.observe(p.thumbEl));
    S._thumbOn = null; markCurrentThumb();
  }
  function markCurrentThumb(reveal) {
    const p = S.pages[S.current]; if (!p || !p.thumbEl) return;
    if (S._thumbOn && S._thumbOn !== p.thumbEl) S._thumbOn.classList.remove('on');
    p.thumbEl.classList.add('on'); S._thumbOn = p.thumbEl;
    if (S.sideOpen && !S.thumbDrag) {
      const box = S.thumbsEl.getBoundingClientRect(), r = p.thumbEl.getBoundingClientRect();
      if (r.top < box.top + 4) S.thumbsEl.scrollTop -= (box.top - r.top + 12);
      else if (r.bottom > box.bottom - 4) S.thumbsEl.scrollTop += (r.bottom - box.bottom + 12);
    }
  }
  function mountThumb(p) {
    if (!p.thumbEl) return;
    if (!p.thumbCanvas) {
      const c = document.createElement('canvas'), dpr = Math.min(window.devicePixelRatio || 1, 2);
      c.width = Math.round(THUMB_W * dpr); c.height = Math.round(THUMB_H * dpr); c.className = 'nt-thumb-ink';
      p.thumbEl.firstElementChild.appendChild(c); p.thumbCanvas = c;
    }
    drawThumb(p);
  }
  function unmountThumb(p) {
    if (p.thumbCanvas) { p.thumbCanvas.width = p.thumbCanvas.height = 0; p.thumbCanvas.remove(); p.thumbCanvas = null; }
  }
  function drawThumb(p) {
    const c = p.thumbCanvas; if (!c) return;
    const d = p.d || (p.raw != null ? decodePage(p.raw) : (p.thumbRaw != null ? decodePage(p.thumbRaw) : null));
    if (!d) { if (!p.isNew) queueThumb(p); return; }
    const ctx = c.getContext('2d'), k = c.width / PW;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    drawContent(ctx, d);
  }
  function scheduleThumb(p) {
    (S.thumbDirty = S.thumbDirty || new Set()).add(p);
    clearTimeout(S.thumbTimer);
    S.thumbTimer = setTimeout(() => { const set = S.thumbDirty; S.thumbDirty = new Set(); set.forEach(drawThumb); }, 700);
  }
  function queueThumb(p) {
    S.thumbQueue.add(p.id);
    clearTimeout(S.thumbLoadTimer);
    S.thumbLoadTimer = setTimeout(flushThumbs, 80);
  }
  async function flushThumbs() {
    if (!S.nb) return;
    const nbId = S.nb.id;
    const ids = Array.from(S.thumbQueue).filter(id => { const p = S.byId.get(id); return p && !p.d && p.raw == null && p.thumbRaw == null && !p.loading; }).slice(0, 12);
    ids.forEach(id => S.thumbQueue.delete(id));
    if (!ids.length) { S.thumbQueue.clear(); return; }
    try {
      const j = await api('GET', `${API}/${nbId}/pages?ids=${encodeURIComponent(ids.join(','))}`);
      if (!S.nb || S.nb.id !== nbId) return;
      (j.pages || []).forEach(r => { const p = S.byId.get(r.id); if (!p || p.d) return; p.thumbRaw = r.data || ''; drawThumb(p); });
    } catch (_) { /* thumbnails are optional — try again when they scroll back in */ }
    if (S.thumbQueue.size) flushThumbs();
  }
  /* drag a thumbnail by its grip to reorder (mouse, pen and touch alike) */
  function wireSidebar() {
    const list = S.thumbsEl; if (!list) return;
    list.addEventListener('keydown', (e) => { const th = e.target.closest && e.target.closest('.nt-thumb'); if (th && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); jumpToPage(th.dataset.pid); } });
    list.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('.nt-thumb-grip'); if (!grip) return;
      e.preventDefault();
      const el = grip.closest('.nt-thumb'), from = S.pages.findIndex(p => p.id === el.dataset.pid);
      if (from < 0) return;
      const rects = S.pages.map(p => p.thumbEl.getBoundingClientRect());
      S.thumbDrag = { el, from, to: from, y0: e.clientY, st0: list.scrollTop, rects, pointerId: e.pointerId };
      el.classList.add('dragging');
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}
    });
    list.addEventListener('pointermove', (e) => {
      const g = S.thumbDrag; if (!g || g.pointerId !== e.pointerId) return;
      e.preventDefault();
      const lb = list.getBoundingClientRect();
      if (e.clientY < lb.top + 36) list.scrollTop -= 12; else if (e.clientY > lb.bottom - 36) list.scrollTop += 12;
      const dy = e.clientY - g.y0 + (list.scrollTop - g.st0);
      g.el.style.transform = `translateY(${dy}px)`;
      const y = e.clientY + (list.scrollTop - g.st0);
      let to = 0;
      g.rects.forEach((r, i) => { if (y > r.top + r.height / 2) to = i + (i >= g.from ? 0 : 1); });
      to = clamp(to, 0, S.pages.length - 1);
      if (to !== g.to) {
        g.to = to;
        list.querySelectorAll('.drop-mark').forEach(x => x.classList.remove('drop-mark', 'after'));
        const tgt = S.pages[to].thumbEl; if (tgt !== g.el) { tgt.classList.add('drop-mark'); if (to > g.from) tgt.classList.add('after'); }
      }
    });
    const end = (e) => {
      const g = S.thumbDrag; if (!g || g.pointerId !== e.pointerId) return;
      S.thumbDrag = null;
      g.el.classList.remove('dragging'); g.el.style.transform = '';
      list.querySelectorAll('.drop-mark').forEach(x => x.classList.remove('drop-mark', 'after'));
      if (e.type === 'pointerup' && g.to !== g.from) movePage(g.from, g.to);
    };
    list.addEventListener('pointerup', end);
    list.addEventListener('pointercancel', end);
  }

  function pageMenu(p, anchor) {
    const idx = S.pages.indexOf(p);
    popup(`<button type="button" data-a="add"><i class="fas fa-file-circle-plus"></i> Insert page after</button>
      <button type="button" data-a="dup"><i class="fas fa-clone"></i> Duplicate page</button>
      ${idx > 0 ? `<button type="button" data-a="up"><i class="fas fa-arrow-up"></i> Move page up</button>` : ''}
      ${idx < S.pages.length - 1 ? `<button type="button" data-a="down"><i class="fas fa-arrow-down"></i> Move page down</button>` : ''}
      <div class="nt-menu-label">This page's paper</div>
      <div class="nt-menu-papers">${PAPERS.map(x => `<button type="button" data-paper="${x.id}" class="${(p.paper || S.nb.paper) === x.id ? 'on' : ''}"><span class="nt-paper-prev nt-paper-${x.id}"></span>${x.label}</button>`).join('')}</div>
      <button type="button" data-a="png"><i class="fas fa-image"></i> Save page as image</button>
      <button type="button" data-a="clear"><i class="fas fa-broom"></i> Clear page</button>
      <button type="button" class="danger" data-a="del"><i class="fas fa-trash"></i> Delete page</button>`,
    async (e) => {
      const pp = e.target.closest('[data-paper]');
      if (pp) { p.paper = pp.dataset.paper === S.nb.paper ? '' : pp.dataset.paper; p.paperChanged = true; paintPaperClass(p); markDirty(p); closePopup(); return; }
      const a = e.target.closest('[data-a]'); if (!a) return;
      closePopup();
      if (a.dataset.a === 'add') addPage(idx);
      else if (a.dataset.a === 'dup') duplicatePage(p);
      else if (a.dataset.a === 'up') movePage(idx, idx - 1, true);
      else if (a.dataset.a === 'down') movePage(idx, idx + 1, true);
      else if (a.dataset.a === 'del') deletePage(p);
      else if (a.dataset.a === 'png') exportPng(p);
      else if (a.dataset.a === 'clear') {
        if (!p.d || (!p.d.s.length && !p.d.t.length)) return;
        if (!(await confirmBox('Clear this page?', 'Everything on this page will be removed. You can undo this.', 'Clear page', true))) return;
        pushUndo({ k: 'clear', pid: p.id, before: { s: p.d.s, t: p.d.t } });
        p.d.s = []; p.d.t = []; renderPage(p); markDirty(p);
      }
    }, { anchor, cls: 'nt-menu' });
  }
  function moreMenu(anchor) {
    popup(`<button type="button" data-a="settings"><i class="fas fa-sliders"></i> Notebook settings</button>
      <button type="button" data-a="pdf"><i class="fas fa-file-pdf"></i> Export as PDF</button>
      <button type="button" data-a="png"><i class="fas fa-image"></i> Save this page as image</button>
      <label class="nt-menu-toggle"><input type="checkbox" id="ntFinger" ${S.fingerDraw ? 'checked' : ''}> <span>Draw with finger<small>Off = fingers scroll, stylus draws</small></span></label>
      <label class="nt-menu-toggle"><input type="checkbox" id="ntSnap" ${S.snap ? 'checked' : ''}> <span>Hold to snap shapes<small>Pause at the end of a line, circle or box to make it neat</small></span></label>`,
    (e) => {
      if (e.target.id === 'ntFinger') { S.fingerDraw = e.target.checked; lsSet('aero_nt_finger', S.fingerDraw ? '1' : '0'); return; }
      if (e.target.id === 'ntSnap') { S.snap = e.target.checked; lsSet('aero_nt_snap', S.snap ? '1' : '0'); return; }
      const a = e.target.closest('[data-a]'); if (!a) return;
      closePopup();
      if (a.dataset.a === 'settings') openNotebookDialog(S.nb);
      else if (a.dataset.a === 'pdf') exportPdf();
      else if (a.dataset.a === 'png') { const p = S.pages[S.current]; if (p) exportPng(p); }
    }, { anchor, cls: 'nt-menu' });
  }

  /* ---------- any colour: palette + recents + free picker ---------- */
  function colorPicker(anchor, onPick, current) {
    const recent = recentColors();
    const cur = (current && HEX.test(current)) ? current : '#111827';
    const sw = (c) => `<button type="button" class="nt-cp-sw ${c.toLowerCase() === cur.toLowerCase() ? 'on' : ''}" data-hex="${c}" style="--c:${c}" aria-label="${c}"></button>`;
    const ov = popup(`
      <div class="nt-cp-title">Colour</div>
      <div class="nt-cp-grid">${PALETTE.map(sw).join('')}</div>
      ${recent.length ? `<div class="nt-cp-title">Recent</div><div class="nt-cp-grid nt-cp-recent">${recent.map(sw).join('')}</div>` : ''}
      <div class="nt-cp-row">
        <label class="nt-cp-any"><input type="color" id="ntColorInput" value="${cur}"><span><i class="fas fa-palette"></i> Any colour…</span></label>
        <input type="text" class="nt-cp-hex" id="ntHex" value="${cur}" maxlength="7" spellcheck="false" aria-label="Hex colour">
      </div>`,
    (e) => {
      const b = e.target.closest('[data-hex]'); if (!b) return;
      rememberColor(b.dataset.hex); onPick(b.dataset.hex); closePopup();
    }, { anchor, cls: 'nt-menu nt-cp', width: 300 });
    const inp = $('#ntColorInput', ov), hex = $('#ntHex', ov);
    if (inp) {
      inp.addEventListener('input', () => { hex.value = inp.value; onPick(inp.value); });
      inp.addEventListener('change', () => { rememberColor(inp.value); onPick(inp.value); });
    }
    if (hex) hex.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      let v = hex.value.trim(); if (!v.startsWith('#')) v = '#' + v;
      if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + v.slice(1).split('').map(ch => ch + ch).join('');
      if (!HEX.test(v)) { hex.classList.add('bad'); return; }
      rememberColor(v); onPick(v); closePopup();
    });
  }
  function shapeMenu(anchor) {
    popup(`<div class="nt-cp-title">Shapes</div>
      <div class="nt-shape-grid">${SHAPES.map(sh => `<button type="button" class="${S.shape === sh.id ? 'on' : ''}" data-shape="${sh.id}" title="${sh.label}">${shapeSvg(sh.id)}<span>${sh.label}</span></button>`).join('')}</div>
      <p class="nt-menu-note"><i class="fas fa-lightbulb"></i> Drag on the page to draw. Lines snap to 0°, 15°, 45°, 90°…; boxes and ellipses snap to squares and circles. Circle draws from its centre.</p>`,
    (e) => {
      const b = e.target.closest('[data-shape]'); if (!b) return;
      S.shape = b.dataset.shape; lsSet('aero_nt_shape', S.shape); closePopup(); renderToolOptions();
    }, { anchor, cls: 'nt-menu nt-shapes', width: 320 });
  }

  /* ---------- export (page image / whole notebook as PDF) ---------- */
  async function ensureData(nbId, pages) {
    const missing = pages.filter(p => !p.d && p.raw == null);
    for (let i = 0; i < missing.length; i += 12) {
      const chunk = missing.slice(i, i + 12);
      const j = await api('GET', `${API}/${nbId}/pages?ids=${encodeURIComponent(chunk.map(p => p.id).join(','))}`);
      (j.pages || []).forEach(r => { const p = chunk.find(x => x.id === r.id); if (p) { p.raw = r.data || ''; p.paper = r.paper || p.paper || ''; } });
    }
  }
  function rasterPage(canvas, p, nb, w) {
    const h = Math.round(w * PH / PW);
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const k = w / PW;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    drawPaper(ctx, p.paper || nb.paper, nb.paperColor);
    drawContent(ctx, p.d || decodePage(p.raw || ''));
    return canvas;
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  const safeName = (s) => String(s || 'notebook').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'notebook';
  function exportPng(p) {
    const c = rasterPage(document.createElement('canvas'), p, S.nb, 1654);
    c.toBlob(b => { if (b) download(b, `${safeName(S.nb.title)} - page ${S.pages.indexOf(p) + 1}.png`); c.width = c.height = 0; }, 'image/png');
  }
  async function exportPdfById(id) {
    toast('Preparing PDF…', 'info');
    try {
      const j = await api('GET', `${API}/${id}`);
      const pages = j.pages.map(p => ({ id: p.id, paper: p.paper || '', d: null, raw: null }));
      await ensureData(id, pages);
      await buildPdf(j.notebook, pages);
    } catch (e) { toast(e.message || 'Could not export.', 'error'); }
  }
  async function exportPdf() {
    if (S.editing) commitText();
    toast('Preparing PDF…', 'info');
    try { await ensureData(S.nb.id, S.pages); await buildPdf(S.nb, S.pages); }
    catch (e) { toast(e.message || 'Could not export.', 'error'); }
  }
  /* A tiny PDF writer: one JPEG per A4 page. Pages are rendered one at a
     time into ONE reused canvas, so memory stays flat for long notebooks. */
  async function buildPdf(nb, pages) {
    const enc = new TextEncoder();
    const canvas = document.createElement('canvas');
    const imgs = [];
    for (const p of pages) {
      rasterPage(canvas, p, nb, 1240);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.86));
      imgs.push({ bytes: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height });
      await new Promise(r => setTimeout(r, 0));          // keep the page responsive
    }
    canvas.width = canvas.height = 0;
    const parts = []; let len = 0; const offs = [];
    const put = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
    const obj = (n, body, stream) => { offs[n] = len; put(`${n} 0 obj\n${body}\n`); if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); } put('endobj\n'); };
    const W = 595.28, H = 841.89, n = imgs.length;
    put('%PDF-1.4\n%âãÏÓ\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${imgs.map((_, i) => (3 + i * 3) + ' 0 R').join(' ')}] /Count ${n} >>`);
    imgs.forEach((im, i) => {
      const pid = 3 + i * 3, cid = pid + 1, iid = pid + 2;
      const content = enc.encode(`q ${W} 0 0 ${H} 0 0 cm /Im${i} Do Q`);
      obj(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im${i} ${iid} 0 R >> >> /Contents ${cid} 0 R >>`);
      obj(cid, `<< /Length ${content.length} >>`, content);
      obj(iid, `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>`, im.bytes);
    });
    const total = 3 + n * 3;
    const xref = len;
    let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let k = 1; k < total; k++) x += String(offs[k]).padStart(10, '0') + ' 00000 n \n';
    put(x + `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    download(new Blob(parts, { type: 'application/pdf' }), safeName(nb.title) + '.pdf');
    toast('PDF ready.', 'success');
  }

  /* ---------- editor wiring ---------- */
  function onBarClick(e) {
    const tb = e.target.closest('button[data-tool]');
    if (tb) { if (S.editing) commitText(); S.tool = tb.dataset.tool; renderToolOptions(); return; }
    const cb = e.target.closest('[data-color]');
    if (cb) { if (S.tool === 'hl') { S.hlColor = +cb.dataset.color; S.hlHex = null; } else { S.penColor = +cb.dataset.color; S.penHex = null; } renderToolOptions(); return; }
    const sb = e.target.closest('[data-size]');
    if (sb) { const key = (S.tool === 'pen' || S.tool === 'shape') ? 'pen' : S.tool; S.size[key] = +sb.dataset.size; renderToolOptions(); return; }
    const eb = e.target.closest('[data-erase]');
    if (eb) { S.eraseMode = eb.dataset.erase; lsSet('aero_nt_erase', S.eraseMode); renderToolOptions(); return; }
    const sa = e.target.closest('[data-sel]');
    if (sa) { selectionAction(sa.dataset.sel, sa); return; }
    const th = e.target.closest('.nt-thumb');
    if (th && !e.target.closest('.nt-thumb-grip')) { jumpToPage(th.dataset.pid); return; }
    const pm = e.target.closest('[data-pmenu]');
    if (pm) { const p = S.byId.get(pm.dataset.pmenu); if (p) pageMenu(p, pm); return; }
    const a = e.target.closest('[data-act]'); if (!a) return;
    const act = a.dataset.act;
    if (act === 'back') { try { history.pushState(null, '', '#/notes'); } catch (_) {} closeEditor().then(() => { renderLibrary(); refreshList(); }); }
    else if (act === 'settings') openNotebookDialog(S.nb);
    else if (act === 'undo') undo();
    else if (act === 'redo') redo();
    else if (act === 'zoomin') setZoom(S.zoom * 1.25);
    else if (act === 'zoomout') setZoom(S.zoom / 1.25);
    else if (act === 'zoomfit') setZoom(1);
    else if (act === 'addpage') addPage(S.current);
    else if (act === 'more') moreMenu(a);
    else if (act === 'pickcolor') colorPicker(a, (hex) => { if (S.tool === 'hl') S.hlHex = hex; else S.penHex = hex; renderToolOptions(); }, S.tool === 'hl' ? hlInk() : penInk());
    else if (act === 'pickshape') shapeMenu(a);
    else if (act === 'dash') { S.dashed = !S.dashed; renderToolOptions(); }
    else if (act === 'side') toggleSidebar();
    else if (act === 'sideclose') toggleSidebar(false);
    else if (act === 'sideadd') addPage(S.pages.length - 1);
    else if (act === 'fullscreen') { if (fsElement()) { S.fsByUs = true; exitFullscreen(); } else enterFullscreen(); }
  }
  function onKey(e) {
    if (S.mode !== 'editor' || !S.root || !S.root.isConnected) return;
    if (e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod) return;
    if (S.sel && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); selectionAction('del'); return; }
    if (e.key === 'Escape' && S.sel) { clearSelection(); return; }
    if (e.key === 'PageDown' || e.key === 'PageUp') { e.preventDefault(); const i = clamp(S.current + (e.key === 'PageDown' ? 1 : -1), 0, S.pages.length - 1); jumpToPage(S.pages[i].id); return; }
    const map = { p: 'pen', h: 'hl', e: 'eraser', t: 'text', s: 'shape', l: 'lasso' };
    if (map[k]) { S.tool = map[k]; renderToolOptions(); }
    if (k === ' ' && S.tool !== 'hand') { e.preventDefault(); S.prevTool = S.tool; S.tool = 'hand'; renderToolOptions(); }
  }
  function onKeyUp(e) {
    if (e.key === ' ' && S.prevTool) { S.tool = S.prevTool; S.prevTool = null; renderToolOptions(); }
  }
  function onWheel(e) {
    if (!(e.ctrlKey || e.metaKey)) return;               // pinch on trackpads arrives as ctrl+wheel
    e.preventDefault();
    setZoom(S.zoom * Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY, true);
  }
  let resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (S.mode !== 'editor' || !S.scroller) return; fitBar(); computeBase(); setZoom(S.zoom); }, 150);
  }
  function wireEditor() {
    const sc = S.scroller;
    wireSidebar();
    sc.addEventListener('pointerdown', onPointerDown);
    sc.addEventListener('pointermove', onPointerMove, { passive: false });
    sc.addEventListener('pointerup', onPointerUp);
    sc.addEventListener('pointercancel', (e) => { if (S.active && S.active.pointerId === e.pointerId) cancelStroke(); onPointerUp(e); });
    sc.addEventListener('wheel', onWheel, { passive: false });
    sc.addEventListener('scroll', () => { if (!S._scrollRaf) S._scrollRaf = requestAnimationFrame(() => { S._scrollRaf = 0; updateCurrent(); }); }, { passive: true });
    sc.addEventListener('contextmenu', (e) => e.preventDefault());
    sc.addEventListener('lostpointercapture', (e) => { if (S.active && S.active.pointerId === e.pointerId) finishActive(); });
    /* iPad / iPhone Safari: stop the long-press loupe, text selection,
       double-tap zoom and "scroll instead of ink" guesses that made the
       Pencil sometimes not write. Buttons and the text box keep their taps. */
    const keepTouch = (t) => t && t.closest && t.closest('button, textarea, input, select, a, .nt-page-foot');
    const stopTouch = (e) => { if (!keepTouch(e.target) && e.cancelable) e.preventDefault(); };
    sc.addEventListener('touchstart', stopTouch, { passive: false });
    sc.addEventListener('touchmove', stopTouch, { passive: false });
    sc.addEventListener('touchend', (e) => { if (!keepTouch(e.target) && e.cancelable && e.changedTouches && e.changedTouches.length && e.touches.length === 0 && S.tool !== 'text') e.preventDefault(); }, { passive: false });
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(t => sc.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
  }

  function backupDirty() {
    if (!S.nb) return;
    S.pages.forEach(p => { if (p.dirty && p.d) lsSet(`aero_nt_${S.nb.id}_${p.id}`, JSON.stringify({ rev: p.rev, data: encodePage(p.d) })); });
  }
  async function closeEditor(silent) {
    if (S.editing) commitText();
    if (S.active) cancelStroke();
    stopFling();
    S.palms.clear(); S.touches.clear(); S.gesture = null; S.pan = null;
    backupDirty();
    if (hasUnsaved()) { try { await saveNow(); } catch (_) {} }
    clearSelection();
    if (S.io) { S.io.disconnect(); S.io = null; }
    if (S.thumbIo) { S.thumbIo.disconnect(); S.thumbIo = null; }
    clearTimeout(S.thumbTimer); clearTimeout(S.thumbLoadTimer); S.thumbQueue.clear();
    S.pages.forEach(p => { unmountThumb(p); p.thumbEl = null; p.thumbRaw = null; if (p.canvas) { p.canvas.width = p.canvas.height = 0; } p.canvas = null; p.ctx = null; p.el = null; });
    S.thumbsEl = null; S.sideEl = null; S._thumbOn = null;
    if (S.overlay) { S.overlay.c.width = S.overlay.c.height = 0; S.overlay = null; }
    if (!hasUnsaved()) { S.pages = []; S.byId = new Map(); S.nb = null; }
    S.undo = []; S.redo = [];
    S.mode = 'library';
    setEditing(false);
    exitFullscreen();
    closePopup();
  }
  async function refreshList() {
    try { await loadList(true); if (S.mode === 'library') renderLibrary(); } catch (e) { if (S.mode === 'library') renderLibrary(); }
  }

  /* ---------- global listeners (installed once) ---------- */
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', () => { if (document.hidden && hasUnsaved()) saveNow(); });
  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsaved() || !S.nb) return;
    /* the on-device copy is written now, so nothing is lost even if the tab closes */
    backupDirty();
    e.preventDefault(); e.returnValue = '';
  });

  /* =========================================================
     PUBLIC API (called by app.js)
     ========================================================= */
  window.AeroNotes = {
    /* show the library, or a notebook when an id is given */
    async show(container, notebookId) {
      if (S.root !== container) {
        S.root = container;
        container.addEventListener('click', (e) => { if (S.mode === 'library') onLibraryClick(e); else if (S.mode === 'editor') onBarClick(e); });
        container.addEventListener('keydown', (e) => {
          if (S.mode === 'library' && e.key === 'Enter' && e.target.matches && e.target.matches('[data-open]')) openNotebook(e.target.dataset.open);
        });
        container.addEventListener('input', (e) => {
          if (e.target.id === 'ntSearch') { S.filter = e.target.value; const pos = e.target.selectionStart; renderLibrary(); const s = $('#ntSearch'); if (s) { s.focus(); try { s.setSelectionRange(pos, pos); } catch (_) {} } }
        });
      }
      if (notebookId) {
        if (S.mode === 'editor' && S.nb && S.nb.id === notebookId && S.scroller && S.scroller.isConnected) return;
        if (S.openingId === notebookId) return;                       // already on its way
        return openNotebook(notebookId);
      }
      if (S.mode === 'editor') await closeEditor();
      /* app.js re-renders often (course refresh, notifications…) — keep the
         library as it is unless it is missing or older than 30 s */
      if (S.mode === 'library' && S.list && container.querySelector('.nt-lib') && Date.now() - (S.listAt || 0) < 30000) return;
      if (!S.list) { const c = cachedList(); if (c) { S.list = c.list; S.usage = c.usage || null; } }
      renderLibrary();
      try { await loadList(true); } catch (e) { if (!S.list) { S.list = []; toast(e.offline ? 'You are offline.' : e.message, 'error'); } }
      if (S.mode === 'library' && S.root === container) renderLibrary();
    },
    /* the student left the Notes section: save and give memory back */
    async suspend() {
      const root = S.root;
      if (S.mode === 'editor') await closeEditor();
      closePopup();
      if (root && S.mode === 'library' && !root.classList.contains('active')) root.innerHTML = '';   // free the DOM too
    },
    hasUnsaved,
    _test: { encodePage, decodePage, buildPdf, S }
  };
})();
