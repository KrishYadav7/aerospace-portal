#!/usr/bin/env node
/* ============================================================
   Windows icons of every AeroGyan Office app (no native tools):
     node desktop-app/office/make-office-icons.js [<office dir>]
   <office dir> (default ../../office from here) holds apps.json and
   icons/<slug>/*.png. For each app it writes desktop-app/office/<slug>/:
     icon.ico   16/24/32/48/64/128 px as 32-bit bitmaps + 256 px as PNG
                (what Windows Explorer, the taskbar and NSIS expect)
     office-icon.png   256 px — the window / notification icon (packed into src/)
   The files are committed; run this again when the icons change.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---- tiny PNG decoder (8-bit RGB / RGBA, not interlaced) → {w, h, px: RGBA Buffer} */
function readPng(file) {
  const d = fs.readFileSync(file);
  if (d.readUInt32BE(0) !== 0x89504e47) throw new Error(file + ': not a PNG');
  let pos = 8, w = 0, h = 0, type = 0;
  const idat = [];
  while (pos < d.length) {
    const n = d.readUInt32BE(pos), t = d.toString('latin1', pos + 4, pos + 8), body = d.subarray(pos + 8, pos + 8 + n);
    pos += 12 + n;
    if (t === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4); type = body[9];
      if (body[8] !== 8 || body[12] !== 0 || (type !== 2 && type !== 6)) throw new Error(file + ': unsupported PNG');
    } else if (t === 'IDAT') idat.push(body);
    else if (t === 'IEND') break;
  }
  const bpp = type === 6 ? 4 : 3, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, i = x * bpp;
      px[o] = line[i]; px[o + 1] = line[i + 1]; px[o + 2] = line[i + 2]; px[o + 3] = bpp === 4 ? line[i + 3] : 255;
    }
    prev = line;
  }
  return { w, h, px };
}

/* box-filter downscale with premultiplied alpha (clean edges) */
function resize(img, size) {
  const out = Buffer.alloc(size * size * 4), sx = img.w / size, sy = img.h / size;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const o = (yy * img.w + xx) * 4, al = img.px[o + 3];
        r += img.px[o] * al; g += img.px[o + 1] * al; b += img.px[o + 2] * al; a += al; n++;
      }
      const o = (y * size + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round(a / n);
    }
  }
  return { w: size, h: size, px: out };
}

/* one ICO entry as a 32-bit BMP (BGRA bottom-up + 1-bit AND mask) */
function bmpEntry(img) {
  const { w, h, px } = img;
  const maskStride = Math.ceil(w / 32) * 4;
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0); hdr.writeInt32LE(w, 4); hdr.writeInt32LE(h * 2, 8);
  hdr.writeUInt16LE(1, 12); hdr.writeUInt16LE(32, 14); hdr.writeUInt32LE(0, 16);
  hdr.writeUInt32LE(w * h * 4 + maskStride * h, 20);
  const xor = Buffer.alloc(w * h * 4), and = Buffer.alloc(maskStride * h);
  for (let y = 0; y < h; y++) {
    const row = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, o = (row * w + x) * 4;
      xor[o] = px[s + 2]; xor[o + 1] = px[s + 1]; xor[o + 2] = px[s]; xor[o + 3] = px[s + 3];
      if (px[s + 3] === 0) and[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([hdr, xor, and]);
}

function ico(entries) {          // entries: [{size, data}]
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let off = head.length;
  entries.forEach((e, i) => {
    const o = 6 + 16 * i;
    head[o] = e.size >= 256 ? 0 : e.size; head[o + 1] = e.size >= 256 ? 0 : e.size;
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(e.data.length, o + 8); head.writeUInt32LE(off, o + 12);
    off += e.data.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.data)]);
}

function build(officeDir) {
  const apps = JSON.parse(fs.readFileSync(path.join(officeDir, 'apps.json'), 'utf8')).apps;
  for (const a of apps) {
    const src = path.join(officeDir, 'icons', a.slug);
    const big = readPng(path.join(src, 'icon-512.png'));
    const exact = { 16: 'favicon-16.png', 32: 'favicon-32.png', 48: 'icon-48.png', 128: 'icon-128.png' };
    const entries = [16, 24, 32, 48, 64, 128].map((size) => {
      const f = exact[size] && path.join(src, exact[size]);
      let img = f && fs.existsSync(f) ? readPng(f) : null;
      if (!img || img.w !== size) img = resize(big, size);
      return { size, data: bmpEntry(img) };
    });
    const png256 = fs.readFileSync(path.join(src, 'icon-256.png'));
    entries.push({ size: 256, data: png256 });
    const out = path.join(__dirname, a.slug);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'icon.ico'), ico(entries));
    fs.writeFileSync(path.join(out, 'office-icon.png'), png256);
    console.log(a.slug.padEnd(10), 'icon.ico', fs.statSync(path.join(out, 'icon.ico')).size, 'bytes');
  }
}

if (require.main === module) build(path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'office')));
module.exports = { readPng, resize, bmpEntry, ico };
