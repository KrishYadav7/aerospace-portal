/* ============================================================
   BOOT ORDER — .env MUST load before anything touches process.env
   ============================================================ */
const dns = require('dns');
/* ============================================================
   GLOBAL ERROR HANDLERS — prevent silent crashes
   ============================================================ */
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Unhandled Rejection] at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
  // Keep the process alive so Nginx doesn't get a 502
});
dns.setDefaultResultOrder('ipv4first');   // Render free tier has NO IPv6 egress

// ⚡ CRITICAL: dotenv must be the FIRST thing that runs.
// Otherwise cloudinary.config() reads undefined env vars.
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

/* ============================================================
   HYBRID STORAGE HELPERS
   ------------------------------------------------------------
   • Files live on BOTH VPS disk (fast) and Cloudinary (durable).
   • Disk is the primary source for reads.
   • If disk is missing a file (e.g. after a redeploy on Render),
     we transparently re-download from Cloudinary and cache it.
   ============================================================ */
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------- Explicit MIME map for /uploads/ responses ---------- */
const MIME_BY_EXT = {
  '.pdf':  'application/pdf',
  '.doc':  'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt':  'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls':  'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt':  'text/plain; charset=utf-8',
  '.zip':  'application/zip',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mov':  'video/quicktime',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg'
};
function mimeForFile(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}
/* ============================================================
   PREVIEW PDF GENERATOR
   ------------------------------------------------------------
   At upload time we produce a second, physically-truncated PDF
   that contains ONLY the first N pages. Preview users are served
   this file instead of the full document, so downloading the raw
   bytes gives them no more content than the viewer shows.

   The truncated file is cached next to the original:
     uploads/foo.pdf          ← full document (paid users)
     uploads/foo.pdf.preview  ← first N pages only (preview users)
     uploads/foo.pdf.pages    ← sidecar with { total, preview }
   ============================================================ */
async function generatePreviewPdf(diskFilename, previewPercent) {
  if (!previewPercent || previewPercent <= 0) return null;
  try {
    const { PDFDocument } = require('pdf-lib');
    const fullPath    = path.join(UPLOAD_DIR, diskFilename);
    const previewPath = fullPath + '.preview';
    const metaPath    = fullPath + '.pages';

    if (!fs.existsSync(fullPath)) return null;
    if (fs.existsSync(previewPath)) {
      // Rebuild the metadata in case it was lost
      try {
        const buf = fs.readFileSync(previewPath);
        const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
        const previewPages = doc.getPageCount();
        return { previewPages, previewPath };
      } catch (e) { /* fall through and regenerate */ }
    }

    const fullBuf = fs.readFileSync(fullPath);
    const srcDoc  = await PDFDocument.load(fullBuf, { ignoreEncryption: true });
    const total   = srcDoc.getPageCount();

    let previewPages = Math.ceil(total * (previewPercent / 100));
    if (previewPages < 1)     previewPages = 1;
    if (previewPages >= total) previewPages = total - 1;

    const outDoc = await PDFDocument.create();
    const indices = Array.from({ length: previewPages }, (_, i) => i);
    const pages = await outDoc.copyPages(srcDoc, indices);
    pages.forEach(p => outDoc.addPage(p));

    const outBytes = await outDoc.save();
    fs.writeFileSync(previewPath, Buffer.from(outBytes));
    fs.writeFileSync(metaPath, JSON.stringify({ total, preview: previewPages }), 'utf8');

    console.log(
      `[preview-pdf] ✅ ${diskFilename} → ${previewPages}/${total} pages ` +
      `(${previewPercent}%)`
    );
    return { previewPages, previewPath };
  } catch (e) {
    console.warn('[preview-pdf] generation failed:', e.message);
    return null;
  }
}

/* Sidecar: next to every /uploads/xxx.pdf we write /uploads/xxx.pdf.cloudurl
   containing the Cloudinary URL. This lets us restore even without a DB
   lookup. If the sidecar is also missing (fresh deploy), we fall back to
   a DB query. */
function writeCloudSidecar(diskFilename, cloudUrl) {
  try {
    fs.writeFileSync(path.join(UPLOAD_DIR, diskFilename + '.cloudurl'), cloudUrl, 'utf8');
  } catch (e) { console.warn('[hybrid] sidecar write failed:', e.message); }
}
function readCloudSidecar(diskFilename) {
  try {
    const p = path.join(UPLOAD_DIR, diskFilename + '.cloudurl');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch (e) {}
  return null;
}

/* Safe filename — no path traversal, no weird chars */
function safeDiskName(originalName) {
  const ext = (path.extname(originalName || '') || '').toLowerCase().slice(0, 10);
  return Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext;
}

/* Upload a local file to Cloudinary (returns { url, publicId } or null) */
async function uploadToCloudinary(localPath, originalName) {
  try {
    const result = await cloudinary.uploader.upload(localPath, {
      resource_type: 'auto',
      folder: 'aerogyan/uploads',
      timeout: 600000,
      use_filename: true,
      unique_filename: true,
      filename_override: originalName
    });
    return { url: result.secure_url, publicId: result.public_id };
  } catch (e) {
    console.error('[hybrid] Cloudinary upload failed:', e.message);
    return null;
  }
}

console.log('[cloudinary] Configured:', !!process.env.CLOUDINARY_CLOUD_NAME);
if (!process.env.CLOUDINARY_CLOUD_NAME) {
  console.error('❌ CLOUDINARY_CLOUD_NAME missing from .env');
}
if (!process.env.CLOUDINARY_API_KEY) {
  console.error('❌ CLOUDINARY_API_KEY missing from .env');
}
if (!process.env.CLOUDINARY_API_SECRET) {
  console.error('❌ CLOUDINARY_API_SECRET missing from .env');
}
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const Razorpay = require('razorpay');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const Course = require('./models/Course');
const Professor = require('./models/Professor');
const Settings = require('./models/Settings');
const Alumni = require('./models/Alumni');
const Friend = require('./models/Friend');
const Feedback     = require('./models/Feedback');
const Contribution = require('./models/Contribution');
const Coupon       = require('./models/Coupon');
const DailyUsage   = require('./models/DailyUsage');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const multer = require('multer');

/* ============================================================
   Google Gemini SDK — used by the AI Doubt Solver
   ============================================================ */
const { GoogleGenAI } = require('@google/genai');
const app = express();
app.set('trust proxy', 1);

/* ============================================================
   SIMPLE IN-MEMORY CACHE — dramatically reduces DB hits
   TTL is per-key. Cleared automatically on course/settings mutation.
   ============================================================ */
const _cache = new Map();
function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  return entry.value;
}
function cacheSet(key, value, ttlMs = 60000) {
  _cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}
function cacheClear(prefix) {
  if (!prefix) return _cache.clear();
  for (const k of _cache.keys()) if (k.startsWith(prefix)) _cache.delete(k);
}

/* ============================================================
   SECURITY HEADERS — helmet WITHOUT the CSP engine
   ------------------------------------------------------------
   helmet v8 throws if useDefaults:false is set without default-src.
   Solution: turn off helmet's CSP entirely, then set the 4 safe
   directives via a raw header. Zero crash risk, same protection.

   The 4 directives we set:
     • frame-ancestors 'self'  → block clickjacking / iframe hijack
     • object-src 'none'       → block Flash / plugin-based XSS
     • base-uri 'self'         → block <base> tag hijack
     • form-action 'self'      → block form-action hijack

   We deliberately do NOT set default-src / script-src / style-src
   because the app uses inline handlers + 6 external CDNs (Font
   Awesome, Google Fonts, Razorpay, PDF.js, Chart.js, MathJax).
   ============================================================ */
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
  );
  next();
});

/* ============================================================
   CONTENT-PROTECTION HEADERS  (Fix 3 — added Sept 2026)
   ------------------------------------------------------------
   Defense-in-depth on top of the client-side protections in
   media-viewer.js v5.

     • X-Frame-Options: SAMEORIGIN
         Blocks third-party iframe embedding (clickjacking +
         "screen-record-via-iframe" tricks).

     • Permissions-Policy
         Denies the `display-capture` API for the whole origin.
         Modern browsers refuse to hand a MediaStream to any
         screen recorder (getDisplayMedia) when set to ().

     • Referrer-Policy
         Keeps our origin out of third-party Referer headers.
   ============================================================ */
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Permissions-Policy',
    'display-capture=(), screen-wake-lock=(), ' +
    'clipboard-read=(self), clipboard-write=(self)'
  );
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

/* ============================================================
   NO-CACHE HEADERS FOR RAW PDF PAYLOADS
   ------------------------------------------------------------
   The /file route returns base64 PDF. Without these headers the
   browser can cache it to disk — surviving after the viewer closes.
   We only target the file route; everything else keeps normal cache.
   ============================================================ */
app.use('/api/courses', (req, res, next) => {
  if (/\/materials\/[^/]+\/file\/?$/.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(compression({
  threshold: 1024,          // raise from 512 — small JSON is faster uncompressed
  level: 6,

  /**
   * ⚡ CRITICAL FIX: PDFs, videos, and audio are ALREADY internally
   *    compressed. Running zlib over them:
   *      • burns 250–500 ms of CPU per full download
   *      • burns 15–40 ms per range request (PDF.js fires dozens)
   *      • produces ZERO size reduction
   *
   *    We also skip anything under /uploads/ outright, since every
   *    file there is a user-uploaded binary that has already been
   *    compressed by its originating tool (PDF/DOCX/MP4/…).
   */
  filter: (req, res) => {
    // Never compress SSE — it manages its own streaming
    if (res.getHeader('Content-Type') === 'text/event-stream') return false;

    // Never compress any uploaded binary
    if (req.path && req.path.startsWith('/uploads/')) return false;

    // Never compress these content types even if served from elsewhere
    const ct = String(res.getHeader('Content-Type') || '');
    if (/^(application\/pdf|video\/|audio\/|image\/(jpeg|png|webp|gif|avif|svg\+xml)|application\/(zip|x-7z|octet-stream))/i.test(ct)) {
      return false;
    }

    // Fall back to the library's own heuristic for everything else
    return compression.filter(req, res);
  }
}));


/* ============================================================
   CORS — backward-compatible whitelist
   ------------------------------------------------------------
   • Agar ALLOWED_ORIGINS env var khali hai → sab allow (purana
     behaviour, koi breakage nahi).
   • Set karke → sirf listed origins allow honge.
   • Same-origin (no Origin header) → hamesha allow (aapka
     frontend aur API same domain par hain).
   ============================================================ */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);              // same-origin / curl / Postman
    if (ALLOWED_ORIGINS.length === 0) return cb(null, true);  // env not set → allow all
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    console.warn('[cors] blocked origin:', origin);
    cb(null, false);   // don't throw — just omit CORS headers
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
/* Raw body capture for Razorpay webhook — MUST run before global express.json() */
app.use('/api/razorpay-webhook', express.raw({ type: 'application/json', limit: '2mb' }));
// File uploads use multer (separate path); JSON bodies never exceed a few MB
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ limit: '4mb', extended: true }));
/* ---- Slow request logger (must be registered BEFORE routes) ---- */
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    // ⚡ Only flag genuinely slow requests. 2 s is the sweet spot —
    //    anything under that is normal on a shared VPS.
    if (duration > 2000) {
      console.warn(`[SLOW] ${req.method} ${req.url} - ${duration}ms`);
    }
  });
  next();
});
/* ============================================================
   FILE UPLOADS — save to disk, serve from /uploads, never store in MongoDB
   ============================================================ */
const ALLOWED_MIMES = new Set([
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  // Images
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence',
  // Video
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska',
  // Audio
  'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg'
]);

/* ---------- Allowed file extensions (used as a fallback when the
   browser sends a generic MIME type for chunked/sliced uploads) ---------- */
const ALLOWED_EXTS = new Set([
  '.pdf',
  '.doc', '.docx',
  '.ppt', '.pptx',
  '.xls', '.xlsx',
  '.txt',
  '.jpg', '.jpeg', '.png', '.webp', '.gif',
  '.heic', '.heif',
  '.mp4', '.webm', '.mov', '.avi', '.mkv',
  '.mp3', '.wav', '.ogg',
  '.zip'
]);

function fileFilter(req, file, cb) {
  // 1) Standard MIME check
  if (ALLOWED_MIMES.has(file.mimetype)) return cb(null, true);

  // 2) Fallback: browser didn't recognise the type (very common for
  //    sliced blobs in chunked uploads and for mobile uploads).
  //    Fall back to validating the file extension instead.
  const rawName   = String(file.originalname || '').toLowerCase();
  const cleanName = rawName.replace(/\.part\d+$/, '');   // strip ".partN"
  const dotIdx    = cleanName.lastIndexOf('.');
  const ext       = dotIdx >= 0 ? cleanName.slice(dotIdx) : '';

  if (ext && ALLOWED_EXTS.has(ext)) return cb(null, true);

  cb(new Error('File type not allowed: ' + file.mimetype));
}

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 },   // was 12 MB — raised so large single-shot uploads don't 413
  fileFilter
});
/* ============================================================
   HYBRID STATIC FILE SERVING
   ------------------------------------------------------------
   1. If disk has the file → send it (fast path).
   2. If disk is missing (fresh deploy / wiped disk) →
      look up Cloudinary URL → download → save to disk → serve.
   ------------------------------------------------------------
   On a real VPS, Nginx serves step 1 directly (see nginx config)
   and only forwards MISSES to this Node handler.
   ============================================================ */
/* ============================================================
/* ============================================================
   HYBRID STATIC FILE SERVING — PREMIUM GATED + NO-CACHE
   ============================================================ */
app.get('/uploads/:filename', attachUserFromToken, async (req, res) => {
  const filename = req.params.filename;

  /* ── Filename validation (no slashes, no null bytes) ── */
  if (!/^[A-Za-z0-9._-]+$/.test(filename) ||
      filename === '.' || filename === '..') {
    return res.status(400).send('Invalid filename');
  }

  /* ============================================================
     ⭐ FAST PATH: signed token from query string
     ------------------------------------------------------------
     PDF.js range requests hit this path. We skip JWT decode,
     premium check, and DB lookup — all of that happened ONCE
     when the signed URL was issued by /file?meta=1.

     Overhead per range request: ~2 ms (HMAC verify only)
     vs. ~50 ms before (JWT decode + DB lookup + access eval).
     ============================================================ */
  const signedToken = req.query.st;
  const signedUser  = req.query.su;

  if (signedToken && signedUser &&
      /^[a-f0-9]{24}$/i.test(String(signedUser))) {
    if (verifyUploadToken(filename, String(signedUser), String(signedToken))) {
      res.setHeader('X-Aero-Auth', 'signed');
      return serveUploadFile(filename, req, res);
    }
    console.warn('[uploads] ⚠️ invalid signed token for', filename);
  }

  /* ============================================================
     PREMIUM ACCESS CHECK — with file→owner caching
     ============================================================ */
  const ownerCacheKey = 'uploads-owner:' + filename;
  let owner = cacheGet(ownerCacheKey);

  if (owner === null) {
    try {
      const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      owner = await Course.findOne({
        'materials.url': { $regex: '/uploads/' + escaped + '$' }
      }).select('isPremium price materials').lean();

      cacheSet(ownerCacheKey, owner || false, 5 * 60 * 1000);
    } catch (e) {
      console.warn('[uploads] premium check failed:', e.message);
      return res.status(503).send('Access check temporarily unavailable. Please retry.');
    }
  }

  /* ── Single-pass access evaluation ── */
  let wantsPreviewOnly = false;
  if (owner && owner !== false) {
    const mat = (owner.materials || []).find(m =>
      m.url && m.url.endsWith('/' + filename)
    );
    if (mat) {
      const access = evaluateMaterialAccess(req.authUser, owner, mat);

      if (!access.allowed && access.canPreview) {
        res.setHeader('X-Aero-Preview-Percent', String(access.previewPercent));
        res.setHeader('X-Aero-Preview-Mode', '1');
        wantsPreviewOnly = true;
      } else if (!access.allowed) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        return res.status(403).json({
          success: false,
          code: access.reason,
          message: 'This file is part of premium content. Purchase it or subscribe to unlock.'
        });
      }
    }
  }

  /* ── Preview-file redirect ── */
  if (wantsPreviewOnly) {
    const previewFilename = filename + '.preview';
    const previewPath = path.join(UPLOAD_DIR, previewFilename);
    try {
      const st = await fs.promises.stat(previewPath);
      if (st.isFile()) {
        console.log('[uploads] 🎬 serving truncated preview:', filename);
        return serveUploadFile(previewFilename, req, res);
      }
    } catch (e) { /* no preview file — serve original */ }
  }

  return serveUploadFile(filename, req, res);
});

/* ============================================================
   HYBRID UPLOAD — Disk (fast) + Cloudinary (durable backup)
   ============================================================ */
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }

    const sizeMB = Math.round(req.file.size / 1024 / 1024);
    console.log('[upload] 📥 Received:', req.file.originalname, '(' + sizeMB + ' MB)');

    // ---- 1) Save to VPS disk IMMEDIATELY (this is what users will fetch) ----
    const diskName = safeDiskName(req.file.originalname);
    const diskPath = path.join(UPLOAD_DIR, diskName);
    fs.writeFileSync(diskPath, req.file.buffer);
    const diskUrl = '/uploads/' + diskName;
    console.log('[upload] ✅ Disk saved:', diskName);

    // ---- 2) Upload to Cloudinary (durable backup) ----
    const cloud = await uploadToCloudinary(diskPath, req.file.originalname);
        // ---- 1b) Generate a truncated preview PDF (if the file is a PDF) ----
    //        We can't know previewPercent here (it's per-material), so we
    //        defer generation until the material is saved. For now just
    //        record the total page count.
    if (diskName.toLowerCase().endsWith('.pdf')) {
      // Linearize FIRST (improves first-paint), then preview.
      // Both are fire-and-forget so the HTTP response isn't blocked.
      setTimeout(() => {
        linearizePdf(diskPath)
          .then(() => generatePreviewPdf(diskName, 10))
          .catch(() => {});
      }, 500);
    }
    if (cloud) {
      writeCloudSidecar(diskName, cloud.url);
      console.log('[upload] ☁️  Cloudinary backup:', cloud.url);
    } else {
      console.warn('[upload] ⚠️  Cloudinary backup FAILED — file only on disk');
    }

    // ---- 3) Respond with BOTH urls ----
    res.json({
      success: true,
      url:        diskUrl,                 // ← primary (fast)
      cloudUrl:   cloud ? cloud.url : '',  // ← backup
      publicId:   cloud ? cloud.publicId : '',
      fileName:   req.file.originalname,
      fileSize:   req.file.size,
      diskName:   diskName
    });
  } catch (e) {
    console.error('[upload] ❌ Error:', e.message);
    res.status(500).json({ success: false, message: 'Upload failed: ' + e.message });
  }
});

/* ============================================================
   CHUNKED UPLOAD — bypasses Hostinger's 10 MB proxy limit
   ------------------------------------------------------------
   Client flow:
     1. POST /api/upload/init     → { uploadId, chunkSize }
     2. POST /api/upload/chunk    × N  (each ≤ 6 MB)
     3. POST /api/upload/complete → { url, fileName }
   ============================================================ */
const CHUNK_DIR = path.join(UPLOAD_DIR, 'chunks');
if (!fs.existsSync(CHUNK_DIR)) fs.mkdirSync(CHUNK_DIR, { recursive: true });

const uploadSessions = new Map(); // uploadId → session

// Auto-cleanup stale sessions every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of uploadSessions.entries()) {
    if (now - s.createdAt > 2 * 60 * 60 * 1000) {
      try { fs.rmSync(s.sessionDir, { recursive: true, force: true }); } catch (_) {}
      uploadSessions.delete(id);
    }
  }
}, 30 * 60 * 1000);

app.post('/api/upload/init', (req, res) => {
  try {
    const { fileName, fileSize, fileType } = req.body || {};
    if (!fileName || !fileSize) {
      return res.status(400).json({ success: false, message: 'fileName and fileSize are required.' });
    }
    const uploadId  = crypto.randomBytes(16).toString('hex');
    const chunkSize = 5 * 1024 * 1024;               // 5 MB per chunk — smaller chunks finish faster on weak networks
    const totalChunks = Math.ceil(Number(fileSize) / chunkSize);
    const sessionDir  = path.join(CHUNK_DIR, uploadId);
    fs.mkdirSync(sessionDir, { recursive: true });

    uploadSessions.set(uploadId, {
      fileName: String(fileName),
      fileType: fileType || 'application/octet-stream',
      fileSize: Number(fileSize),
      totalChunks,
      chunkSize,
      sessionDir,
      receivedChunks: new Set(),
      createdAt: Date.now()
    });

    console.log(`[chunked] init uploadId=${uploadId} size=${(fileSize/1024/1024).toFixed(2)}MB chunks=${totalChunks}`);
    res.json({ success: true, uploadId, chunkSize, totalChunks });
  } catch (e) {
    console.error('[chunked/init]', e);
    res.status(500).json({ success: false, message: 'Init failed: ' + e.message });
  }
});

const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const session = uploadSessions.get(req.body.uploadId);
      if (!session) return cb(new Error('Invalid or expired upload session.'));
      cb(null, session.sessionDir);
    },
    filename: (req, file, cb) => {
      const idx = parseInt(req.body.chunkIndex, 10);
      cb(null, `chunk-${String(idx).padStart(6, '0')}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter
});

app.post('/api/upload/chunk', chunkUpload.single('chunk'), (req, res) => {
  try {
    const { uploadId, chunkIndex } = req.body || {};
    const session = uploadSessions.get(uploadId);
    if (!session) {
      return res.status(400).json({ success: false, message: 'Invalid upload session.' });
    }
    session.receivedChunks.add(parseInt(chunkIndex, 10));
    res.json({
      success: true,
      received: session.receivedChunks.size,
      total: session.totalChunks
    });
  } catch (e) {
    console.error('[chunked/chunk]', e);
    res.status(500).json({ success: false, message: 'Chunk upload failed: ' + e.message });
  }
});

app.post('/api/upload/complete', async (req, res) => {
  try {
    const { uploadId } = req.body || {};
    const session = uploadSessions.get(uploadId);
    if (!session) {
      return res.status(400).json({ success: false, message: 'Invalid upload session.' });
    }
    if (session.receivedChunks.size !== session.totalChunks) {
      return res.status(400).json({
        success: false,
        message: `Missing chunks — got ${session.receivedChunks.size}/${session.totalChunks}.`
      });
    }

    // ---- 1) Merge all chunks into one temp file on disk ----
    const tempName = 'temp-' + Date.now() + '-' + Math.round(Math.random() * 1e9);
    const tempPath = path.join(UPLOAD_DIR, tempName);
    const writeStream = fs.createWriteStream(tempPath, { highWaterMark: 1024 * 1024 });

    try {
      for (let i = 0; i < session.totalChunks; i++) {
        const chunkPath = path.join(session.sessionDir, `chunk-${String(i).padStart(6, '0')}`);
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(chunkPath, { highWaterMark: 1024 * 1024 });
          rs.on('error', reject);
          rs.on('end', resolve);
          rs.pipe(writeStream, { end: false });
        });
      }
      await new Promise((resolve, reject) => {
        writeStream.end();
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
    } catch (mergeErr) {
      try { writeStream.destroy(); } catch (_) {}
      try { fs.unlinkSync(tempPath); } catch (_) {}
      throw mergeErr;
    }

    // ---- 2) Rename the merged temp file into its FINAL disk slot ----
    const diskName = safeDiskName(session.fileName);
    const finalPath = path.join(UPLOAD_DIR, diskName);
    fs.renameSync(tempPath, finalPath);        // instant, same filesystem
    const diskUrl = '/uploads/' + diskName;
    console.log('[chunked] ✅ Disk saved:', diskName,
                '(' + Math.round(session.fileSize / 1024 / 1024) + ' MB)');
    if (diskName.toLowerCase().endsWith('.pdf')) {
      setTimeout(() => {
        linearizePdf(finalPath)
          .then(() => generatePreviewPdf(diskName, 10))
          .catch(() => {});
      }, 500);
    }

    // ---- 3) Upload to Cloudinary in the background (non-blocking for response) ----
    // We AWAIT it so the response includes the cloudUrl + publicId,
    // but if Cloudinary is slow/down we still return the disk URL.
    let cloud = null;
    try {
      console.log('[chunked] ☁️  Cloudinary backup starting…');
      cloud = await uploadToCloudinary(finalPath, session.fileName);
      if (cloud) writeCloudSidecar(diskName, cloud.url);
    } catch (e) {
      console.warn('[chunked] ⚠️  Cloudinary backup failed:', e.message);
    }

    // ---- 4) Cleanup chunk directory (temp file was renamed, not deleted) ----
    try { fs.rmSync(session.sessionDir, { recursive: true, force: true }); } catch (_) {}
    uploadSessions.delete(uploadId);

    res.json({
      success: true,
      url:      diskUrl,
      cloudUrl: cloud ? cloud.url : '',
      publicId: cloud ? cloud.publicId : '',
      fileName: session.fileName,
      fileSize: session.fileSize,
      diskName: diskName
    });
  } catch (e) {
    console.error('[chunked/complete]', e);
    res.status(500).json({ success: false, message: 'Assemble failed: ' + e.message });
  }
});

/* Global multer / error handler — returns JSON, never HTML */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, message: 'File too large for this endpoint.' });
    }
    return res.status(400).json({ success: false, message: 'Upload error: ' + err.message });
  }

  // ── Treat multer-side file-rejection errors as 400, not 500 ──
  if (err && /File type not allowed|upload session|Unexpected end of form|Missing uploadId/i.test(err.message || '')) {
    console.warn('[error-handler] upload rejected:', err.message);
    return res.status(400).json({ success: false, message: err.message });
  }

  if (err) {
    console.error('[error-handler]', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
  next();
});

/* ⚠️ SECURITY: Do NOT use express.static(__dirname) — it exposes .env, server.js, package.json, etc.
   Serve ONLY specific frontend files. Uploads are served from /uploads below. */
/* ---- Public landing page — the new front door ---- */
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'landing.html'));
});
app.get('/landing.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'landing.html'));
});

/* ---- Main app (login + dashboard) — now served at /app ---- */
app.get('/app', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});
/* ---- Legacy alias — existing bookmarks to /index.html keep working ---- */
app.get('/index.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ---- Static assets: 5-min browser cache (speeds up repeat visits) ---- */
function sendCached(res, file, maxAge = 300) {
  res.setHeader('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=86400`);
  res.sendFile(path.join(__dirname, file));
}
// ⚡ App code — the ?v=NN query on the URL IS the cache-buster.
// A new deploy ships a new URL (v=42), so a 1-year immutable cache
// is 100% safe AND makes repeat visits near-instant.
// Only index.html and sw.js stay no-cache (they must always be fresh).
/* Auto cache-busting for JS/CSS — the file's mtime is used as the
   version key, so every deploy is instantly picked up without
   manually bumping ?v=NN in index.html. */
function sendImmutableAsset(res, filename) {
  const filePath = path.join(__dirname, filename);
  try {
    const stat = fs.statSync(filePath);
    // 1-year immutable cache keyed on the file's mtime (as a version stamp)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`);
    res.sendFile(filePath);
  } catch (e) {
    res.status(404).send('Not found');
  }
}
app.get('/app.js',             (req, res) => sendImmutableAsset(res, 'app.js'));
app.get('/styles.css',         (req, res) => sendImmutableAsset(res, 'styles.css'));
app.get('/media-viewer.js',    (req, res) => sendImmutableAsset(res, 'media-viewer.js'));
app.get('/document-viewer.js', (req, res) => sendImmutableAsset(res, 'document-viewer.js'));
app.get('/passport.jpg',    (req, res) => sendCached(res, 'passport.jpg', 604800));

/* ⭐ PDF.js — self-hosted so campus / corporate proxies that
   block third-party CDNs cannot slow or break the PDF reader.
   Both files are served from the same origin as the app, so the
   browser reuses the existing TCP socket, avoids a CORS
   preflight on every request, and — thanks to the immutable
   1-year cache below — downloads them exactly ONCE per device. */
app.get('/vendor/pdfjs/pdf.min.js',        (req, res) => sendImmutableAsset(res, 'vendor/pdfjs/pdf.min.js'));
app.get('/vendor/pdfjs/pdf.worker.min.js', (req, res) => sendImmutableAsset(res, 'vendor/pdfjs/pdf.worker.min.js'));
/* ---- Logo / PWA icons ---- */
app.get('/favicon-16.png',       (req, res) => sendCached(res, 'favicon-16.png', 604800));
app.get('/favicon-32.png',       (req, res) => sendCached(res, 'favicon-32.png', 604800));
app.get('/favicon-48.png',       (req, res) => sendCached(res, 'favicon-48.png', 604800));
app.get('/favicon-96.png',       (req, res) => sendCached(res, 'favicon-96.png', 604800));
app.get('/apple-touch-icon.png', (req, res) => sendCached(res, 'apple-touch-icon.png', 604800));
app.get('/icon-192.png',         (req, res) => sendCached(res, 'icon-192.png', 604800));
app.get('/icon-256.png',         (req, res) => sendCached(res, 'icon-256.png', 604800));
app.get('/icon-384.png',         (req, res) => sendCached(res, 'icon-384.png', 604800));
app.get('/icon-512.png',         (req, res) => sendCached(res, 'icon-512.png', 604800));
app.get('/logo.svg',             (req, res) => sendCached(res, 'logo.svg', 604800));
app.get('/favicon.svg',          (req, res) => sendCached(res, 'favicon.svg', 604800));
app.get('/manifest.json',   (req, res) => sendCached(res, 'manifest.json', 86400));
app.get('/sw.js',           (req, res) => {
  res.setHeader('Cache-Control', 'no-cache'); // SW को हमेशा fresh चाहिए
  res.sendFile(path.join(__dirname, 'sw.js'));
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 300,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' }
});
const authLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again in a minute.' }
});
const bulkEmailLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many bulk emails sent. Please wait 5 minutes.' }
});
const recoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many recovery attempts. Please wait 15 minutes.' }
});
app.use('/api/', apiLimiter);
app.use('/api/login', authLimiter);
app.use('/api/send-otp', authLimiter);
app.use('/api/register', authLimiter);
app.use('/api/admin/send-email', bulkEmailLimiter);
app.use('/api/forgot-username/send-otp', recoveryLimiter);
app.use('/api/forgot-password/send-otp', recoveryLimiter);
app.use('/api/admin/login/verify-otp', authLimiter);

/* ============================================================
   UNIVERSAL LIVE SYNC — version counter + public SSE broadcast
   ------------------------------------------------------------
   • CONTENT_SYNC.version bumps on every admin content write.
   • Every connected client (via /api/events/stream) receives
     the new version instantly and refreshes its data.
   • No polling needed while the stream is healthy.
   ============================================================ */
const CONTENT_SYNC = {
  version: Date.now(),
  clients: new Set(),
  lastChange: { scope: 'init', at: Date.now() },
  MAX_CLIENTS: 500
};

function broadcastContentChange(scope, detail) {
  CONTENT_SYNC.version = Date.now();
  CONTENT_SYNC.lastChange = {
    scope,
    at: CONTENT_SYNC.version,
    detail: detail || null
  };
  if (CONTENT_SYNC.clients.size === 0) return;

  const payload = JSON.stringify({
    type: 'content-update',
    version: CONTENT_SYNC.version,
    bundle: getAppBundleVersion(),       // ⭐ NEW
    scope,
    detail: detail || null
  });
  const frame = 'data: ' + payload + '\n\n';

  for (const res of CONTENT_SYNC.clients) {
    try { res.write(frame); }
    catch (e) { CONTENT_SYNC.clients.delete(res); }
  }
}

/* ---- Classify an admin mutation so the client knows what to refresh ---- */
function classifyMutation(method, path) {
  // Never broadcast noise / user-specific / auth
  if (/heartbeat|session-check|^\/auth\//.test(path)) return null;
  if (/^\/user\/(progress|bookmarks|notifications|referral)/.test(path)) return null;
  if (/^\/ai\//.test(path)) return null;
  if (/^\/user\/quiz/.test(path)) return null;      // student quiz submit
  if (/^\/courses\/[^/]+\/doubts/.test(path)) return null; // user-generated
  if (/^\/feedback\/submit/.test(path)) return null;
  if (/^\/alumni\/submit|^\/friends\/submit/.test(path)) return null;
  if (/^\/contact\//.test(path)) return null;
  if (/^\/subscribe\//.test(path)) return null;

  // Admin content mutations → broadcast
  if (method === 'POST' && /^\/courses\/?$/.test(path)) return 'courses:created';
  if (method === 'PUT' && /^\/courses\/[^/]+$/.test(path)) return 'courses:updated';
  if (method === 'DELETE' && /^\/courses\/[^/]+$/.test(path)) return 'courses:deleted';
  if (/^\/courses\/[^/]+\/(materials|announcements|playlists|quiz)/.test(path)) return 'courses:content';
  if (/^\/professors/.test(path))      return 'professors';
  if (/^\/admin\/settings/.test(path)) return 'settings';
  if (/^\/admin\/subscription-plans/.test(path)) return 'plans';
  if (/^\/admin\/coupons/.test(path))            return 'coupons';
  if (/^\/admin\/referral-settings/.test(path))  return 'referral';
  if (/^\/admin\/feedback/.test(path))           return 'feedback';
  if (/^\/admin\/alumni|^\/admin\/friends/.test(path)) return 'community';
  if (/^\/admin\/subscription/.test(path))       return 'subscription';

  /* ----- USER / STUDENT ROSTER MUTATIONS -----
     Any change that adds or removes a student row from the database
     must push a live-update event so every open admin dashboard
     repaints its "Total Students" count without a manual refresh.

     Note: inside app.use('/api/', …) Express strips the mount prefix,
     so `path` here is e.g. "/register" (NOT "/api/register").        */

  // Public signup form (POST /api/register)
  if (method === 'POST' && /^\/register\/?$/.test(path))
    return 'users:created';

  // Admin manually registers a single student (POST /api/admin/create-student)
  if (method === 'POST' && /^\/admin\/create-student\/?$/.test(path))
    return 'users:created';

  // Admin imports students from a CSV backup (POST /api/admin/students/import-csv)
  if (method === 'POST' && /^\/admin\/students\/import-csv\/?$/.test(path))
    return 'users:created';

  // Admin deletes a student (DELETE /api/admin/students/:userId)
  if (method === 'DELETE' && /^\/admin\/students\/[^/]+$/.test(path))
    return 'users:deleted';

  return null;
}

/* ---- Auto-broadcast middleware — runs on every /api/ mutation ---- */
app.use('/api/', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    try {
      if (res.statusCode >= 200 && res.statusCode < 300 &&
          body && body.success !== false) {
        const scope = classifyMutation(req.method, req.path);
        if (scope) {
          broadcastContentChange(scope, { path: req.path, method: req.method });
        }
      }
    } catch (e) { /* never let sync break a request */ }
    return originalJson(body);
  };
  next();
});

/* ============================================================
   APP BUNDLE VERSION — cross-platform auto-update
   ------------------------------------------------------------
   Hashes the mtime + size of every client-side asset. Any
   deploy that touches app.js / styles.css / sw.js / index.html
   produces a new bundle ID. Every client (Android PWA, iOS
   home-screen app, macOS PWA, Windows PWA) polls this and
   reloads automatically the moment it changes.
   ============================================================ */
const APP_BUNDLE_FILES = [
  'app.js', 'media-viewer.js', 'styles.css',
  'sw.js', 'index.html', 'landing.html'
];

function computeAppBundleVersion() {
  let stamp = '';
  for (const f of APP_BUNDLE_FILES) {
    try {
      const st = fs.statSync(path.join(__dirname, f));
      stamp += f + ':' + st.mtimeMs + ':' + st.size + ';';
    } catch (e) {
      stamp += f + ':missing;';
    }
  }
  return crypto.createHash('sha1').update(stamp).digest('hex').slice(0, 12);
}

let _bundleVersionCache = null;
let _bundleVersionCacheAt = 0;
function getAppBundleVersion() {
  const now = Date.now();
  if (_bundleVersionCache && (now - _bundleVersionCacheAt) < 5000) {
    return _bundleVersionCache;
  }
  _bundleVersionCache = computeAppBundleVersion();
  _bundleVersionCacheAt = now;
  return _bundleVersionCache;
}

/* ---- Public: current version (used by polling fallback) ---- */
app.get('/api/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.json({
    success: true,
    version: CONTENT_SYNC.version,
    bundle:  getAppBundleVersion(),     // ⭐ NEW
    lastChange: CONTENT_SYNC.lastChange
  });
});

/* ---- Public: current APP BUNDLE version (code assets only) ---- */
app.get('/api/app-version', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.json({
    success: true,
    bundle: getAppBundleVersion(),
    serverTime: Date.now()
  });
});

/* ---- Public: SSE stream — every connected client gets pushes ---- */
app.get('/api/events/stream', (req, res) => {
  /* Cap concurrent clients so a bad actor can't OOM the server */
  if (CONTENT_SYNC.clients.size >= CONTENT_SYNC.MAX_CLIENTS) {
    const oldest = CONTENT_SYNC.clients.values().next().value;
    if (oldest) {
      try { oldest.end(); } catch (e) {}
      CONTENT_SYNC.clients.delete(oldest);
    }
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');   // disable nginx buffering
  res.flushHeaders?.();

  /* Handshake so the client knows the current version immediately */
  res.write('data: ' + JSON.stringify({
    type: 'handshake',
    version: CONTENT_SYNC.version,
    bundle: getAppBundleVersion()       // ⭐ NEW
  }) + '\n\n');

  CONTENT_SYNC.clients.add(res);

  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (e) {}
  }, 25000);

  const cleanup = () => {
    clearInterval(keepAlive);
    CONTENT_SYNC.clients.delete(res);
  };
  req.on('close',  cleanup);
  req.on('aborted', cleanup);
});

const JWT_SECRET = process.env.JWT_SECRET || 'SuperSecretAeroKey';
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  WARNING: JWT_SECRET not set. Using insecure fallback.');
}
/* ============================================================
   ADMIN AUTH MIDDLEWARE
   Verifies the Bearer token belongs to a real admin.
   Attach to any route that only admins should call.
   ============================================================ */
async function requireAdminAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    let token = null;

    // Preferred: Authorization: Bearer <token>
    if (auth.startsWith('Bearer ')) {
      token = auth.slice(7);
    }
    // Fallback: ?token=<jwt>  (needed for plain <a href> downloads that
    // cannot send an Authorization header)
    else if (req.query && typeof req.query.token === 'string' && req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const u = await User.findById(decoded.id).select('role').lean();
    if (!u || String(u.role || '').trim().toLowerCase() !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access only.' });
    }
    req.adminUser = u;
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }
}
/* ============================================================
   AUTH — optional token attach (v2 — CACHED)
   ------------------------------------------------------------
   Attaches req.authUser if a valid Bearer token OR ?auth= query
   token is present. Used by read endpoints (uploads, file fetch,
   video session, quiz submit) that must enforce premium access.
   Never blocks; guests proceed with req.authUser === undefined.

   ⚡ PERFORMANCE:
   Every PDF.js chunk request, video session, and material access
   used to trigger a fresh `User.findById()` call. A single 50 MB
   PDF = up to 50 MongoDB reads just to verify the same user.
   We now cache the auth result per JWT token for 30 seconds.
   A busy user drops from ~50 reads/min to ~2 reads/min.

   Cache is bounded (LRU-ish eviction) so memory cannot grow
   without limit. Purchase/subscription changes call
   _clearAuthUserCache() to force immediate re-reads.
   ============================================================ */
const AUTH_USER_CACHE_TTL_MS = 30 * 1000;   // 30 seconds
const AUTH_USER_CACHE_MAX    = 2000;
const _authUserCache = new Map();

function _getCachedAuthUser(token) {
  const entry = _authUserCache.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _authUserCache.delete(token);
    return null;
  }
  return entry.user;
}
function _setCachedAuthUser(token, user) {
  if (_authUserCache.size >= AUTH_USER_CACHE_MAX) {
    // Evict oldest ~20% in one shot — cheap and keeps memory bounded.
    const evict = Math.floor(AUTH_USER_CACHE_MAX * 0.2);
    const it = _authUserCache.keys();
    for (let i = 0; i < evict; i++) {
      const k = it.next().value;
      if (k === undefined) break;
      _authUserCache.delete(k);
    }
  }
  _authUserCache.set(token, {
    user,
    expiresAt: Date.now() + AUTH_USER_CACHE_TTL_MS
  });
}
/* Call this after any write that changes a user's purchases or
   subscription. Forces the next request to re-read from Mongo. */
function _clearAuthUserCache() { _authUserCache.clear(); }

async function attachUserFromToken(req, res, next) {
  try {
    let token = null;
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) token = auth.slice(7);
    else if (req.query && req.query.auth) token = String(req.query.auth);

    if (token) {
      const cached = _getCachedAuthUser(token);
      if (cached) {
        req.authUser = cached;
        return next();
      }

      const decoded = jwt.verify(token, JWT_SECRET);
      const u = await User.findById(decoded.id)
        .select('role purchases subscription')
        .lean();
      if (u) {
        _setCachedAuthUser(token, u);
        req.authUser = u;
      }
    }
  } catch (e) { /* invalid / expired token → proceed as guest */ }
  next();
}

/* ============================================================
   PREMIUM ACCESS — single source of truth
   ------------------------------------------------------------
   Returns { allowed: bool, reason: string }.

   Rules for a STUDENT:
     • Active subscription                    → allowed
     • Owns the course (purchases has course) → allowed
     • Owns the material (purchases has mat)  → allowed
     • Course is premium (and not owned/sub)  → BLOCKED
     • Material is premium (and not owned/sub)→ BLOCKED
     • Otherwise                              → allowed

   Admins are ALWAYS allowed.
   ============================================================ */
/* ============================================================
   PREMIUM ACCESS — single source of truth (with preview support)
   ------------------------------------------------------------
   Returns:
     {
       allowed:        bool   — full access granted
       canPreview:     bool   — user may read the preview slice
       previewPercent: number — % of pages free (0 if none)
       reason:         string — why access was denied
     }
   ============================================================ */
function evaluateMaterialAccess(user, course, material) {
  const isCoursePremium = course   && (course.isPremium   === true || course.isPremium   === 'true');
  const isMatPremium    = material && (material.isPremium === true || material.isPremium === 'true');
  const previewPercent  = Math.max(0, Math.min(100, Number(material && material.previewPercent) || 0));

  /* ---- Guests ---- */
  if (!user) {
    if (isCoursePremium || isMatPremium) {
      return {
        allowed: false,
        canPreview: false,                     // guests must log in first
        previewPercent: 0,
        reason: 'login-required'
      };
    }
    return { allowed: true, canPreview: false, previewPercent: 0 };
  }

  /* ---- Admins always get full access ---- */
  if (String((user && user.role) || '').trim().toLowerCase() === 'admin') {
    return { allowed: true, canPreview: false, previewPercent: 0 };
  }

  const purchases    = Array.isArray(user.purchases) ? user.purchases : [];
  const ownsCourse   = course   && purchases.includes(String(course._id));
  const ownsMaterial = material && purchases.includes(String(material._id));
  const subscribed   = userHasActiveSubscription(user);

  /* ---- Paid access ---- */
  if (subscribed || ownsCourse || ownsMaterial) {
    return { allowed: true, canPreview: false, previewPercent: 0 };
  }

  /* ---- Course premium → whole course must be bought (no per-file preview) ---- */
  if (isCoursePremium) {
    return {
      allowed: false,
      canPreview: false,
      previewPercent: 0,
      reason: 'course-premium'
    };
  }

  /* ---- Material premium → preview only if previewPercent > 0 ---- */
  if (isMatPremium) {
    return {
      allowed: false,
      canPreview: previewPercent > 0,
      previewPercent,
      reason: 'material-premium'
    };
  }

  /* ---- Free content ---- */
  return { allowed: true, canPreview: false, previewPercent: 0 };
}

/* Backwards-compat shim — any old call sites keep working */
function checkMaterialAccess(user, course, material) {
  const r = evaluateMaterialAccess(user, course, material);
  return { allowed: r.allowed, reason: r.reason };
}
/* ============================================================
   ADMIN — Razorpay health check
   ------------------------------------------------------------
   GET /api/admin/razorpay-status
   Returns whether env vars exist, which mode (test/live),
   and whether the credentials actually authenticate with
   Razorpay's API (a real round-trip — not just a shape check).
   ============================================================ */
app.get('/api/admin/razorpay-status', requireAdminAuth, async (req, res) => {
  const keyId     = (process.env.RAZORPAY_KEY_ID || '').trim();
  const hasSecret = !!(process.env.RAZORPAY_KEY_SECRET || '').trim();
  const hasWebhook = !!(process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
  const mode = keyId.startsWith('rzp_live_') ? 'LIVE'
             : keyId.startsWith('rzp_test_') ? 'TEST'
             : null;

  if (!keyId || !hasSecret) {
    return res.json({
      success: true,
      ready: false,
      message: 'Razorpay is NOT configured. Missing: ' +
        [!keyId && 'RAZORPAY_KEY_ID', !hasSecret && 'RAZORPAY_KEY_SECRET']
          .filter(Boolean).join(', '),
      config: { keyId: keyId || null, hasSecret, hasWebhook, mode }
    });
  }

  // Real round-trip: 401 = bad keys, anything else = auth OK
  let authOk = false;
  let authError = null;
  try {
    await getRazorpay().orders.fetch('order_00000000000000');
    authOk = true;   // (would only succeed if such an order existed — unlikely, that's fine)
  } catch (e) {
    const msg = String((e && e.message) || '');
    const status = (e && e.statusCode) || (e && e.error && e.error.code) || null;
    if (status === 401 || /unauthor|authentication|invalid.*key/i.test(msg)) {
      authError = 'Razorpay rejected these keys (401 Unauthorized). ' +
                  'Double-check Key ID + Key Secret match the SAME account and mode.';
    } else {
      // Any other error (404 order not found, 400 bad id, network) means auth SUCCEEDED.
      authOk = true;
    }
  }

  res.json({
    success: true,
    ready: authOk,
    message: authOk
      ? 'Razorpay is configured, authenticated, and reachable.'
      : authError,
    config: {
      keyId:   keyId.slice(0, 12) + '…',
      hasSecret,
      hasWebhook,
      mode
    }
  });
});
/* ============================================================
   EMAIL TRANSPORTER — used for BOTH OTP + bulk email
   ------------------------------------------------------------
   Uses EMAIL_USER / EMAIL_PASS from .env. Same address you asked
   for: OTPs and bulk emails both go out from this account.
   ------------------------------------------------------------
   Key settings:
     pool: true              → reuse up to 5 SMTP connections
     maxConnections: 5       → never open more than 5 at once
     maxMessages: 50         → recycle a connection after 50 sends
     connectionTimeout: 8s   → fail fast if Gmail is unreachable
     greetingTimeout: 8s
     socketTimeout: 12s
   ============================================================ */
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

if (!EMAIL_USER || !EMAIL_PASS) {
  console.error('❌ EMAIL_USER / EMAIL_PASS are not set. OTP + bulk email will NOT work.');
}

/* ============================================================
   EMAIL TRANSPORTER — SMTP FIRST, Resend as fallback
   ------------------------------------------------------------
   WHY SMTP FIRST:
     Gmail SMTP + App Password is reliable and has no sandbox
     restrictions. Resend's free sandbox (onboarding@resend.dev)
     only delivers to the account owner, silently dropping all
     other recipients — which made OTPs "look sent" but never arrive.

   STRATEGY:
     1. SMTP (if EMAIL_USER + EMAIL_PASS set) → always tried first.
     2. Resend (if RESEND_API_KEY set) → fallback only.
     3. If both fail → throw with a clear, actionable error.
   ============================================================ */
/* ============================================================
   EMAIL TRANSPORTER — BREVO (HTTPS) first, SMTP/Resend as fallback
   ------------------------------------------------------------
   WHY:
     Render's free tier BLOCKS all outbound SMTP (ports 25, 465, 587).
     Brevo sends over HTTPS (port 443) — always allowed.
     Free tier: 300 emails/day, no custom domain required.
   ============================================================ */
const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const USE_BREVO  = !!(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);
const USE_RESEND = !!process.env.RESEND_API_KEY;
const USE_SMTP   = !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);

console.log('[email] Brevo configured: ', USE_BREVO, USE_BREVO ? `(${process.env.BREVO_SENDER_EMAIL})` : '');
console.log('[email] SMTP configured:  ', USE_SMTP,  USE_SMTP  ? `(${process.env.EMAIL_USER})` : '');
console.log('[email] Resend configured:', USE_RESEND);

// ---- Brevo HTTP sender ----
async function brevoSend({ to, subject, text, html, replyTo }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || 'Aerospace Department';

  const body = {
    sender: { name: senderName, email: senderEmail },
    to: [{ email: to }],
    subject,
    textContent: text || undefined,
    htmlContent: html || (text ? `<pre style="font-family:Inter,sans-serif;">${text}</pre>` : undefined)
  };
  if (replyTo) body.replyTo = { email: replyTo };

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': apiKey,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.error || JSON.stringify(data);
    throw new Error(`Brevo ${res.status}: ${msg}`);
  }
  return data; // { messageId: '...' }
}

// ---- SMTP fallback (only used if Brevo is not configured) ----
let smtpTransport = null;
if (USE_SMTP) {
  smtpTransport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    pool: true,
    maxConnections: 5,
    maxMessages: 50,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 25000,
    family: 4,
    lookup: (hostname, options, callback) => {
      dns.lookup(hostname, { ...options, family: 4 }, callback);
    },
    tls: { servername: 'smtp.gmail.com', minVersion: 'TLSv1.2' }
  });
}

function smtpFrom() {
  const ef = process.env.EMAIL_FROM;
  if (ef && ef.trim() && ef.includes('<')) return ef.trim();
  return `"Aerospace Department" <${process.env.EMAIL_USER}>`;
}

function resendFrom() {
  const ef = (process.env.EMAIL_FROM || '').trim();
  if (ef && !/gmail\.com/i.test(ef) && ef.includes('<')) return ef;
  return '"Aerospace Department" <onboarding@resend.dev>';
}

const transporter = {
  verify: async () => {
    if (USE_BREVO) return { ok: true, via: 'brevo', from: process.env.BREVO_SENDER_EMAIL };
    if (USE_SMTP) {
      try {
        await smtpTransport.verify();
        return { ok: true, via: 'smtp', from: smtpFrom() };
      } catch (e) {
        console.warn('[email] SMTP verify failed:', e.message);
        if (!USE_RESEND) throw e;
      }
    }
    if (USE_RESEND) return { ok: true, via: 'resend', from: resendFrom() };
    throw new Error('No email transport configured.');
  },

  sendMail: async (options) => {
    let lastError = null;

    // 1) Brevo (HTTPS) — preferred
    if (USE_BREVO) {
      try {
        const info = await brevoSend({
          to: options.to,
          subject: options.subject,
          text: options.text,
          html: options.html,
          replyTo: options.replyTo
        });
        console.log('[email] ✅ Brevo OK →', options.to, '· id:', info.messageId);
        return info;
      } catch (e) {
        lastError = e;
        console.error('[email] ❌ Brevo FAILED →', options.to, '·', e.message);
        if (!USE_SMTP && !USE_RESEND) throw e;
        console.warn('[email] → falling back…');
      }
    }

    // 2) SMTP (only works on paid Render tier)
    if (USE_SMTP && smtpTransport) {
      try {
        const info = await smtpTransport.sendMail({
          to: options.to,
          subject: options.subject,
          text: options.text,
          html: options.html,
          from: smtpFrom(),
          replyTo: options.replyTo || process.env.EMAIL_USER
        });
        console.log('[email] ✅ SMTP OK →', options.to, '· id:', info.messageId);
        return info;
      } catch (e) {
        lastError = e;
        console.error('[email] ❌ SMTP FAILED →', options.to, '·', e.message);
      }
    }

    // 3) Resend (only if verified domain — sandbox silently drops)
    const resendUsable = USE_RESEND && !/onboarding@resend\.dev/i.test(resendFrom());
    if (resendUsable) {
      try {
        const { data, error } = await resend.emails.send({
          from: resendFrom(),
          to: options.to,
          subject: options.subject,
          text: options.text,
          html: options.html,
          reply_to: options.replyTo
        });
        if (error) throw new Error(error.message || JSON.stringify(error));
        console.log('[email] ✅ Resend OK →', options.to, '· id:', data && data.id);
        return data;
      } catch (e) {
        console.error('[email] ❌ Resend FAILED →', options.to, '·', e.message);
        lastError = e;
      }
    }

    if (lastError) throw lastError;
    throw new Error('All email transports failed or none configured.');
  }
};

(async () => {
  console.log('[email] Priority: Brevo → SMTP → Resend');
  try {
    const v = await transporter.verify();
    console.log('✅ Email transporter ready. Via:', v.via, '· from:', v.from);
  } catch (err) {
    console.error('❌ Email transporter verification FAILED:', err.message);
  }
})();
// // ---- Boot diagnostic ----
// (async () => {
//   console.log('[email] Default SMTP from:  ', USE_SMTP ? smtpFrom() : '(n/a)');
//   console.log('[email] Default Resend from:', USE_RESEND ? resendFrom() : '(n/a)');
//   try {
//     await transporter.verify();
//     console.log('✅ Email transporter ready.');
//   } catch (err) {
//     console.error('❌ Email transporter verification FAILED:', err.message);
//   }
// })();

/* ============================================================
   SMS SENDER (Twilio REST API — no extra npm package needed)
   ------------------------------------------------------------
   Set these in .env to enable SMS:
     TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
     TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
     TWILIO_PHONE_NUMBER=+1xxxxxxxxxx

   If any are missing, SMS is silently skipped and a warning is
   logged. Email OTPs still work normally, so nothing breaks.
   ============================================================ */
const TWILIO_ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

async function sendSMS(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.warn('[sms] Twilio not configured — SMS skipped for', to);
    return { success: false, reason: 'not-configured' };
  }
  if (!to) return { success: false, reason: 'no-recipient' };
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const params = new URLSearchParams();
    params.append('To', to);
    params.append('From', TWILIO_PHONE_NUMBER);
    params.append('Body', body);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const data = await res.json();
    if (!res.ok) {
      console.warn('[sms] Twilio error:', data.message || res.status);
      return { success: false, reason: data.message || 'twilio-error' };
    }
    console.log('[sms] Sent to', to, '· sid=', data.sid);
    return { success: true, sid: data.sid };
  } catch (e) {
    console.warn('[sms] send failed:', e.message);
    return { success: false, reason: e.message };
  }
}

/* Normalize any user-typed phone to E.164 (best-effort).
   - 10 digits  → assume India (+91)
   - 11-15 digits (with or without +) → prefix +
   - anything else → return '' (invalid)                              */
function normalizePhone(p) {
  if (!p) return '';
  const digits = String(p).replace(/\D/g, '');
  if (/^\d{10}$/.test(digits)) return '+91' + digits;
  if (/^\d{11,15}$/.test(digits)) return '+' + digits;
  return '';
}

/* ============================================================
   DB
   ============================================================ */
mongoose.connect(process.env.MONGO_URI, {
  maxPoolSize: 10,
  minPoolSize: 0, // Allow the connection pool to shrink to zero when idle
  maxIdleTimeMS: 45000, // Close idle connections after 45 seconds, safely before Atlas's 5-minute timeout
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 10000,
  retryWrites: true,
  retryReads: true,
  bufferCommands: false
})
  .then(() => console.log('🚀 MongoDB Connected — pool ready'))
  .catch((err) => console.error('❌ MongoDB Error:', err.message));

let _mongoDisconnectCount = 0;
mongoose.connection.on('connected', () => {
  if (_mongoDisconnectCount > 0) {
    console.log(`[mongo] reconnected (after ${_mongoDisconnectCount} drop${_mongoDisconnectCount === 1 ? '' : 's'})`);
    _mongoDisconnectCount = 0;
  } else {
    console.log('[mongo] connected');
  }
});
mongoose.connection.on('error', (e) => console.error('[mongo] error:', e.message));
mongoose.connection.on('disconnected', () => {
  _mongoDisconnectCount++;
  if (_mongoDisconnectCount === 1) {
    console.warn('[mongo] disconnected — waiting for auto-reconnect…');
  }
});

/* ============================================================
   DATABASE INDEXES — created once, idempotent, zero-downtime.
   `createIndex` is safe to call repeatedly. Runs async so it
   never blocks server boot.
   ============================================================ */
(async () => {
  try {
    /* Courses — matches the primary list sort exactly */
    await Course.collection.createIndex({ featured: -1, createdAt: -1 });
    await Course.collection.createIndex({ status: 1 });
    /* Used by /uploads/:filename to reverse-lookup the owning course */
    await Course.collection.createIndex({ 'materials._id': 1 });
    /* Used by the paywall + material lookup */
    await Course.collection.createIndex({ 'materials.url': 1 }, { sparse: true });

    /* Users — login (username lookup), forgot-password (email), referrals */
    await User.collection.createIndex({ role: 1, createdAt: -1 });
    await User.collection.createIndex({ referralCode: 1 }, { sparse: true });
    await User.collection.createIndex({ referredBy: 1 }, { sparse: true });
    await User.collection.createIndex({ email: 1 }, { sparse: true });

    /* Activity — live admin dashboard sorts by lastSeenAt */
    await User.collection.createIndex({ 'activeSession.lastSeenAt': -1 }, { sparse: true });

    /* Contributions / feedback admin lists */
    await Contribution.collection.createIndex({ submittedAt: -1 });
    await Feedback.collection.createIndex({ submittedAt: -1 });

    console.log('[mongo] ✅ Indexes ensured');
  } catch (e) {
    console.warn('[mongo] Index creation warning (non-fatal):', e.message);
  }
})();
/* ============================================================
   ONE-TIME MIGRATION — backfill referralCode for existing users
   ============================================================ */
(async () => {
  try {
    await new Promise(r => setTimeout(r, 2500)); // let DB connect settle
    const usersWithoutCode = await User.find({
      role: 'student',
      $or: [{ referralCode: { $exists: false } }, { referralCode: null }, { referralCode: '' }]
    }).select('_id username fullName').limit(5000);

    if (usersWithoutCode.length === 0) {
      console.log('[migration] ✅ All students already have referral codes.');
      return;
    }

    console.log(`[migration] Backfilling referral codes for ${usersWithoutCode.length} user(s)…`);
    for (const u of usersWithoutCode) {
      let code;
      for (let attempt = 0; attempt < 6; attempt++) {
        code = generateReferralCode(u.username, u.fullName);
        const clash = await User.findOne({ referralCode: code, _id: { $ne: u._id } }).select('_id').lean();
        if (!clash) break;
      }
      try {
        await User.updateOne({ _id: u._id }, { $set: { referralCode: code } });
      } catch (e) { /* ignore */ }
    }
    console.log('[migration] ✅ Referral code backfill complete.');
  } catch (e) {
    console.warn('[migration] Referral backfill failed (non-fatal):', e.message);
  }
})();
/* ============================================================
   EMAIL REPLIES SCHEMA
   ============================================================ */
const emailReplySchema = new mongoose.Schema({
  from: { type: String, required: true },
  subject: { type: String, default: '(No Subject)' },
  text: { type: String, default: '' },
  date: { type: Date, default: Date.now },
  isRead: { type: Boolean, default: false }
});
const EmailReply = mongoose.model('EmailReply', emailReplySchema);

/* ============================================================
   WEBHOOK EVENT DEDUPE
   ------------------------------------------------------------
   Razorpay retries failed webhooks up to 24h. Without dedupe,
   the same payment.captured event gets processed multiple times
   → double purchase / double subscription extension.
   ============================================================ */
const webhookEventSchema = new mongoose.Schema({
  eventId:     { type: String, required: true, unique: true, index: true },
  eventType:   { type: String },
  processedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Auto-delete webhook events after 30 days (Razorpay stops retrying after 24h)
webhookEventSchema.index({ processedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

const WebhookEvent = mongoose.models.WebhookEvent ||
  mongoose.model('WebhookEvent', webhookEventSchema);
  /* ============================================================
   ACTIVE SESSIONS — v2 (dedicated collection)
   ------------------------------------------------------------
   One document per user, keyed on userId (unique).
   Every login overwrites this doc, which instantly invalidates
   every prior session for that user. This is decoupled from the
   User schema so it always works, even if User.activeSession
   isn't a defined field.
   ============================================================ */
const activeSessionSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, required: true, unique: true, index: true },
  sessionId:  { type: String, required: true },
  deviceInfo: { type: String, default: 'Unknown device' },
  loginAt:    { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now }
}, { timestamps: true });

const ActiveSession = mongoose.models.ActiveSession ||
  mongoose.model('ActiveSession', activeSessionSchema);

console.log('[session] ActiveSession model ready');

/* ============================================================
   PERSISTENT OTP STORE
   ------------------------------------------------------------
   Replaces in-memory Maps that lose all pending OTPs when the
   Render free tier spins down after 15 min inactivity.
   MongoDB TTL index auto-deletes expired docs.
   ============================================================ */
/* ============================================================
   QUIZ SESSION — server-synced timer + shuffle + analytics
   ------------------------------------------------------------
   One document per (user, course, material). Created the moment
   the student clicks "Begin Exam" and kept until submission.

   The server is the single source of truth for TIME. The client
   ticks down from serverStartedAt and the server independently
   enforces the same wall-clock expiry, so:
     • Refreshing the page does NOT reset the timer.
     • Changing the device clock does NOT extend the timer.
     • Disabling JavaScript does NOT bypass the deadline.
   ============================================================ */
const quizSessionSchema = new mongoose.Schema({
  userId:          { type: String, required: true, index: true },
  courseId:        { type: String, required: true },
  materialId:      { type: String, required: true },

  startedAt:       { type: Date,   required: true, default: Date.now },
  durationSeconds: { type: Number, required: true, default: 0 },

  shuffleSeed:     { type: String, required: true },
  questionOrder:   { type: [Number], default: [] },      // display[i] → original index
  optionOrders:    { type: mongoose.Schema.Types.Mixed, default: {} }, // origIdx → [display→orig]

  status:          { type: String, enum: ['in-progress', 'submitted', 'expired'], default: 'in-progress', index: true },
  lastHeartbeat:   { type: Date, default: Date.now },
  submittedAt:     { type: Date, default: null },
  autoSubmitted:   { type: Boolean, default: false },

  /* Time spent (seconds) on each ORIGINAL question index */
  timeSpentPerQuestion: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

quizSessionSchema.index({ userId: 1, courseId: 1, materialId: 1 }, { unique: true });

/* Auto-clean abandoned sessions after 7 days */
quizSessionSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

const QuizSession = mongoose.models.QuizSession ||
  mongoose.model('QuizSession', quizSessionSchema);

/* ---------- Seeded PRNG + shuffle (deterministic per seed) ---------- */
function _seededRng(seed) {
  let s = 0;
  for (let i = 0; i < String(seed).length; i++) {
    s = ((s << 5) - s) + String(seed).charCodeAt(i);
    s |= 0;
  }
  return function () {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 1000000) / 1000000;
  };
}
function seededShuffleArray(arr, seed) {
  const a = arr.slice();
  const rng = _seededRng(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* Server-side time parser (mirror of the client's parseQuizTime) */
function parseQuizTimeServer(s) {
  if (!s) return 0;
  s = String(s).toLowerCase().trim();
  const hm = s.match(/(\d+)\s*h(?:our|r)?s?/);
  const mm = s.match(/(\d+)\s*m(?:in(?:ute)?)?s?/);
  let sec = 0;
  if (hm) sec += parseInt(hm[1], 10) * 3600;
  if (mm) sec += parseInt(mm[1], 10) * 60;
  if (!sec) {
    const n = s.match(/^(\d+)$/);
    if (n) sec = parseInt(n[1], 10) * 60;
  }
  return sec;
}
/* ============================================================
   ⭐ QUIZ RESULT PUBLICATION  (helper)
   ------------------------------------------------------------
   Single source of truth for "make the score visible to the
   student and notify them". Called by:

     • POST /api/admin/quiz/:courseId/:materialId/publish   (admin override)
     • POST /api/admin/quiz/:courseId/:materialId/publish-now
     • the background sweeper (runs every 60 s)

   It is fully idempotent: a student whose result is already
   published is skipped, so running it twice never double-emails.
   ============================================================ */
async function publishQuizResults({ courseId, materialId, studentIds, reason }) {
  const course = await Course.findById(courseId)
    .select('name code materials')
    .lean();
  if (!course) return { published: 0, emailed: 0, error: 'Course not found' };

  const mat = (course.materials || []).find(
    m => String(m._id) === String(materialId)
  );
  if (!mat) return { published: 0, emailed: 0, error: 'Material not found' };

  const filter = { role: 'student' };
  if (Array.isArray(studentIds) && studentIds.length > 0) {
    filter._id = { $in: studentIds };
  }

  const students = await User.find(filter)
    .select('username fullName email phone quizResults notifications')
    .lean();

  const matIdStr = String(materialId);
  const now      = new Date();
  let published  = 0;
  const deliveredEmails = [];
  const deliveredInApp  = [];

  for (const s of students) {
    const r = (s.quizResults || {})[matIdStr];
    if (!r) continue;
    if (r.publishedAt) continue;             // already visible → skip

    const autoMarks = Number(r.marksEarned)     || 0;
    const autoMax   = Number(r.marksPossible)   || 0;
    const subjMarks = Number(r.subjectiveMarksAwarded) || 0;
    const subjMax   = Number(r.subjectiveMaxTotal)     || 0;
    const finalEarned   = autoMarks + subjMarks;
    const finalPossible = autoMax   + subjMax;
    const finalPct      = finalPossible > 0
      ? Math.round((finalEarned / finalPossible) * 100)
      : (Number(r.percent) || 0);

    /* ---- 1. Mark the score visible in the DB ---- */
    try {
      await User.updateOne(
        { _id: s._id },
        {
          $set: {
            [`quizResults.${matIdStr}.publishedAt`]:         now,
            [`quizResults.${matIdStr}.manuallyEvaluated`]:   true,
            [`quizResults.${matIdStr}.finalMarksEarned`]:    finalEarned,
            [`quizResults.${matIdStr}.finalMarksPossible`]:  finalPossible,
            [`quizResults.${matIdStr}.finalPercent`]:        finalPct
          }
        }
      );
    } catch (e) {
      console.warn('[quiz/publish] update failed for', s.username, e.message);
      continue;
    }
    published++;

    /* ---- 2. In-app notification (survives even if email is broken) ---- */
    try {
      const notif = {
        id:        Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type:      'quiz-result',
        title:     `📊 Results published — ${mat.title || 'Test'}`,
        body:      `Your final score: ${finalEarned} / ${finalPossible} (${finalPct}%). ` +
                   `Open the course to see the full breakdown.`,
        link:      `#/course/${courseId}`,
        read:      false,
        createdAt: now
      };
      await User.updateOne(
        { _id: s._id },
        {
          $push: {
            notifications: {
              $each:  [notif],
              $slice: -50
            }
          }
        }
      );
      deliveredInApp.push(s.username);
    } catch (e) {
      console.warn('[quiz/publish] in-app notify failed for', s.username, e.message);
    }

    /* ---- 3. Email (best-effort; never blocks the response) ---- */
    if (s.email) {
      try {
        const subject = `Results published — ${mat.title || 'your test'}`;
        const text =
          `Hi ${s.fullName || s.username},\n\n` +
          `Your results for "${mat.title || 'the test'}" in "${course.name}" are ready.\n\n` +
          `Final score: ${finalEarned} / ${finalPossible} (${finalPct}%)\n` +
          `Auto-graded: ${autoMarks} / ${autoMax}\n` +
          (subjMax > 0 ? `Manually graded: ${subjMarks} / ${subjMax}\n` : '') +
          `\nLog in to view the full answer breakdown.\n\n` +
          `— Aerospace Department, IIT Kharagpur`;

        transporter.sendMail({
          to: s.email,
          subject,
          text,
          html: `
            <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:22px;line-height:1.6;">
              <div style="border-left:4px solid #6366f1;padding-left:12px;margin-bottom:18px;">
                <strong style="font-size:17px;color:#14161c;">Aerospace Department</strong><br>
                <span style="font-size:12px;color:#8b8d98;">RESULT PUBLISHED</span>
              </div>
              <p>Hi ${escapeHtml(s.fullName || s.username)},</p>
              <p>Your results for <strong>${escapeHtml(mat.title || 'your test')}</strong>
                 in <strong>${escapeHtml(course.name)}</strong> are ready.</p>
              <div style="background:#eef2ff;border-radius:10px;padding:16px 20px;margin:16px 0;text-align:center;">
                <div style="font-size:12px;letter-spacing:1px;color:#4f46e5;font-weight:700;">FINAL SCORE</div>
                <div style="font-size:34px;font-weight:800;color:#312e81;margin-top:6px;">
                  ${finalEarned} / ${finalPossible}
                </div>
                <div style="font-size:13px;color:#4a4d5a;margin-top:4px;">${finalPct}%</div>
              </div>
              <p style="font-size:13px;color:#4a4d5a;">
                Auto-graded: <strong>${autoMarks}/${autoMax}</strong>
                ${subjMax > 0 ? `<br>Manually graded: <strong>${subjMarks}/${subjMax}</strong>` : ''}
              </p>
              <p style="font-size:13px;color:#8b8d98;margin-top:22px;">
                Log in to view the full answer breakdown.
              </p>
            </div>`
        }).catch(err => console.warn('[quiz/publish] email failed:', err.message));

        deliveredEmails.push(s.email);
      } catch (e) { /* silent */ }
    }

    /* ---- 4. SMS (best-effort, only if configured) ---- */
    if (s.phone) {
      sendSMS(
        s.phone,
        `AeroGyan: Your ${mat.title || 'test'} result is out — ${finalEarned}/${finalPossible} (${finalPct}%). Log in to view.`
      ).catch(() => {});
    }
  }

  /* ---- 5. Flip the material-level flag so we don't re-scan ---- */
  try {
    await Course.updateOne(
      { _id: courseId, 'materials._id': materialId },
      {
        $set: {
          'materials.$.examConfig.resultsPublished':   true,
          'materials.$.examConfig.resultsPublishedAt': now
        }
      }
    );
    cacheClear('courses:');
  } catch (e) {
    console.warn('[quiz/publish] flag update failed:', e.message);
  }

  console.log(
    `[quiz/publish] ✅ reason=${reason || 'manual'} course=${courseId} mat=${materialId} ` +
    `students=${published} inApp=${deliveredInApp.length} email=${deliveredEmails.length}`
  );

  return {
    published,
    emailed: deliveredEmails.length,
    notifiedInApp: deliveredInApp.length
  };
}

   const otpTokenSchema = new mongoose.Schema({
  key:       { type: String, required: true, unique: true }, // email|phone|userId
  otp:       { type: String, required: true },
  payload:   { type: mongoose.Schema.Types.Mixed, default: {} },
  expiresAt: { type: Date, required: true },
  attempts:  { type: Number, default: 0 }
}, { timestamps: true });

otpTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const OtpToken = mongoose.model('OtpToken', otpTokenSchema);

/* ---------- Drop-in replacements for the old Maps ---------- */

/* Set / overwrite an OTP entry */
async function otpSet(key, data, ttlMs) {
  try {
    await OtpToken.findOneAndUpdate(
      { key },
      {
        key,
        otp: data.otp,
        payload: data,
        expiresAt: new Date(Date.now() + ttlMs),
        attempts: data.attempts || 0
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return true;
  } catch (e) {
    console.warn('[otp] set failed:', e.message);
    return false;
  }
}

/* Get an OTP entry (returns null if missing or expired) */
async function otpGet(key) {
  try {
    const doc = await OtpToken.findOne({ key }).lean();
    if (!doc) return null;
    if (Date.now() > new Date(doc.expiresAt).getTime()) {
      await OtpToken.deleteOne({ key });
      return null;
    }
    return doc;
  } catch (e) {
    console.warn('[otp] get failed:', e.message);
    return null;
  }
}

/* Delete an OTP entry */
async function otpDel(key) {
  try { await OtpToken.deleteOne({ key }); } catch (e) {}
}

/* Increment the wrong-attempt counter */
async function otpBumpAttempts(key) {
  try {
    await OtpToken.updateOne({ key }, { $inc: { attempts: 1 } });
  } catch (e) {}
}
/* ============================================================
   HELPERS
   ============================================================ */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function toDateKey(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function bumpStreak(user) {
  const today = todayStr();
  const yesterday = yesterdayStr();
  if (user.lastActiveDate === today) return;
  if (user.lastActiveDate === yesterday) user.streakCount = (user.streakCount || 0) + 1;
  else user.streakCount = 1;
  user.lastActiveDate = today;
  if ((user.streakCount || 0) > (user.longestStreak || 0)) user.longestStreak = user.streakCount;
}
/* ============================================================
   IST DATE KEY — "YYYY-MM-DD" in Asia/Kolkata
   ------------------------------------------------------------
   All daily usage buckets use IST midnight as the boundary,
   which matches the rest of the platform's timezone handling.
   ============================================================ */
function istDateKey(d) {
  const t = (d instanceof Date ? d.getTime() : Date.now()) + 5.5 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

/* Trim an id→number map to the top N entries (largest first).
   Used before sending snapshots over SSE so payloads stay small. */
function topNEntries(obj, n) {
  if (!obj) return {};
  const entries = Object.entries(obj);
  if (entries.length <= n) {
    const out = {};
    entries.forEach(([k, v]) => { out[k] = v; });
    return out;
  }
  entries.sort((a, b) => b[1] - a[1]);
  const out = {};
  for (let i = 0; i < n; i++) out[entries[i][0]] = entries[i][1];
  return out;
}
/* ============================================================
   XP + LEVEL SYSTEM
   ------------------------------------------------------------
   Aerospace-themed ranks. XP accumulates from:
     • Viewing a material ...................... +10 XP
     • Completing a quiz ....................... +25 XP base
       ↳ Accuracy bonus ........................ +0-25 XP
       ↳ Perfect score bonus ................... +50 XP
   Level is derived from total XP.
   ============================================================ */
const XP_LEVELS = [
  { level: 1,  name: 'Cadet',           minXP: 0,     icon: 'fa-user' },
  { level: 2,  name: 'Ensign',          minXP: 100,   icon: 'fa-medal' },
  { level: 3,  name: 'Pilot',           minXP: 300,   icon: 'fa-plane' },
  { level: 4,  name: 'Flight Lead',     minXP: 600,   icon: 'fa-jet-fighter' },
  { level: 5,  name: 'Squadron Lead',   minXP: 1000,  icon: 'fa-fighter-jet' },
  { level: 6,  name: 'Wing Commander',  minXP: 1500,  icon: 'fa-star' },
  { level: 7,  name: 'Group Captain',   minXP: 2200,  icon: 'fa-shield-halved' },
  { level: 8,  name: 'Air Commodore',   minXP: 3000,  icon: 'fa-crown' },
  { level: 9,  name: 'Air Marshal',     minXP: 4000,  icon: 'fa-gem' },
  { level: 10, name: 'Ace of Aces',     minXP: 5500,  icon: 'fa-trophy' }
];

function computeLevel(xp) {
  const safeXP = Math.max(0, Number(xp) || 0);
  let current = XP_LEVELS[0];
  for (const lvl of XP_LEVELS) {
    if (safeXP >= lvl.minXP) current = lvl;
    else break;
  }
  const next = XP_LEVELS.find(l => l.minXP > safeXP) || null;
  const rangeStart = current.minXP;
  const rangeEnd = next ? next.minXP : current.minXP + 1000;
  const progressInLevel = safeXP - rangeStart;
  const levelRange = rangeEnd - rangeStart;
  const pctToNext = next ? Math.round((progressInLevel / levelRange) * 100) : 100;

  return {
    level: current.level,
    name: current.name,
    icon: current.icon,
    xp: safeXP,
    minXP: rangeStart,
    nextLevelXP: next ? rangeEnd : null,
    nextLevelName: next ? next.name : null,
    pctToNext,
    isMax: !next
  };
}

function awardXP(user, amount, reason) {
  if (!user || !amount) return null;
  const oldXP = Number(user.xp) || 0;
  const oldLevel = computeLevel(oldXP);

  user.xp = oldXP + Number(amount);
  const newLevel = computeLevel(user.xp);
  user.level = newLevel.level;

  if (newLevel.level > oldLevel.level) {
    if (!user.notifications) user.notifications = [];
    user.notifications.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: 'level-up',
      title: `🎉 Level ${newLevel.level} — ${newLevel.name}!`,
      body: `You've reached a new rank. Keep up the great work!`,
      read: false,
      createdAt: new Date()
    });
    if (user.notifications.length > 50) {
      user.notifications = user.notifications.slice(-50);
    }
  }

  return {
    xp: user.xp,
    gained: amount,
    reason,
    leveledUp: newLevel.level > oldLevel.level,
    level: newLevel.level,
    levelName: newLevel.name,
    icon: newLevel.icon
  };
}

/* ---- Subscription helpers ---- */
/* 60-second in-memory cache — cleared automatically on any admin write.
   Any code that updates settings should call invalidateGlobalSettingsCache(). */
let _globalSettingsCache = null;
let _globalSettingsCacheAt = 0;
const GLOBAL_SETTINGS_TTL_MS = 60 * 1000;

function invalidateGlobalSettingsCache() {
  _globalSettingsCache = null;
  _globalSettingsCacheAt = 0;
}

async function getGlobalSettings(force = false) {
  if (!force &&
      _globalSettingsCache &&
      (Date.now() - _globalSettingsCacheAt) < GLOBAL_SETTINGS_TTL_MS) {
    return _globalSettingsCache;
  }
  let s = await Settings.findOne({ key: 'global' });
  if (!s) s = await Settings.create({ key: 'global' });
  _globalSettingsCache = s;
  _globalSettingsCacheAt = Date.now();
  return s;
}

function userHasActiveSubscription(user) {
  if (!user || !user.subscription) return false;
  if (!user.subscription.active) return false;
  if (user.subscription.status !== 'active') return false;
  if (user.subscription.expiresAt && new Date(user.subscription.expiresAt) < new Date()) return false;
  return true;
}

function serializeUser(user) {
  return {
    _id: user._id,
    username: user.username,
    email: user.email,
    role: user.role,
    fullName: user.fullName,
    purchases: user.purchases || [],
    bookmarks: user.bookmarks || [],
    progress: Object.fromEntries(user.progress || new Map()),
    lastActivity: user.lastActivity || null,
    streakCount: user.streakCount || 0,
    longestStreak: user.longestStreak || 0,
    lastActiveDate: user.lastActiveDate || null,
    notifications: user.notifications || [],
    quizResults: Object.fromEntries(user.quizResults || new Map()),
    subscription: user.subscription || null,
    isSubscribed: userHasActiveSubscription(user),

    /* XP & Level */
    xp: user.xp || 0,
    level: user.level || 1,
    levelInfo: computeLevel(user.xp || 0),

    /* Referral program */
    referralCode:  user.referralCode || null,
    referredBy:    user.referredBy || null,
    referralStats: user.referralStats || {
      totalReferred: 0, totalSubscribed: 0, rewardsEarned: 0,
      rewardedFor: 0, lastRewardAt: null
    }
  };
}

/* ---- Referral helpers ---- */
function generateReferralCode(username, fullName) {
  const base = String(username || fullName || 'AERO')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 6) || 'AERO';
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base}${suffix}`;
}

async function ensureReferralCode(user) {
  if (user.referralCode) return user.referralCode;
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateReferralCode(user.username, user.fullName);
    const clash = await User.findOne({ referralCode: code }).select('_id').lean();
    if (!clash) {
      user.referralCode = code;
      try { await user.save(); } catch (e) { /* race — retry */ continue; }
      return code;
    }
  }
  // Fallback — timestamp-based unique code
  user.referralCode = 'AERO' + Date.now().toString(36).toUpperCase();
  try { await user.save(); } catch (e) {}
  return user.referralCode;
}

/* Grant referral reward to a referrer and notify them. */
async function grantReferralReward(referrer, rewardDays, settings) {
  const now = new Date();

  if (!referrer.subscription) referrer.subscription = {};
  const base = (referrer.subscription.expiresAt && new Date(referrer.subscription.expiresAt) > now)
    ? new Date(referrer.subscription.expiresAt)
    : now;

  referrer.subscription.expiresAt = new Date(base.getTime() + rewardDays * 24 * 60 * 60 * 1000);
  referrer.subscription.active = true;
  referrer.subscription.status = 'active';
  referrer.subscription.autoRenew = referrer.subscription.autoRenew || false;
  referrer.subscription.history = referrer.subscription.history || [];
  referrer.subscription.history.push({
    status: 'referred-reward',
    amount: 0,
    note: `Referral reward: +${rewardDays} days`,
    date: now
  });

  if (!referrer.referralStats) referrer.referralStats = {};
  referrer.referralStats.rewardsEarned = (referrer.referralStats.rewardsEarned || 0) + 1;
  referrer.referralStats.lastRewardAt = now;

  if (!referrer.notifications) referrer.notifications = [];
  referrer.notifications.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type: 'referral-reward',
    title: `🎁 Referral reward unlocked!`,
    body: `You earned ${settings.referralRewardTitle || rewardDays + ' days of premium'} for referring ${settings.referralThreshold} students.`,
    link: '#/home',
    read: false,
    createdAt: now
  });
  if (referrer.notifications.length > 50) {
    referrer.notifications = referrer.notifications.slice(-50);
  }

  await referrer.save();
  invalidateGlobalSettingsCache();   // reward may extend subscription
  console.log(`[referral] ✅ Reward granted to ${referrer.username} (+${rewardDays} days)`);
}

function extractYouTubeId(url) {
  if (!url) return null;
  const str = String(url).trim();
  
  // Matches all common YouTube URL formats:
  // - youtube.com/watch?v=VIDEO_ID
  // - youtu.be/VIDEO_ID
  // - youtube.com/embed/VIDEO_ID
  // - youtube.com/shorts/VIDEO_ID
  // - youtube.com/live/VIDEO_ID
  // - youtube.com/v/VIDEO_ID
  const m = str.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function nl2br(s) {
  return escapeHtml(s).replace(/\r?\n/g, '<br/>');
}

/* ============================================================
   Timing-safe hex comparison for HMAC signatures
   ------------------------------------------------------------
   Regular `===` short-circuits on first byte mismatch → tiny
   timing side-channel. crypto.timingSafeEqual fixes it.
   Returns false on any error (missing/mismatched length).
   ============================================================ */
function safeEqualHex(a, b) {
  try {
    if (!a || !b) return false;
    const ba = Buffer.from(String(a), 'hex');
    const bb = Buffer.from(String(b), 'hex');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch (e) {
    return false;
  }
}
/* ============================================================
   SIGNED PDF URL SYSTEM
   ------------------------------------------------------------
   When a student opens a PDF, we authorize them ONCE and issue
   a short-lived HMAC-signed URL. Every subsequent range request
   PDF.js makes uses that signed URL — skipping JWT verification,
   premium checks, and DB lookups entirely.

   Security: HMAC-SHA256 over (filename:userId:expires), truncated
   to 32 hex chars. Uses the same JWT_SECRET already in env.
   ============================================================ */
/* ============================================================
   STABLE SIGNED URLS — v2
   ------------------------------------------------------------
   Previously the token embedded `Date.now() + TTL`, so every
   call produced a UNIQUE URL. That is fatal on high-latency
   networks (campus/corporate proxies):

     • The browser HTTP cache keys on the full URL.
     • A unique URL = guaranteed cache miss.
     • The student re-downloads the entire 5-30 MB PDF every
       time they reopen it — over a proxy adding 150-400 ms of
       latency per round trip.

   FIX: quantize the expiry to the top of the next hour. Any
   call within the same hour for the same (file, user) pair
   now produces an IDENTICAL token — so the browser serves it
   from cache with zero network cost.

   Security is unchanged:
     • The token still expires (worst case: at the top of the
       next hour + 24h).
     • It is still scoped to one (filename, userId).
     • It still uses HMAC-SHA256 with the same secret.
   ============================================================ */
const SIGNED_URL_TTL_MS    = 24 * 60 * 60 * 1000;   // valid for up to 24h
const SIGNED_URL_QUANTUM_MS = 60 * 60 * 1000;       // quantize to the hour

function signUploadToken(filename, userId) {
  const target = Date.now() + SIGNED_URL_TTL_MS;
  /* Round UP to the next whole hour. Repeated calls within the
     same wall-clock hour return the same `expires`, hence the
     same signature, hence the same URL. */
  const expires = Math.ceil(target / SIGNED_URL_QUANTUM_MS) * SIGNED_URL_QUANTUM_MS;
  const payload = `${filename}:${userId}:${expires}`;
  const sig = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(payload)
    .digest('hex')
    .slice(0, 32);
  return `${expires}.${sig}`;
}

function verifyUploadToken(filename, userId, token) {
  try {
    if (!token || typeof token !== 'string') return false;
    const dotIdx = token.indexOf('.');
    if (dotIdx <= 0) return false;
    const expiresStr = token.slice(0, dotIdx);
    const sig        = token.slice(dotIdx + 1);
    const expires    = parseInt(expiresStr, 10);
    if (!expires || !sig) return false;
    if (Date.now() > expires) return false;

    const payload  = `${filename}:${userId}:${expires}`;
    const expected = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(payload)
      .digest('hex')
      .slice(0, 32);

    // Constant-time comparison on fixed-length hex strings
    if (sig.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------
   serveUploadFile — the single, hardened disk-serving routine.
   Handles ETag, Last-Modified, Range, MIME, path-traversal guard.
   ------------------------------------------------------------ */
async function serveUploadFile(filename, req, res) {
  /* ── Path-traversal defense ── */
  const uploadRoot = UPLOAD_DIR;                       // already absolute
  const diskPath   = path.resolve(path.join(UPLOAD_DIR, filename));

  if (diskPath !== uploadRoot && !diskPath.startsWith(uploadRoot + path.sep)) {
    console.warn('[uploads] 🚫 traversal attempt:', filename);
    return res.status(400).send('Invalid path');
  }

  const ext = path.extname(filename).toLowerCase();

  const MIME_MAP = {
    '.pdf':  'application/pdf',
    '.mp4':  'video/mp4',
    '.webm': 'video/webm',
    '.mov':  'video/quicktime',
    '.mp3':  'audio/mpeg',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.webp': 'image/webp',
    '.gif':  'image/gif'
  };

  /* ============================================================
     ⭐ FIX: Fetch stat FIRST so it's available to BOTH the Nginx
     Accel path and the Node fallback path.
     ============================================================ */
  let stat;
  try {
    stat = await fs.promises.stat(diskPath);
  } catch (e) {
    return res.status(404).send('File not found');
  }
  if (!stat.isFile()) return res.status(404).send('Not a file');

  /* ============================================================
     ⚡ NGINX ACCEL FAST PATH
     ============================================================ */
  if (process.env.USE_NGINX_ACCEL === 'true') {
    res.setHeader('X-Accel-Redirect', '/protected-uploads/' + filename);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(stat.size)); // ← now safe
    if (MIME_MAP[ext]) {
      res.setHeader('Content-Type', MIME_MAP[ext]);
    }
    return res.status(200).end();
  }

  /* ── Node fallback (dev / non-Nginx environments) ── */
  const isMedia = ['.pdf', '.mp4', '.webm', '.mov', '.mp3'].includes(ext);
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', String(stat.size));

  res.setHeader(
    'Cache-Control',
    isMedia
      ? 'private, max-age=2592000, immutable'
      : 'private, max-age=3600'
  );

  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  if (MIME_MAP[ext]) res.setHeader('Content-Type', MIME_MAP[ext]);

  return res.sendFile(diskPath, {
    acceptRanges: true,
    cacheControl: false,
    lastModified: false,
    etag: false,
    dotfiles: 'deny',
    headers: { 'X-Content-Type-Options': 'nosniff' }
  });
}
/* ============================================================
   PDF LINEARIZATION (Fast Web View)
   ------------------------------------------------------------
   Linearized PDFs place the xref/object stream at the FRONT of
   the file, so PDF.js can render page 1 without first fetching
   the end. Cuts first-paint time by ~60% on large documents.

   Strategy:
     1. Try `qpdf --linearize` (fastest, best quality)
     2. If qpdf is unavailable → fall back to a no-op so uploads
        still succeed (the PDF stays functional, just slower).
   ============================================================ */
/* ============================================================
   PDF LINEARIZATION (Fast Web View)
   ------------------------------------------------------------
   Produces a linearized copy of the PDF so readers can render
   page 1 without fetching the whole file.

   TWO CRITICAL FIXES baked into this function:

   1. Output filename uses a SINGLE extension ("-linearized.pdf").
      Hostinger's security layer blocks writes to files with two
      dots like "foo.pdf.lin" or "foo.pdf.tmp" — that was silently
      breaking linearization on this server.

   2. qpdf exit code 3 is treated as SUCCESS.
      Exit codes:  0 = success   ·   2 = real failure   ·   3 = success with warnings.
      Node's execFile() sets `err` for any non-zero code, so we
      must explicitly allow 3. Otherwise valid linearizations were
      being reported as failures.
   ============================================================ */
async function linearizePdf(diskPath) {
  if (!diskPath || !diskPath.toLowerCase().endsWith('.pdf')) return false;

  return new Promise((resolve) => {
    /* FIX 1: Single-extension output name (Hostinger blocks "*.pdf.lin") */
    const outPath = diskPath.replace(/\.pdf$/i, '') + '-linearized.pdf';

    execFile(
      'qpdf',
      ['--linearize', '--object-streams=generate', diskPath, outPath],
      { timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        /* FIX 2: Allow exit code 3 (success-with-warnings) */
        const exitCode = err && typeof err.code === 'number' ? err.code : 0;

        if (err && exitCode !== 3) {
          const msg = (stderr || err.message || '').trim().split('\n')[0];
          console.warn('[linearize] skipped:', msg);
          try { fs.unlinkSync(outPath); } catch (_) {}
          return resolve(false);
        }

        try {
          const st = fs.statSync(outPath);
          if (st.size < 1024) {
            console.warn('[linearize] output too small, skipping');
            try { fs.unlinkSync(outPath); } catch (_) {}
            return resolve(false);
          }
          fs.renameSync(outPath, diskPath);
          console.log(
            '[linearize] ✅ Linearized:',
            path.basename(diskPath),
            `(${Math.round(st.size / 1024)} KB)`,
            exitCode === 3 ? '(with warnings)' : ''
          );
          resolve(true);
        } catch (e) {
          console.warn('[linearize] rename failed:', e.message);
          try { fs.unlinkSync(outPath); } catch (_) {}
          resolve(false);
        }
      }
    );
  });
}

/* ============================================================
   ADMIN 2FA — pending login store
   ============================================================ */
const adminLoginStore = new Map(); // pendingId → { userId, otp, expiresAt, attempts }

/* ============================================================
   ADMIN SECURITY ALERT — emailed on any credential change
   ============================================================ */
async function sendAdminCredentialChangeAlert({ adminUser, changeType, ipAddress }) {
  try {
    const to = (adminUser && adminUser.email) || process.env.ADMIN_EMAIL;
    if (!to) return;
    const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const html = `
      <div style="font-family:Inter,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;padding:26px 22px;color:#14161c;line-height:1.6;background:#ffffff;">
        <div style="border-left:4px solid #f59e0b;padding-left:14px;margin-bottom:22px;">
          <div style="font-size:18px;font-weight:700;color:#14161c;">Aerospace Department</div>
          <div style="font-size:12px;color:#8b8d98;letter-spacing:.5px;">SECURITY ALERT</div>
        </div>
        <h2 style="font-size:20px;font-weight:800;color:#14161c;margin:0 0 10px;">Admin credentials changed</h2>
        <p style="font-size:14.5px;margin:0 0 18px;">
          Hi ${escapeHtml(adminUser.fullName || adminUser.username || 'Admin')},<br><br>
          Your admin account <strong>${escapeHtml(changeType)}</strong> was just changed.
        </p>
        <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:12px 14px;margin:18px 0;font-size:13px;color:#78350f;">
          <strong>Time:</strong> ${escapeHtml(when)}<br>
          <strong>IP:</strong> ${escapeHtml(ipAddress || 'unknown')}
        </div>
        <p style="font-size:14px;margin:18px 0 0;">
          If this was you, no action is needed. If you did <strong>not</strong> make this change, reset your password immediately or contact support.
        </p>
        <div style="border-top:1px solid #ebe7e0;margin-top:26px;padding-top:16px;font-size:12.5px;color:#8b8d98;">
          — Aerospace Department<br/>IIT Kharagpur
        </div>
      </div>`;
    await transporter.sendMail({
      to,
      subject: '⚠️ Security Alert — Admin credentials changed',
      text: `Admin credentials changed\n\nYour admin ${changeType} was just changed.\nTime: ${when}\nIP: ${ipAddress || 'unknown'}\n\nIf this wasn't you, reset your password immediately.`,
      html
    });
    console.log('[admin-alert] Sent to', to, '· change:', changeType);
  } catch (e) {
    console.warn('[admin-alert] Failed to send:', e.message);
  }
}

/* ---- Concurrency helper: run async tasks with a max parallel limit ---- */
async function runWithConcurrency(items, worker, concurrency = 8) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = { status: 'fulfilled', value: await worker(items[i], i) };
      } catch (e) {
        results[i] = { status: 'rejected', reason: e };
      }
    }
  }
  const runners = [];
  for (let k = 0; k < Math.min(concurrency, items.length); k++) runners.push(runner());
  await Promise.all(runners);
  return results;
}

/* ---- Timeout wrapper: reject a promise if it exceeds ms ---- */
function withTimeout(promise, ms, label = 'operation') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

const ACTIVITY_LOG_MAX = 3000;
function logActivity(user, { type, courseId, materialId, score, total }) {
  if (!user) return;
  if (!user.activityLog) user.activityLog = [];
  const date = todayStr();
  const exists = user.activityLog.some(a =>
    a.date === date && a.type === type &&
    (a.courseId || null) === (courseId || null) &&
    (a.materialId || null) === (materialId || null)
  );
  if (exists) return;
  user.activityLog.push({
    date, timestamp: new Date(), type: type || 'view',
    courseId: courseId || null, materialId: materialId || null,
    score: (typeof score === 'number') ? score : null,
    total: (typeof total === 'number') ? total : null
  });
  if (user.activityLog.length > ACTIVITY_LOG_MAX) {
    user.activityLog = user.activityLog.slice(-ACTIVITY_LOG_MAX);
  }
}

/* ============================================================
   SETUP
   ============================================================ */
app.get('/setup-admin', async (req, res) => {
  try {
    const adminExists = await User.findOne({ role: 'admin' });
    if (adminExists) return res.send('Admin already exists!');
    const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    if (!adminEmail) return res.status(500).send('❌ ADMIN_EMAIL not set in environment.');
    const adminUsername = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
    const adminPassword = process.env.ADMIN_PASSWORD || 'AeroAdmin123';
    const hashedPassword = await bcrypt.hash(adminPassword, 10);
    await new User({
      username: adminUsername,
      password: hashedPassword,
      role: 'admin',
      fullName: 'Aerospace Admin',
      email: adminEmail
    }).save();
    res.send(`✅ Admin created!\nUsername: ${adminUsername}\nPassword: ${adminPassword}\nEmail: ${adminEmail}\n\n⚠️ 2FA OTPs will be sent to ${adminEmail}. Please log in and change the default password.`);
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

/* ============================================================
   AUTH
   ============================================================ */
/* ============================================================
   AUTH
   ============================================================ */
app.post('/api/login', async (req, res) => {
  const t0 = Date.now();
  try {
    const body = req.body || {};
    const usernameRaw = body.username;
    const passwordRaw = body.password;
    const roleFromClient = body.role;

    // ---------- Input validation ----------
    if (!usernameRaw || !passwordRaw) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required.'
      });
    }

    const usernameTrimmed = String(usernameRaw).trim();
    const cleanUsername = usernameTrimmed.toLowerCase();

    console.log(`[login] attempt user="${cleanUsername}" role-tab="${roleFromClient}" ip=${req.ip}`);

    // ---------- Find user (case-insensitive, robust) ----------
    let user = await User.findOne({ username: cleanUsername });
    if (!user) user = await User.findOne({ username: usernameTrimmed });
    if (!user) {
      // Final fallback: case-insensitive regex (handles legacy "JohnDoe" style rows)
      const esc = cleanUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      user = await User.findOne({ username: new RegExp('^' + esc + '$', 'i') });
    }

    if (!user) {
      console.log(`[login] ❌ no user for "${cleanUsername}"`);
      return res.status(400).json({
        success: false,
        message: 'Invalid username or password.'
      });
    }

    console.log(`[login] user found "${user.username}" role=${user.role}`);

    // ─── SELF-HEALING: fix legacy admin records ──────────────────
    // If this user's username matches ADMIN_USERNAME from env and their
    // DB role somehow defaults to 'student' (legacy records created
    // before the schema default was fixed), upgrade them automatically.
    const envAdminUser = String(process.env.ADMIN_USERNAME || '').trim().toLowerCase();
    if (envAdminUser && user.username === envAdminUser && user.role !== 'admin') {
      console.warn(
        `[login] ⚠️ self-healing: "${user.username}" had role="${user.role}" ` +
        `— upgrading to 'admin' because it matches ADMIN_USERNAME`
      );
      user.role = 'admin';
      try { await user.save(); } catch (e) {
        console.error('[login] self-heal save failed:', e.message);
      }
    }

    // Also self-heal if the user's email matches ADMIN_EMAIL
    const envAdminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    if (envAdminEmail && user.email && user.email.toLowerCase() === envAdminEmail && user.role !== 'admin') {
      console.warn(
        `[login] ⚠️ self-healing: "${user.username}" had role="${user.role}" ` +
        `— upgrading to 'admin' because it matches ADMIN_EMAIL`
      );
      user.role = 'admin';
      try { await user.save(); } catch (e) {
        console.error('[login] self-heal save failed:', e.message);
      }
    }

    // ---------- Password check ----------
    let isMatch = false;
    try {
      isMatch = await bcrypt.compare(String(passwordRaw), user.password);
    } catch (bcryptErr) {
      console.error('[login] bcrypt threw:', bcryptErr);
      return res.status(500).json({
        success: false,
        message: 'Password verification failed. Please contact support.'
      });
    }

    if (!isMatch) {
      console.log(`[login] ❌ wrong password for "${user.username}"`);
      return res.status(400).json({
        success: false,
        message: 'Invalid username or password.'
      });
    }
        // Ensure student has a referral code (on-the-fly backfill)
    if (user.role === 'student' && !user.referralCode) {
      try { await ensureReferralCode(user); } catch (e) {}
    }

    // ---------- Role check — LENIENT (warn only, never block) ----------
    // The frontend auto-flips the role toggle when the username contains "admin".
    // Trust the DB role instead of the UI tab to avoid locking out real students.
    if (roleFromClient && user.role !== roleFromClient) {
      console.warn(
        `[login] ⚠️ role tab mismatch: DB="${user.role}" UI="${roleFromClient}" — proceeding with DB role.`
      );
    }

    // ---------- Admin 2FA path ----------
    if (String(user.role || '').trim().toLowerCase() === 'admin') {
      const otpDestination = (user.email || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
      if (!otpDestination) {
        return res.status(400).json({
          success: false,
          message: 'Admin has no email configured. Contact support.'
        });
      }

      if (!user.email && process.env.ADMIN_EMAIL) {
        try {
          user.email = otpDestination;
          await user.save();
          console.log('[login] attached ADMIN_EMAIL to legacy admin');
        } catch (e) {
          console.warn('[login] could not persist admin email:', e.message);
        }
      }

      const otp = Math.floor(100000 + Math.random() * 900000).toString();

      // ⚡ Store OTP server-side; JWT carries only an opaque id
      const pendingId = crypto.randomBytes(24).toString('hex');
      adminLoginStore.set(pendingId, {
        userId: user._id.toString(),
        otp,
        expiresAt: Date.now() + 10 * 60 * 1000,
        attempts: 0
      });
      setTimeout(() => adminLoginStore.delete(pendingId), 10 * 60 * 1000);

      const pendingToken = jwt.sign({ pendingId }, JWT_SECRET, { expiresIn: '10m' });

      try {
        await withTimeout(
          transporter.sendMail({
            to: otpDestination,
            subject: 'Aerospace Portal — Admin Login OTP',
            text: `Hi ${user.fullName || user.username},\n\nYour admin login OTP is: ${otp}\n\nValid for 10 minutes. Do not share.\n\nIf this wasn't you, ignore this email.`
          }),
          30000,
          'Admin 2FA OTP send'
        );
      } catch (emailErr) {
        console.error('[login-2fa] ❌ OTP send failed for', otpDestination, '·', emailErr.message);

        let hint = 'Please try again in a moment.';
        const m = String(emailErr.message || '');
        if (/Brevo 401|Brevo 403/i.test(m))                          hint = 'Email API key is invalid — check BREVO_API_KEY.';
        else if (/Brevo 400/i.test(m))                               hint = 'Brevo rejected the sender — verify BREVO_SENDER_EMAIL.';
        else if (/EAUTH|535|Username and Password/i.test(m))         hint = 'SMTP auth failed — EMAIL_PASS must be a Gmail App Password.';
        else if (/ENETUNREACH|ETIMEDOUT|ECONNREFUSED/i.test(m))      hint = 'Server cannot reach the mail host. Enable Brevo (HTTPS) — Render blocks outbound SMTP.';
        else if (/All email transports failed/i.test(m))             hint = 'No mail transport is configured. Set BREVO_API_KEY + BREVO_SENDER_EMAIL.';

        return res.status(500).json({
          success: false,
          message: `Could not send 2FA OTP. ${hint}`
        });
      }

      console.log('[login-2fa] OTP sent to', otpDestination);
      return res.json({
        success: true,
        requires2FA: true,
        pendingToken,
        maskedEmail: maskEmail(otpDestination),
        message: 'Password verified. Enter the OTP sent to your email.'
      });
    }

    // ---------- Student login ----------
    if (user.role === 'student') {
      try {
        bumpStreak(user);
      } catch (bumpErr) {
        console.warn('[login] bumpStreak failed (non-fatal):', bumpErr.message);
      }
    }
    // ---------- 1. ATOMIC WRITE: streak + session in ONE round trip ----------
    // Previously this handler performed TWO separate writes plus a
    // verification read on every login:
    //
    //   • user.save()          → persisted the streak update
    //   • User.updateOne(...)  → persisted the new session
    //   • User.findById(...)   → verified the session write landed
    //
    // That's 3 DB round trips during the write phase. On a slow link
    // to Atlas — or any high-latency campus proxy sitting between the
    // client and the server — each round trip adds 50–200 ms to the
    // login time. We now do ONE atomic updateOne covering everything
    // that actually needs to change. The verification read is kept
    // in development only, so production logins save one round trip
    // while dev still catches schema issues early.
    const sessionId  = crypto.randomBytes(24).toString('hex');
    const deviceInfo = String(req.headers['user-agent'] || 'Unknown device').slice(0, 200);
    const now        = new Date();

    const updateSet = {
      activeSession: { sessionId, deviceInfo, loginAt: now, lastSeenAt: now }
    };

    /* For students, persist the current streak in the SAME write.
       bumpStreak() was already called in the student branch above,
       so the in-memory values are already up to date. It's a tiny
       payload and the write is idempotent, so we just always include
       the fields rather than computing a diff. Non-student roles
       skip this branch entirely. */
    if (user.role === 'student') {
      updateSet.streakCount    = user.streakCount;
      updateSet.longestStreak  = user.longestStreak;
      updateSet.lastActiveDate = user.lastActiveDate;
    }

    let sessionOk = false;
    let sessionWarning = null;

    try {
      const upd = await User.updateOne(
        { _id: user._id },
        { $set: updateSet }
      );
      sessionOk = !!(upd && (upd.matchedCount || 0) > 0);

      /* Verification read — development only. In production the
         write is trusted because updateOne returning matchedCount
         > 0 already proves the document exists and was updated. */
      if (sessionOk && process.env.NODE_ENV !== 'production') {
        const verify = await User.findById(user._id).select('activeSession').lean();
        sessionOk = !!(verify &&
                       verify.activeSession &&
                       verify.activeSession.sessionId === sessionId);
      }
    } catch (sessErr) {
      sessionWarning = sessErr.message;
      console.warn('[login] ⚠️ activeSession write failed:', sessErr.message);
    }

    if (!sessionOk) {
      console.warn(
        '[login] ⚠️ session bookkeeping failed — issuing token anyway. ' +
        (sessionWarning
          ? 'Reason: ' + sessionWarning
          : 'Check that the User schema defines `activeSession`.')
      );
    } else {
      console.log(
        `[login] 🔐 session issued · user=${user.username} · sid=${sessionId.slice(0,8)}…`
      );
    }

    // ---------- 3. Issue token (with sessionId embedded) ----------
    const token = jwt.sign(
      { id: user._id, role: user.role, sessionId },
      JWT_SECRET,
      { expiresIn: '1d' }
    );

    // ---------- 4. Serialize (defensive) ----------
    let serialized;
    try {
      serialized = serializeUser(user);
    } catch (serErr) {
      console.error('[login] serializeUser failed:', serErr);
      return res.status(500).json({
        success: false,
        message: 'Login succeeded but user data could not be prepared. Please contact support.'
      });
    }

    console.log(`[login] ✅ success ${user.username} (${user.role}) in ${Date.now() - t0}ms`);
    return res.json({
      success: true,
      message: 'Login successful!',
      token,
      user: serialized
    });

  } catch (e) {
    console.error('[login] 💥 unhandled:', e);
    return res.status(500).json({
      success: false,
      message: 'Server error: ' + (e.message || 'unknown')
    });
  }
});

/* ============================================================
   ADMIN 2FA — step 2 of 2 (verify OTP → issue JWT)
   ============================================================ */
app.post('/api/admin/login/verify-otp', async (req, res) => {
  try {
    const { pendingToken, otp } = req.body || {};
    if (!pendingToken || !otp) {
      return res.status(400).json({ success: false, message: 'Missing token or OTP.' });
    }

    let decoded;
    try {
      decoded = jwt.verify(pendingToken, JWT_SECRET);
    } catch (err) {
      return res.status(400).json({ success: false, message: 'Session expired or invalid. Please log in again.' });
    }

    const record = adminLoginStore.get(decoded.pendingId);
    if (!record) {
      return res.status(400).json({ success: false, message: 'Session expired. Please log in again.' });
    }
    if (Date.now() > record.expiresAt) {
      adminLoginStore.delete(decoded.pendingId);
      return res.status(400).json({ success: false, message: 'OTP expired. Please log in again.' });
    }
    if (record.attempts >= 5) {
      adminLoginStore.delete(decoded.pendingId);
      return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please log in again.' });
    }
    if (String(otp).trim() !== record.otp) {
      record.attempts++;
      return res.status(400).json({
        success: false,
        message: `Incorrect OTP. ${5 - record.attempts} attempt${5 - record.attempts === 1 ? '' : 's'} remaining.`
      });
    }

    // OTP verified — burn it
    adminLoginStore.delete(decoded.pendingId);

    const user = await User.findById(record.userId);
    if (!user || String(user.role || '').trim().toLowerCase() !== 'admin') {
      return res.status(401).json({ success: false, message: 'Admin account not found.' });
    }

    // Single-device session — atomic write (see /api/login for rationale)
    const sessionId  = crypto.randomBytes(24).toString('hex');
    const deviceInfo = String(req.headers['user-agent'] || 'Unknown device').slice(0, 200);
    const now        = new Date();

    let sessionOk = false;
    try {
      const upd = await User.updateOne(
        { _id: user._id },
        {
          $set: {
            activeSession: { sessionId, deviceInfo, loginAt: now, lastSeenAt: now }
          }
        }
      );
      sessionOk = !!(upd && (upd.matchedCount || 0) > 0);

      if (sessionOk) {
        const verify = await User.findById(user._id).select('activeSession').lean();
        sessionOk = !!(verify &&
                       verify.activeSession &&
                       verify.activeSession.sessionId === sessionId);
      }
    } catch (sessErr) {
      console.error('[login-2fa/verify] ❌ could not persist activeSession:', sessErr);
      return res.status(500).json({ success: false, message: 'Could not establish session.' });
    }

    if (!sessionOk) {
      return res.status(500).json({ success: false, message: 'Could not establish session.' });
    }

    console.log(`[login-2fa] 🔐 session issued · user=${user.username} · sid=${sessionId.slice(0,8)}…`);

    const token = jwt.sign(
      { id: user._id, role: user.role, sessionId },
      JWT_SECRET,
      { expiresIn: '1d' }
    );

    console.log('[login-2fa] ✅ Admin login success:', user.username);
    return res.json({
      success: true,
      message: 'Login successful!',
      token,
      user: serializeUser(user)
    });

  } catch (e) {
    console.error('[login-2fa/verify] Error:', e);
    return res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

/* ============================================================
   SESSION CHECK — single-device login enforcement
   ------------------------------------------------------------
   The frontend polls this endpoint every ~20 seconds with its
   Bearer token. If the token's sessionId no longer matches the
   user's current activeSession.sessionId, we return HTTP 401
   with code=SESSION_REPLACED so the frontend can force-logout
   the old device with a clear message.
   ============================================================ */
app.get('/api/auth/session-check', async (req, res) => {
  // Never let an intermediary cache the session verdict.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        code: 'NO_TOKEN',
        message: 'No session token provided.'
      });
    }
    const token = auth.slice(7);
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(401).json({
        success: false,
        code: 'INVALID_TOKEN',
        message: 'Your session has expired. Please log in again.'
      });
    }

    const user = await User.findById(decoded.id)
      .select('activeSession role username')
      .lean();

    if (!user) {
      return res.status(401).json({
        success: false,
        code: 'USER_NOT_FOUND',
        message: 'Account no longer exists.'
      });
    }

    const currentSessionId = user.activeSession && user.activeSession.sessionId;

    if (!currentSessionId) {
      console.warn(
        `[session-check] no activeSession record for ${user.username} — accepting token`
      );
      return res.json({ success: true, valid: true });
    }

    if (currentSessionId !== decoded.sessionId) {
      console.log(
        `[session-check] ⚠️  session replaced · user=${user.username}` +
        ` · token=${String(decoded.sessionId).slice(0,8)}…` +
        ` · current=${String(currentSessionId).slice(0,8)}…`
      );
      return res.status(401).json({
        success: false,
        code: 'SESSION_REPLACED',
        message: 'You were signed out because this account was just signed in on another device.'
      });
    }

    // Fire-and-forget lastSeen update (throttled to at most 1 write / 5 min)
    const now = Date.now();
    const lastSeen = user.activeSession.lastSeenAt
      ? new Date(user.activeSession.lastSeenAt).getTime()
      : 0;
    if (now - lastSeen > 5 * 60 * 1000) {
      User.updateOne(
        { _id: user._id },
        { $set: { 'activeSession.lastSeenAt': new Date() } }
      ).catch(() => {});
    }

    res.json({ success: true, valid: true });
  } catch (e) {
    console.error('[auth/session-check]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* ============================================================
   LOGOUT — clears the user's activeSession on the server
   Only clears if the requesting token's sessionId matches,
   so a new-device logout doesn't kick out the old device.
   ============================================================ */
app.post('/api/auth/logout', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.json({ success: true, message: 'Already logged out.' });
    }
    const token = auth.slice(7);
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.json({ success: true, message: 'Session already expired.' });
    }

    const user = await User.findById(decoded.id).select('activeSession');
    if (user && user.activeSession && user.activeSession.sessionId === decoded.sessionId) {
      user.activeSession.sessionId = null;
      user.activeSession.loginAt = null;
      user.activeSession.lastSeenAt = null;
      await user.save();
    }

    res.json({ success: true, message: 'Logged out.' });
  } catch (e) {
    console.error('[auth/logout]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* ============================================================
   ADMIN 2FA — resend OTP (STATELESS)
   ============================================================ */
app.post('/api/admin/login/resend-otp', async (req, res) => {
  try {
    const { pendingToken } = req.body || {};
    if (!pendingToken) return res.status(400).json({ success: false, message: 'Missing token.' });

    let decoded;
    try {
      decoded = jwt.verify(pendingToken, JWT_SECRET);
    } catch (err) {
      return res.status(400).json({ success: false, message: 'Session expired. Please log in again.' });
    }

    const oldRecord = adminLoginStore.get(decoded.pendingId);
    if (!oldRecord) {
      return res.status(400).json({ success: false, message: 'Session expired. Please log in again.' });
    }

    const user = await User.findById(oldRecord.userId);
    if (!user) return res.status(404).json({ success: false, message: 'Admin account not found.' });

    // Generate new OTP + new pendingId (single-use)
    const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const newPendingId = crypto.randomBytes(24).toString('hex');
    adminLoginStore.set(newPendingId, {
      userId: user._id.toString(),
      otp: newOtp,
      expiresAt: Date.now() + 10 * 60 * 1000,
      attempts: 0
    });
    adminLoginStore.delete(decoded.pendingId);  // invalidate the old one
    setTimeout(() => adminLoginStore.delete(newPendingId), 10 * 60 * 1000);

    const newPendingToken = jwt.sign({ pendingId: newPendingId }, JWT_SECRET, { expiresIn: '10m' });

    await withTimeout(
      transporter.sendMail({
        to: user.email || process.env.ADMIN_EMAIL,
        subject: 'Aerospace Portal — Admin Login OTP (resent)',
        text: `Hi ${user.fullName || user.username},\n\nYour new admin login OTP is: ${newOtp}\n\nValid for 10 minutes. Do not share.`
      }),
      30000,
      'Admin 2FA resend'
    );

    res.json({ success: true, message: 'New OTP sent to your email.', pendingToken: newPendingToken });
  } catch (e) {
    console.error('[login-2fa/resend] Error:', e);
    res.status(500).json({ success: false, message: 'Could not resend OTP: ' + e.message });
  }
});

/* ============================================================
   ADMIN — self-service credential update
   ============================================================ */
app.put('/api/admin/update-credentials', requireAdminAuth, async (req, res) => {
  try {
    const adminId = String(req.adminUser._id);
    const { currentPassword, newUsername, newPassword } = req.body || {};

    if (!currentPassword) return res.status(400).json({ success: false, message: 'Current password required.' });
    if (!newUsername && !newPassword) {
      return res.status(400).json({ success: false, message: 'Provide a new username and/or new password.' });
    }

    const user = await User.findById(adminId);
    if (!user || String(user.role || '').trim().toLowerCase() !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin only.' });
    }

    const passwordOk = await bcrypt.compare(currentPassword, user.password);
    if (!passwordOk) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }

    const changes = [];

    // ---- Username ----
    if (newUsername !== undefined && String(newUsername).trim() !== '' && String(newUsername).trim().toLowerCase() !== user.username) {
      const clean = String(newUsername).trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,30}$/.test(clean)) {
        return res.status(400).json({ success: false, message: 'Username must be 3–30 chars (letters, numbers, dots, underscores, hyphens).' });
      }
      const taken = await User.findOne({ username: clean, _id: { $ne: user._id } });
      if (taken) return res.status(409).json({ success: false, message: 'That username is already taken.' });
      user.username = clean;
      changes.push('username');
    }

    // ---- Password ----
    if (newPassword !== undefined && String(newPassword).length > 0) {
      const pw = String(newPassword);
      if (pw.length < 8) {
        return res.status(400).json({ success: false, message: 'New password must be at least 8 characters.' });
      }
      if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) {
        return res.status(400).json({ success: false, message: 'New password must contain at least one letter and one number.' });
      }
      user.password = await bcrypt.hash(pw, 10);
      changes.push('password');
    }

    if (changes.length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to update.' });
    }

    await user.save();

    // Fire-and-forget alert email
    sendAdminCredentialChangeAlert({
      adminUser: user,
      changeType: changes.join(' + '),
      ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown'
    });

    console.log(`[admin] ✅ Credentials updated for ${user.username}: ${changes.join(', ')}`);
    res.json({
      success: true,
      message: `Updated: ${changes.join(', ')}. Check your email for the security alert.`,
      user: serializeUser(user)
    });
  } catch (e) {
    console.error('[admin/update-credentials] Error:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

/* ============================================================
   REGISTRATION (OTP) — same transporter as bulk email
   ------------------------------------------------------------
   FIX: Uses MongoDB-backed otpSet/otpGet/otpDel helpers so OTPs
   survive server restarts on Render free tier.
   ============================================================ */

app.post('/api/send-otp', async (req, res) => {
  try {
    const { email, username, phone } = req.body || {};
    const cleanUsername = String(username || '').trim().toLowerCase();
    const cleanEmail    = String(email || '').trim().toLowerCase();
    const cleanPhone    = normalizePhone(phone);

    if (!cleanEmail) return res.status(400).json({ success: false, message: 'Email is required.' });
    if (!cleanPhone) return res.status(400).json({ success: false, message: 'A valid contact number is required.' });

    const existingUser = await User.findOne({
      $or: [
        { username: cleanUsername },
        { email: cleanEmail },
        { phone: cleanPhone }
      ]
    });
    if (existingUser) {
      let field = 'Username';
      if (existingUser.email === cleanEmail) field = 'Email';
      else if (existingUser.phone === cleanPhone) field = 'Contact number';
      return res.status(400).json({ success: false, message: `${field} already exists!` });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await otpSet(cleanEmail, {
      otp,
      phone: cleanPhone,
      expiresAt: Date.now() + 10 * 60 * 1000,
      attempts: 0
    }, 10 * 60 * 1000);

    // ---- Email OTP (blocking, must succeed) ----
    await withTimeout(
      transporter.sendMail({
        to: cleanEmail,
        subject: 'Aerospace Portal - Registration OTP',
        text: `Welcome!\n\nYour OTP: ${otp}\n\nDo not share this. It expires in 10 minutes.`
      }),
      30000,
      'OTP email send'
    );

    // ---- SMS OTP (best-effort — doesn't fail the request) ----
    sendSMS(cleanPhone, `Aerospace Portal: Your registration OTP is ${otp}. Valid for 10 min. Do not share.`)
      .catch(() => {});

    res.json({ success: true, message: 'OTP sent to your email and phone.' });
  } catch (e) {
    console.error('[send-otp] Error:', e.message);
    res.status(500).json({ success: false, message: 'Error sending OTP: ' + e.message });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { fullName, username, email, phone, password, otp, referralCode } = req.body || {};
    const cleanEmail    = String(email || '').trim().toLowerCase();
    const cleanUsername = String(username || '').trim().toLowerCase();
    const cleanPhone    = normalizePhone(phone);

    if (!fullName || !cleanUsername || !cleanEmail || !cleanPhone || !password) {
      return res.status(400).json({ success: false, message: 'All fields are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    const record = await otpGet(cleanEmail);
    if (!record) {
      return res.status(400).json({ success: false, message: 'No OTP was requested for this email (or it expired).' });
    }
    if (record.attempts >= 5) {
      await otpDel(cleanEmail);
      return res.status(400).json({ success: false, message: 'Too many incorrect attempts. Request a new OTP.' });
    }
    if (String(otp || '').trim() !== record.otp) {
      await otpBumpAttempts(cleanEmail);
      return res.status(400).json({ success: false, message: 'Invalid OTP. Please try again.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // ---- Referral code lookup (before creating the new user) ----
    let referrerUser = null;
    const cleanRefCode = String(referralCode || '').trim().toUpperCase();
    if (cleanRefCode) {
      try {
        referrerUser = await User.findOne({
          referralCode: cleanRefCode,
          role: 'student'
        });
        if (!referrerUser) {
          console.warn(`[register] Unknown referral code: ${cleanRefCode}`);
          referrerUser = null;
        } else if (referrerUser.email === cleanEmail || referrerUser.username === cleanUsername) {
          referrerUser = null; // self-referral guard
        }
      } catch (e) {
        console.warn('[register] referral lookup failed:', e.message);
        referrerUser = null;
      }
    }

    // ---- Create the new user ----
    const newUser = new User({
      fullName: String(fullName).trim(),
      username: cleanUsername,
      email:    cleanEmail,
      phone:    cleanPhone,
      password: hashedPassword,
      role: 'student',
      referredBy: referrerUser ? referrerUser.referralCode : null
    });
    newUser.referralCode = generateReferralCode(cleanUsername, fullName);

    // Safety: ensure uniqueness (rare collision)
    for (let i = 0; i < 6; i++) {
      const clash = await User.findOne({ referralCode: newUser.referralCode }).select('_id').lean();
      if (!clash) break;
      newUser.referralCode = generateReferralCode(cleanUsername, fullName);
    }

    await newUser.save();
    console.log(`[register] ✅ Created ${cleanUsername} · referralCode=${newUser.referralCode}${referrerUser ? ' · referredBy=' + referrerUser.referralCode : ''}`);

    // ---- Referral tracking: bump referrer + grant reward if threshold met ----
    if (referrerUser) {
      try {
        const settings = await getGlobalSettings();
        if (!referrerUser.referralStats) referrerUser.referralStats = {};
        referrerUser.referralStats.totalReferred = (referrerUser.referralStats.totalReferred || 0) + 1;

        const threshold = Math.max(1, Number(settings.referralThreshold) || 3);
        const rewardDays = Math.max(1, Number(settings.referralRewardDays) || 30);
        const rewardedFor = referrerUser.referralStats.rewardedFor || 0;
        const total = referrerUser.referralStats.totalReferred || 0;
        const expectedRewards = Math.floor(total / threshold);

        if (settings.referralEnabled && expectedRewards > rewardedFor) {
          const rewardsToGrant = expectedRewards - rewardedFor;
          for (let i = 0; i < rewardsToGrant; i++) {
            referrerUser.referralStats.rewardedFor = rewardedFor + i + 1;
            await grantReferralReward(referrerUser, rewardDays, settings);
          }
        } else {
          await referrerUser.save();
        }
      } catch (refErr) {
        console.warn('[register] referral update failed (non-fatal):', refErr.message);
      }
    }

    await otpDel(cleanEmail);
    res.json({ success: true, message: 'Registration successful! You can now log in.' });
  } catch (e) {
    console.error('[register] Error:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});
/* ============================================================
   FORGOT USERNAME / FORGOT PASSWORD / RESET PASSWORD
   ============================================================ */
const forgotUsernameStore = {};   // key: email|phone → { otp, expiresAt, attempts, userId }
const forgotPasswordStore = {};   // key: email|phone → { otp, expiresAt, attempts, userId }
const passwordResetTokens = {};   // token → { userId, expiresAt }

function storeKeyFor(user) {
  // Use email as the primary key; phone falls back if email missing
  return (user.email || user.phone || '').toLowerCase();
}

/* ---- Step 1: Request OTP for forgot-username ---- */
app.post('/api/forgot-username/send-otp', async (req, res) => {
  try {
    const { email, phone } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPhone = normalizePhone(phone);

    if (!cleanEmail && !cleanPhone) {
      return res.status(400).json({ success: false, message: 'Please provide your email or contact number.' });
    }

    const or = [];
    if (cleanEmail) or.push({ email: cleanEmail });
    if (cleanPhone) or.push({ phone: cleanPhone });

    const user = await User.findOne({ $or: or });
    if (!user) {
      return res.status(404).json({ success: false, message: 'No account found with those details.' });
    }

    // Admins must recover via their registered email only
    if (user.role === 'admin' && !cleanEmail) {
      return res.status(400).json({
        success: false,
        message: 'Admins must recover using their registered email address.'
      });
    }
    if (user.role === 'admin' && !user.email) {
      return res.status(400).json({
        success: false,
        message: 'This admin has no email on file. Contact support.'
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const key = storeKeyFor(user);
    forgotUsernameStore[key] = {
      otp,
      userId: user._id.toString(),
      expiresAt: Date.now() + 10 * 60 * 1000,
      attempts: 0
    };

    // Email (best-effort if user has one)
    if (user.email) {
      transporter.sendMail({
        to: user.email,
        subject: 'Aerospace Portal - Username Recovery OTP',
        text: `Hi ${user.fullName || user.username},\n\nYour OTP for username recovery is: ${otp}\n\nValid for 10 minutes. Do not share.`
      }).catch((e) => console.warn('[forgot-username] email failed:', e.message));
    }

    // SMS (best-effort)
    if (user.phone) {
      sendSMS(user.phone, `Aerospace Portal: Your username-recovery OTP is ${otp}. Valid 10 min. Do not share.`)
        .catch(() => {});
    }

    res.json({
      success: true,
      message: 'OTP sent. Check your email and phone.',
      deliveredTo: {
        email: user.email ? maskEmail(user.email) : null,
        phone: user.phone ? user.phone.slice(0, 3) + '****' + user.phone.slice(-2) : null
      }
    });
  } catch (e) {
    console.error('[forgot-username/send-otp]', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

/* ---- Step 2: Verify OTP → send username via SMS + email ---- */
app.post('/api/forgot-username/verify', async (req, res) => {
  try {
    const { email, phone, otp } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPhone = normalizePhone(phone);

    const or = [];
    if (cleanEmail) or.push({ email: cleanEmail });
    if (cleanPhone) or.push({ phone: cleanPhone });

    const user = await User.findOne({ $or: or });
    if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });

    const key = storeKeyFor(user);
    const record = forgotUsernameStore[key];
    if (!record) return res.status(400).json({ success: false, message: 'No OTP requested.' });
    if (Date.now() > record.expiresAt) {
      delete forgotUsernameStore[key];
      return res.status(400).json({ success: false, message: 'OTP expired. Request a new one.' });
    }
    if (record.attempts >= 5) {
      delete forgotUsernameStore[key];
      return res.status(400).json({ success: false, message: 'Too many attempts. Request a new OTP.' });
    }
    if (String(otp || '').trim() !== record.otp) {
      record.attempts = (record.attempts || 0) + 1;
      return res.status(400).json({ success: false, message: 'Invalid OTP.' });
    }

    delete forgotUsernameStore[key];

    // Send username via SMS (primary channel — as required)
    if (user.phone) {
      sendSMS(user.phone, `Aerospace Portal: Your username is "${user.username}".`)
        .catch(() => {});
    }
    // Email copy (fallback, so user isn't stuck if SMS is not configured)
    if (user.email) {
      transporter.sendMail({
        to: user.email,
        subject: 'Aerospace Portal - Your Username',
        text: `Hi ${user.fullName || user.username},\n\nYour username is: ${user.username}\n\n— Aerospace Department`
      }).catch(() => {});
    }

    res.json({
      success: true,
      message: 'Your username has been sent to your registered phone and email.'
    });
  } catch (e) {
    console.error('[forgot-username/verify]', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

/* ---- Forgot Password: Step 1 — send OTP ---- */
app.post('/api/forgot-password/send-otp', async (req, res) => {
  try {
    const { email, phone } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPhone = normalizePhone(phone);

    if (!cleanEmail && !cleanPhone) {
      return res.status(400).json({ success: false, message: 'Please provide your email or contact number.' });
    }

    const or = [];
    if (cleanEmail) or.push({ email: cleanEmail });
    if (cleanPhone) or.push({ phone: cleanPhone });

    const user = await User.findOne({ $or: or });
    if (!user) return res.status(404).json({ success: false, message: 'No account found with those details.' });

    // Admins must recover via their registered email only
    if (user.role === 'admin' && !cleanEmail) {
      return res.status(400).json({
        success: false,
        message: 'Admins must reset their password using their registered email address.'
      });
    }
    if (user.role === 'admin' && !user.email) {
      return res.status(400).json({
        success: false,
        message: 'This admin has no email on file. Contact support.'
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const key = storeKeyFor(user);
    forgotPasswordStore[key] = {
      otp,
      userId: user._id.toString(),
      expiresAt: Date.now() + 10 * 60 * 1000,
      attempts: 0
    };

    if (user.email) {
      transporter.sendMail({
        to: user.email,
        subject: 'Aerospace Portal - Password Reset OTP',
        text: `Hi ${user.fullName || user.username},\n\nYour password-reset OTP is: ${otp}\n\nValid 10 min. If this wasn't you, ignore this email.`
      }).catch((e) => console.warn('[forgot-password] email failed:', e.message));
    }

    if (user.phone) {
      sendSMS(user.phone, `Aerospace Portal: Your password-reset OTP is ${otp}. Valid 10 min. Do not share.`)
        .catch(() => {});
    }

    res.json({
      success: true,
      message: 'OTP sent. Check your email and phone.',
      deliveredTo: {
        email: user.email ? maskEmail(user.email) : null,
        phone: user.phone ? user.phone.slice(0, 3) + '****' + user.phone.slice(-2) : null
      }
    });
  } catch (e) {
    console.error('[forgot-password/send-otp]', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

/* ---- Forgot Password: Step 2 — verify OTP, issue reset token ---- */
app.post('/api/forgot-password/verify', async (req, res) => {
  try {
    const { email, phone, otp } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPhone = normalizePhone(phone);

    const or = [];
    if (cleanEmail) or.push({ email: cleanEmail });
    if (cleanPhone) or.push({ phone: cleanPhone });

    const user = await User.findOne({ $or: or });
    if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });

    const key = storeKeyFor(user);
    const record = forgotPasswordStore[key];
    if (!record) return res.status(400).json({ success: false, message: 'No OTP requested.' });
    if (Date.now() > record.expiresAt) {
      delete forgotPasswordStore[key];
      return res.status(400).json({ success: false, message: 'OTP expired. Request a new one.' });
    }
    if (record.attempts >= 5) {
      delete forgotPasswordStore[key];
      return res.status(400).json({ success: false, message: 'Too many attempts. Request a new OTP.' });
    }
    if (String(otp || '').trim() !== record.otp) {
      record.attempts = (record.attempts || 0) + 1;
      return res.status(400).json({ success: false, message: 'Invalid OTP.' });
    }

    delete forgotPasswordStore[key];

    // Issue a short-lived, single-use reset token
    const token = crypto.randomBytes(32).toString('hex');
    passwordResetTokens[token] = {
      userId: user._id.toString(),
      expiresAt: Date.now() + 15 * 60 * 1000
    };

    res.json({ success: true, message: 'OTP verified. You can now set a new password.', resetToken: token });
  } catch (e) {
    console.error('[forgot-password/verify]', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

/* ---- Forgot Password: Step 3 — save new password ---- */
app.post('/api/forgot-password/reset', async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body || {};
    if (!resetToken || !newPassword) {
      return res.status(400).json({ success: false, message: 'Missing token or password.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    const rec = passwordResetTokens[resetToken];
    if (!rec) return res.status(400).json({ success: false, message: 'Invalid or already-used reset link.' });
    if (Date.now() > rec.expiresAt) {
      delete passwordResetTokens[resetToken];
      return res.status(400).json({ success: false, message: 'Reset session expired. Start over.' });
    }

    const user = await User.findById(rec.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    // Notify admins that their password was reset via recovery
    if (user.role === 'admin') {
      sendAdminCredentialChangeAlert({
        adminUser: user,
        changeType: 'password (recovered)',
        ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown'
      });
    }

    delete passwordResetTokens[resetToken];
    res.json({ success: true, message: 'Password updated successfully. You can now log in.' });
  } catch (e) {
    console.error('[forgot-password/reset]', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

/* ============================================================
   ADMIN — Student Management
   ============================================================ */
app.post('/api/admin/create-student', requireAdminAuth, async (req, res) => {
  try {
    const { fullName, username, email, password } = req.body;
    if (!fullName || !username || !password) {
      return res.status(400).json({ success: false, message: 'Full name, username, and password are required.' });
    }
    const cleanUsername = String(username).trim().toLowerCase();
    if (cleanUsername.length < 3) return res.status(400).json({ success: false, message: 'Username must be at least 3 characters.' });
    if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });

    const existingUsername = await User.findOne({ username: cleanUsername });
    if (existingUsername) return res.status(400).json({ success: false, message: 'Username is already taken.' });

    if (email) {
      const existingEmail = await User.findOne({ email: String(email).trim() });
      if (existingEmail) return res.status(400).json({ success: false, message: 'Email is already registered.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newStudent = new User({
      fullName: String(fullName).trim(),
      username: cleanUsername,
      email: email ? String(email).trim() : '',
      password: hashedPassword,
      role: 'student'
    });
    await newStudent.save();

    console.log('[admin] ✅ Created student:', cleanUsername);
    res.json({
      success: true,
      message: 'Student created successfully!',
      student: {
        _id: newStudent._id,
        fullName: newStudent.fullName,
        username: newStudent.username,
        email: newStudent.email || '',
        password: password,
        createdAt: newStudent.createdAt || new Date()
      }
    });
  } catch (e) {
    console.error('[admin create-student] Error:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

app.post('/api/admin/reset-password/:userId', requireAdminAuth, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ success: true, message: 'Password reset successfully.', password: newPassword });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

	app.delete('/api/admin/students/:userId', requireAdminAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (String(user.role || '').trim().toLowerCase() === 'admin') return res.status(400).json({ success: false, message: 'Cannot delete admin accounts.' });
    await User.findByIdAndDelete(req.params.userId);
    res.json({ success: true, message: 'Student deleted.' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

/* ============================================================
   ADMIN — EMAIL DIAGNOSTIC
   ============================================================ */
app.get('/api/admin/email-status', requireAdminAuth, async (req, res) => {
  try {
    if (!USE_BREVO && !USE_SMTP && !USE_RESEND) {
      return res.json({
        success: true,
        ready: false,
        message: 'No mail transport configured. Set BREVO_API_KEY + BREVO_SENDER_EMAIL.'
      });
    }
    try {
      const v = await withTimeout(transporter.verify(), 10000, 'verify');
      res.json({
        success: true,
        ready: true,
        via: v.via,
        from: v.from,
        message: `Email ready via ${v.via}.`
      });
    } catch (err) {
      res.json({ success: true, ready: false, message: 'Verification failed: ' + err.message });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ============================================================
   ADMIN — BULK EMAIL (FIXED)
   ------------------------------------------------------------
   Design:
     • Bounded concurrency (8 parallel sends)
     • Hard 8s per-send timeout
     • 45s total budget — if exceeded, return partial with clear msg
     • Uses the SAME EMAIL_USER as OTP
   ============================================================ */
const BULK_CONCURRENCY = 8;
const PER_SEND_TIMEOUT_MS = 30000; // Changed from 8000
const TOTAL_BUDGET_MS = 45000;

app.post('/api/admin/send-email', requireAdminAuth, async (req, res) => {
  const startedAt = Date.now();
  try {
    const { recipientIds, subject, body } = req.body || {};
    const admin = req.adminUser;

    // ---- Email config check ----
    if (!EMAIL_USER || !EMAIL_PASS) {
      return res.status(500).json({
        success: false,
        message: 'Email is not configured on the server. Please check EMAIL_USER and EMAIL_PASS in .env.'
      });
    }

    // ---- Payload validation ----
    if (!Array.isArray(recipientIds) || recipientIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No recipients selected.' });
    }
    if (recipientIds.length > 200) {
      return res.status(400).json({ success: false, message: 'Too many recipients in one batch (max 200).' });
    }
    const cleanSubject = String(subject || '').trim();
    const cleanBody = String(body || '').trim();
    if (!cleanSubject) return res.status(400).json({ success: false, message: 'Subject is required.' });
    if (!cleanBody) return res.status(400).json({ success: false, message: 'Message body is required.' });
    if (cleanSubject.length > 200) return res.status(400).json({ success: false, message: 'Subject too long (max 200 chars).' });
    if (cleanBody.length > 10000) return res.status(400).json({ success: false, message: 'Message too long (max 10,000 chars).' });

    // ---- Fetch eligible students ----
    const students = await User.find({
      _id: { $in: recipientIds },
      role: 'student',
      email: { $exists: true, $nin: ['', null] }
    }).select('fullName username email');

    const skipped = recipientIds.length - students.length;
    if (students.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'None of the selected students have a valid email address.'
      });
    }

    console.log(`[bulk-email] admin=${admin.username} START → ${students.length} recipient(s), skipping ${skipped}`);

    // ---- Prebuild email content (once) ----
    const htmlShell = (greeting, messageHtml) => `
      <div style="font-family:Inter,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px 20px;color:#14161c;line-height:1.6;background:#ffffff;">
        <div style="border-left:4px solid #6366f1;padding-left:14px;margin-bottom:22px;">
          <div style="font-size:18px;font-weight:700;color:#14161c;">Aerospace Department</div>
          <div style="font-size:12px;color:#8b8d98;letter-spacing:.5px;">IIT KHARAGPUR</div>
        </div>
        <p style="font-size:15px;margin:0 0 14px;">${greeting}</p>
        <div style="font-size:15px;white-space:pre-wrap;margin-bottom:28px;">${messageHtml}</div>
        <div style="border-top:1px solid #ebe7e0;padding-top:16px;font-size:12.5px;color:#8b8d98;">
          — Aerospace Department<br/>IIT Kharagpur
        </div>
      </div>`;

    const messageHtml = nl2br(cleanBody);

    // ---- Send one email (with timeout) ----
    const sendOne = async (student) => {
      const firstName = (student.fullName || student.username || 'Student').split(' ')[0];
      const greeting = `Hi ${escapeHtml(firstName)},`;
      const textBody = `Hi ${firstName},\n\n${cleanBody}\n\n— Aerospace Department\nIIT Kharagpur`;

      await withTimeout(
        transporter.sendMail({
          to: student.email,
          replyTo: EMAIL_USER,
          subject: cleanSubject,
          text: textBody,
          html: htmlShell(greeting, messageHtml)
        }),
        PER_SEND_TIMEOUT_MS,
        `Email to ${student.email}`
      );
    };

    // ---- Send with bounded concurrency ----
    const results = await runWithConcurrency(students, sendOne, BULK_CONCURRENCY);

    // ---- Aggregate ----
    let sent = 0;
    const failures = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') sent++;
      else failures.push({
        email: students[i].email,
        name: students[i].fullName || students[i].username,
        error: String((r.reason && r.reason.message) || r.reason || 'Unknown error')
      });
    });

    const failed = failures.length;
    const elapsed = Date.now() - startedAt;
    const hitBudget = elapsed >= TOTAL_BUDGET_MS * 0.95;

    console.log(`[bulk-email] admin=${admin.username} DONE → sent=${sent}/${students.length} failed=${failed} skipped=${skipped} time=${elapsed}ms`);

    res.json({
      success: true,
      message: `Email sent to ${sent} of ${students.length} student${students.length === 1 ? '' : 's'}.` +
               (skipped > 0 ? ` ${skipped} skipped (no email).` : '') +
               (failed > 0 ? ` ${failed} failed — see details.` : '') +
               (hitBudget ? ' Batch size was large — try smaller batches next time.' : ''),
      sent, failed, skipped,
      total: students.length,
      elapsedMs: elapsed,
      failures
    });
  } catch (e) {
    console.error('[bulk-email] FATAL:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});
/* ============================================================
   PROFESSORS — CRUD
   ============================================================ */
app.get('/api/professors', async (req, res) => {
  try {
    // Browser must NEVER cache this response — hide/show toggles need
    // to reflect instantly for students. The server-side in-memory
    // cache below still protects MongoDB from repeated reads.
    const noStore = {
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Pragma': 'no-cache',
      'Expires': '0'
    };

    const cached = cacheGet('professors:all');
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Cache-Control', noStore['Cache-Control']);
      res.setHeader('Pragma', noStore['Pragma']);
      res.setHeader('Expires', noStore['Expires']);
      return res.json(cached);
    }

    const professors = await Professor.find()
      .select('-__v')
      .sort({ createdAt: 1 })
      .lean();

    const payload = { success: true, professors };
    cacheSet('professors:all', payload, 5 * 60 * 1000);

    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', noStore['Cache-Control']);
    res.setHeader('Pragma', noStore['Pragma']);
    res.setHeader('Expires', noStore['Expires']);
    res.json(payload);
  } catch (e) {
    console.error('[GET /api/professors]', e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/professors', requireAdminAuth, async (req, res) => {
  try {
    const newProf = new Professor(req.body);
    await newProf.save();
    res.json({ success: true, message: 'Professor added successfully!', professor: newProf });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Error adding professor: ' + e.message });
  }
});

	app.delete('/api/professors/:id', requireAdminAuth, async (req, res) => {
  try {
    // Safety check: ensure the ID is a valid MongoDB ObjectId
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid professor ID format.' });
    }
    
    const deletedProf = await Professor.findByIdAndDelete(req.params.id);
    
    if (!deletedProf) {
      return res.status(404).json({ success: false, message: 'Professor not found.' });
    }
    
    res.json({ success: true, message: 'Professor deleted successfully!' });
  } catch (e) {
    console.error('[delete-professor] Error:', e);
    res.status(500).json({ success: false, message: 'Error deleting professor: ' + e.message });
  }
});

/* ============================================================
   PROFESSOR — Visibility toggle (hide/show without deleting)
   ------------------------------------------------------------
   Sets `visible: true|false` on the professor document.
   No other field is touched — details stay 100% intact.
   Also clears the professors cache so the change is instant.
   ============================================================ */
app.put('/api/professors/:id/visibility', requireAdminAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid professor ID format.' });
    }

    const { visible } = req.body || {};
    if (typeof visible !== 'boolean') {
      return res.status(400).json({ success: false, message: '`visible` must be a boolean (true or false).' });
    }

    const updated = await Professor.findByIdAndUpdate(
      req.params.id,
      { $set: { visible } },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Professor not found.' });
    }

    // Flush the 5-minute professors cache so the next GET is fresh
    cacheClear('professors:');

    console.log(`[professor/visibility] ${updated.name} → visible=${visible}`);
    res.json({
      success: true,
      message: visible ? 'Professor is now visible to students.' : 'Professor hidden from students.',
      professor: updated
    });
  } catch (e) {
    console.error('[professor/visibility] Error:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});
/* ============================================================
   COURSES — CRUD
   ============================================================ */
/* Course list — strips heavy base64 file blobs.
   The fileData is fetched on-demand via /api/courses/:courseId/materials/:materialId/file
   only when a student actually opens a PDF. */
/* Course list — LIGHTWEIGHT VERSION
   Strips: fileData (base64), quiz questions
   Keeps: quizCount (computed), basic metadata, playlists, announcements */
app.get('/api/courses', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 80);
    const skip  = (page - 1) * limit;

    const cacheKey = `courses:list:${page}:${limit}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      // ⚡ Let the browser reuse this for 30s → instant repeat navigations.
      // stale-while-revalidate keeps UX snappy while we refresh in bg.
      res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=180');
      return res.json(cached);
    }

    const [courses, total] = await Promise.all([
      Course.aggregate([
        { $sort: { featured: -1, createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $project: {
            name: 1, code: 1, semester: 1, instructor: 1, description: 1,
            category: 1, difficulty: 1, duration: 1, credits: 1, language: 1,
            learningOutcomes: 1, thumbnail: 1, status: 1, featured: 1,
            isPremium: 1, price: 1, announcements: 1, playlists: 1,
            createdAt: 1, updatedAt: 1,
            doubtsCount: { $size: { $ifNull: ['$doubts', []] } },
            materials: {
              $map: {
                input: { $ifNull: ['$materials', []] },
                as: 'm',
                in: {
                  _id: '$$m._id', title: '$$m.title', type: '$$m.type',
                  description: '$$m.description', url: '$$m.url',
                  fileName: '$$m.fileName', isPremium: '$$m.isPremium',
                  price: '$$m.price',
                  previewPercent: '$$m.previewPercent',
                  estimatedTime: '$$m.estimatedTime',
                  tags: '$$m.tags', examConfig: '$$m.examConfig',
                  quizCount: { $size: { $ifNull: ['$$m.quiz', []] } }
                }
              }
            }
          }
        }
      ]),
      Course.countDocuments()
    ]);

    const payload = {
      success: true,
      courses,
      pagination: {
        page, limit, total,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total
      }
    };

    cacheSet(cacheKey, payload, 60000);
    res.setHeader('X-Cache', 'MISS');
    // ⚡ Browser-side 30s cache — repeat visits need zero network round trip.
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=180');
    res.json(payload);
  } catch (e) {
    console.error('[GET /api/courses]', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

/* ---- On-demand full material fetch (quiz questions) ---- */
/* ---- On-demand file fetch (PDF base64) — PREMIUM PROTECTED ---- */
app.get('/api/courses/:courseId/materials/:materialId/file',
  attachUserFromToken,
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.courseId)) {
        return res.status(400).json({ success: false, message: 'Invalid course ID.' });
      }

      const course = await Course.findById(req.params.courseId)
        .select('isPremium price materials')
        .lean();
      if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

      const mat = (course.materials || []).find(m => String(m._id) === String(req.params.materialId));
      if (!mat) return res.status(404).json({ success: false, message: 'Material not found' });

      // ⭐ Preview-aware access check
      const access = evaluateMaterialAccess(req.authUser, course, mat);

      if (!access.allowed && !access.canPreview) {
        return res.status(403).json({
          success: false,
          code: access.reason,
          message: 'This file is part of premium content. Purchase it or subscribe to unlock.'
        });
      }

      /* ⭐ FAST PATH — metadata-only response.
         Returns access flags + the on-disk file URL WITHOUT the huge
         base64 payload. The client uses this to decide whether to
         stream the PDF binary directly from /uploads/ (via range
         requests — orders of magnitude faster than base64-in-JSON).

         This is 100% additive: existing clients that don't send
         ?meta=1 continue to receive the original base64 response. */
      if (req.query.meta === '1') {
        const rawUrl = String(mat.url || '');
        let diskFileExists = false;
        let fileUrl = rawUrl;
        let signedUrlIssued = false;

        if (rawUrl.startsWith('/uploads/')) {
          const fn = path.basename(rawUrl);

          /* Path-traversal guard */
          const resolved   = path.resolve(path.join(UPLOAD_DIR, fn));
          const uploadRoot = path.resolve(UPLOAD_DIR);
          if (resolved.startsWith(uploadRoot + path.sep)) {
            try { diskFileExists = fs.existsSync(resolved); }
            catch (e) { diskFileExists = false; }
          }

          /* ⭐ Issue a signed URL when full access is granted.
                This eliminates per-range-request auth overhead. */
          if (diskFileExists && access.allowed && req.authUser) {
            try {
              const tok = signUploadToken(fn, String(req.authUser._id));
              fileUrl = `/uploads/${encodeURIComponent(fn)}` +
                        `?su=${encodeURIComponent(String(req.authUser._id))}` +
                        `&st=${encodeURIComponent(tok)}`;
              signedUrlIssued = true;
            } catch (e) {
              console.warn('[file-meta] signed URL build failed:', e.message);
              fileUrl = rawUrl;
            }
          }
        }

        return res.json({
          success:        true,
          meta:           true,
          fileName:       mat.fileName || '',
          fileUrl,
          originalUrl:    rawUrl,
          signedUrl:      signedUrlIssued,
          diskFileExists,
          hasInlineData:  !!mat.fileData,
          hasFullAccess:  !!access.allowed,
          previewPercent: access.canPreview ? access.previewPercent : 0,
          /* ⭐ NEW — lets the client show the correct message and CTA
             instead of a generic "locked" card. */
          reason:          access.reason || null,
          requiresLogin:   !req.authUser,
          isCoursePremium: !!(course.isPremium === true || course.isPremium === 'true'),
          isMatPremium:    !!(mat.isPremium    === true || mat.isPremium    === 'true')
        });
      }

      if (!mat.fileData) {
        return res.status(404).json({ success: false, message: 'No file attached.' });
      }

      res.json({
        success: true,
        fileData: mat.fileData,
        fileName: mat.fileName || '',
        hasFullAccess:   !!access.allowed,
        previewPercent:  access.canPreview ? access.previewPercent : 0
      });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Server error: ' + e.message });
    }
  }
);

/* ---- On-demand file fetch (PDF base64) ---- */
/* ---- On-demand full material fetch (quiz questions) — PREMIUM PROTECTED ---- */
app.get('/api/courses/:courseId/materials/:materialId/full-quiz',
  attachUserFromToken,
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.courseId)) {
        return res.status(400).json({ success: false, message: 'Invalid course ID.' });
      }

      const course = await Course.findById(req.params.courseId)
        .select('isPremium price materials')
        .lean();
      if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

      const mat = (course.materials || []).find(
        m => String(m._id) === String(req.params.materialId)
      );
      if (!mat) return res.status(404).json({ success: false, message: 'Material not found' });

      // ⭐ PREVIEW-AWARE ACCESS CHECK — preview mode also lets the quiz through
      const access = evaluateMaterialAccess(req.authUser, course, mat);
      if (!access.allowed && !access.canPreview) {
        return res.status(403).json({
          success: false,
          code: access.reason,
          message: 'This quiz is part of premium content. Purchase it or subscribe to unlock.'
        });
      }

      res.json({
        success: true,
        quiz: mat.quiz || [],
        examConfig: mat.examConfig || {}
      });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Server error: ' + e.message });
    }
  }
);

app.get('/api/courses/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid course ID' });
    }

    /* Server-side cache — 60 s. Auto-invalidated by cacheClear('courses:'). */
    const cacheKey = 'courses:single:' + req.params.id;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
      return res.json(cached);
    }

    const courses = await Course.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(req.params.id) } },
      {
        $project: {
          name: 1, code: 1, semester: 1, instructor: 1, description: 1,
          category: 1, difficulty: 1, duration: 1, credits: 1, language: 1,
          learningOutcomes: 1, thumbnail: 1, status: 1, featured: 1,
          isPremium: 1, price: 1, announcements: 1, playlists: 1, doubts: 1,
          createdAt: 1, updatedAt: 1,
          materials: {
            $map: {
              input: { $ifNull: ['$materials', []] },
              as: 'm',
              in: {
                _id:            '$$m._id',
                title:          '$$m.title',
                type:           '$$m.type',
                description:    '$$m.description',
                url:            '$$m.url',
                fileName:       '$$m.fileName',
                diskName:       '$$m.diskName',
                cloudUrl:       '$$m.cloudUrl',
                isPremium:      '$$m.isPremium',
                price:          '$$m.price',
                previewPercent: '$$m.previewPercent',
                estimatedTime:  '$$m.estimatedTime',
                tags:           '$$m.tags',
                examConfig:     '$$m.examConfig',
                quizCount:      { $size: { $ifNull: ['$$m.quiz', []] } }
              }
            }
          }
        }
      }
    ]);

    if (!courses || courses.length === 0) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    const payload = { success: true, course: courses[0] };
    cacheSet(cacheKey, payload, 60000);

    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
    res.json(payload);
  } catch (e) {
    console.error('[GET /api/courses/:id]', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

app.post('/api/courses', requireAdminAuth, async (req, res) => {
  try {
    const newCourse = new Course(req.body);
    await newCourse.save();
    cacheClear('courses:');
    res.json({ success: true, message: 'Course created successfully!', course: newCourse });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.put('/api/courses/:id', requireAdminAuth, async (req, res) => {
  try {
    const allowed = ['name','code','semester','instructor','description','category','difficulty','duration','learningOutcomes','thumbnail','status','featured','isPremium','price'];
    const update = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) update[f] = req.body[f]; });
    const updated = await Course.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!updated) return res.status(404).json({ success: false, message: 'Course not found' });
    cacheClear('courses:');
    res.json({ success: true, message: 'Course updated successfully!', course: updated });
  } catch (e) { res.status(500).json({ success: false, message: 'Error updating course: ' + e.message }); }
});

app.delete('/api/courses/:id', requireAdminAuth, async (req, res) => {
  try {
    await Course.findByIdAndDelete(req.params.id);
    cacheClear('courses:');
    res.json({ success: true, message: 'Course deleted successfully!' });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

/* ============================================================
   MATERIALS
   ============================================================ */
app.post('/api/courses/:courseId/materials', requireAdminAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ message: 'Course not found' });
    course.materials.push(req.body);
    await course.save();
    cacheClear('courses:');
    res.json({ success: true, message: 'Material added successfully!', course });
  } catch (e) {
    console.error('[materials/POST] ❌ Error:', e.message);
    console.error('[materials/POST] Stack:', e.stack);
    console.error('[materials/POST] Body:', JSON.stringify(req.body).slice(0, 500));
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

app.put('/api/courses/:courseId/materials/:materialId', requireAdminAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });
    const mat = course.materials.id(req.params.materialId);
    if (!mat) return res.status(404).json({ success: false, message: 'Material not found' });
    const fields = ['title', 'type', 'description', 'url', 'isPremium', 'price', 'previewPercent', 'fileData', 'fileName'];
    fields.forEach(f => { if (req.body[f] !== undefined) mat[f] = req.body[f]; });
    await course.save();
    cacheClear('courses:');
    res.json({ success: true, message: 'Material updated successfully!' });
  } catch (e) { res.status(500).json({ success: false, message: 'Error updating material: ' + e.message }); }
});

app.delete('/api/courses/:courseId/materials/:materialId', requireAdminAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });
    course.materials = course.materials.filter(m => m._id.toString() !== req.params.materialId);
    (course.playlists || []).forEach(pl => {
      pl.materialIds = pl.materialIds.filter(id => id !== req.params.materialId);
    });
    await course.save();
    cacheClear('courses:');
    res.json({ success: true, message: 'Material deleted successfully!' });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error deleting material.' }); }
});

/* ============================================================
   ANNOUNCEMENTS
   ============================================================ */
app.post('/api/courses/:courseId/announcements', requireAdminAuth, async (req, res) => {
  try {
    const { title, body, authorName } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ success: false, message: 'Title required' });
    const ann = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: title.trim(),
      body: (body || '').trim(),
      authorName: authorName || 'Instructor',
      date: new Date()
    };
    await Course.findByIdAndUpdate(req.params.courseId, { $push: { announcements: ann } });
    cacheClear('courses:');
    res.json({ success: true, message: 'Announcement posted!', announcement: ann });
  } catch (e) { res.status(500).json({ success: false, message: 'Error posting announcement: ' + e.message }); }
});

app.delete('/api/courses/:courseId/announcements/:annId', requireAdminAuth, async (req, res) => {
  try {
    await Course.findByIdAndUpdate(req.params.courseId, { $pull: { announcements: { id: req.params.annId } } });
    cacheClear('courses:');
    res.json({ success: true, message: 'Announcement deleted!' });
  } catch (e) { res.status(500).json({ success: false, message: 'Error deleting announcement.' }); }
});

/* ============================================================
   Q&A / DOUBTS
   ============================================================ */
app.post('/api/courses/:id/doubts', async (req, res) => {
  try {
    const { studentName, studentUsername, studentEmail, question } = req.body;
    await Course.findByIdAndUpdate(req.params.id, {
      $push: { doubts: { studentName, studentUsername, studentEmail, question, date: new Date() } }
    });
    cacheClear('courses:');
    res.json({ success: true, message: 'Doubt submitted successfully!' });
  } catch (e) { res.status(500).json({ success: false, message: 'Error submitting doubt' }); }
});

app.put('/api/courses/:courseId/doubts/:doubtId', async (req, res) => {
  try {
    const { answer } = req.body;
    await Course.updateOne(
      { _id: req.params.courseId, "doubts._id": req.params.doubtId },
      { $set: { "doubts.$.answer": answer } }
    );
    const course = await Course.findById(req.params.courseId);
    const doubt = course?.doubts?.id(req.params.doubtId);
    if (doubt && doubt.studentUsername) {
      const student = await User.findOne({ username: doubt.studentUsername });
      if (student) {
        if (!student.notifications) student.notifications = [];
        student.notifications.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          type: 'doubt-reply', title: 'Your doubt was answered!',
          body: `"${answer.slice(0, 100)}${answer.length > 100 ? '…' : ''}"`,
          courseId: req.params.courseId, link: `#/course/${req.params.courseId}`,
          read: false, createdAt: new Date()
        });
        if (student.notifications.length > 50) student.notifications = student.notifications.slice(-50);
        await student.save();
      }
    }
    res.json({ success: true, message: 'Answer posted!' });
  } catch (e) { res.status(500).json({ success: false, message: 'Error posting answer: ' + e.message }); }
});

app.post('/api/courses/:courseId/doubts/:doubtId/replies', async (req, res) => {
  try {
    const { authorName, authorUsername, authorRole, text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ success: false, message: 'Reply text required' });
    await Course.updateOne(
      { _id: req.params.courseId, "doubts._id": req.params.doubtId },
      { $push: { "doubts.$.replies": {
        authorName, authorUsername, authorRole: authorRole || 'student',
        text: text.trim(), date: new Date(), isAccepted: false
      } } }
    );
    const course = await Course.findById(req.params.courseId);
    const doubt = course?.doubts?.id(req.params.doubtId);
    if (doubt && doubt.studentUsername && doubt.studentUsername !== authorUsername) {
      const asker = await User.findOne({ username: doubt.studentUsername });
      if (asker) {
        if (!asker.notifications) asker.notifications = [];
        asker.notifications.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          type: 'doubt-reply', title: `${authorName || authorUsername} replied to your doubt`,
          body: `"${text.slice(0, 100)}${text.length > 100 ? '…' : ''}"`,
          courseId: req.params.courseId, link: `#/course/${req.params.courseId}`,
          read: false, createdAt: new Date()
        });
        if (asker.notifications.length > 50) asker.notifications = asker.notifications.slice(-50);
        await asker.save();
      }
    }
    cacheClear('courses:');
    res.json({ success: true, message: 'Reply posted!' });
  } catch (e) { res.status(500).json({ success: false, message: 'Error posting reply: ' + e.message }); }
});

app.put('/api/courses/:courseId/doubts/:doubtId/replies/:replyId/accept', async (req, res) => {
  try {
    const { acceptedBy } = req.body;
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });
    const doubt = course.doubts.id(req.params.doubtId);
    if (!doubt) return res.status(404).json({ success: false, message: 'Doubt not found' });
    const isAsker = doubt.studentUsername === acceptedBy;
    const acceptor = await User.findOne({ username: acceptedBy });
    const isAdmin = acceptor?.role === 'admin';
    if (!isAsker && !isAdmin) return res.status(403).json({ success: false, message: 'Only asker or admin can accept' });
    doubt.replies.forEach(r => { r.isAccepted = false; });
    const reply = doubt.replies.id(req.params.replyId);
    if (!reply) return res.status(404).json({ success: false, message: 'Reply not found' });
    reply.isAccepted = true;
    await course.save();
    cacheClear('courses:');
    res.json({ success: true, message: 'Answer accepted!' });
  } catch (e) { res.status(500).json({ success: false, message: 'Error: ' + e.message }); }
});
/* ============================================================
   QUIZ
   ============================================================ */
/* ============================================================
   QUIZ — Save paper (admin)
   ============================================================ */
app.post('/api/courses/:courseId/materials/:materialId/quiz', requireAdminAuth, async (req, res) => {
  try {
    const { quiz, examConfig } = req.body || {};
    if (!Array.isArray(quiz)) {
      return res.status(400).json({ success: false, message: 'quiz must be an array' });
    }

    const update = { 'materials.$.quiz': quiz };
    if (examConfig && typeof examConfig === 'object') {
      const P = 'materials.$.examConfig';
      update[P + '.subject']    = String(examConfig.subject    || '').slice(0, 200);
      update[P + '.paperCode']  = String(examConfig.paperCode  || '').slice(0, 100);
      update[P + '.totalTime']  = String(examConfig.totalTime  || '').slice(0, 60);
      update[P + '.totalMarks'] = Number(examConfig.totalMarks) || 0;

      /* Per-quiz navigation policy (unchanged) */
      update[P + '.allowBackNavigation'] = examConfig.allowBackNavigation === true;
      update[P + '.showQuestionPalette'] = examConfig.showQuestionPalette !== false;

      /* ⭐ NEW — Attempt limit.
         0 = unlimited (preserves the behaviour of every quiz that
         was created before this update). */
      const maxAttempts = Math.max(0, Math.min(99, parseInt(examConfig.maxAttempts, 10) || 0));
      update[P + '.maxAttempts'] = maxAttempts;

      /* ⭐ NEW — Scheduled result publication. */
      const validModes = ['immediate', 'scheduled', 'manual'];
      const mode = validModes.includes(examConfig.resultPublishMode)
        ? examConfig.resultPublishMode
        : 'immediate';
      update[P + '.resultPublishMode'] = mode;

      let publishAt = null;
      if (mode === 'scheduled' && examConfig.resultPublishAt) {
        const d = new Date(examConfig.resultPublishAt);
        if (!isNaN(d.getTime())) publishAt = d;
      }
      update[P + '.resultPublishAt'] = publishAt;

      const delayH = (mode === 'scheduled')
        ? Math.max(0, Math.min(8760, parseInt(examConfig.resultPublishDelayHours, 10) || 0))
        : 0;
      update[P + '.resultPublishDelayHours'] = delayH;

      /* ⚠️ `resultsPublished` / `resultsPublishedAt` are deliberately
         NOT touched here — they persist so re-saving a quiz that has
         already been released does not silently hide the scores
         students have already seen. Use the /publish-now endpoint
         (or the "Publish Now" button) to publish. */
    }

    const result = await Course.updateOne(
      { _id: req.params.courseId, 'materials._id': req.params.materialId },
      { $set: update }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Material not found.' });
    }
    cacheClear('courses:');
    res.json({ success: true, message: 'Paper saved successfully!' });
  } catch (e) {
    console.error('[quiz/save]', e);
    res.status(500).json({ success: false, message: 'Error saving paper: ' + e.message });
  }
});
/* ============================================================
   QUIZ — START SESSION  (server-synced timer + shuffle)
   ------------------------------------------------------------
   POST /api/user/quiz/:courseId/:materialId/start
   Body: { userId }

   Returns the CANONICAL session record for this student. If a
   session already exists and is still in progress, we return the
   SAME startedAt + durationSeconds + shuffle seed, so refreshing
   the page never resets the clock or re-rolls the order.

   If the previous session was already submitted / expired, the
   stale row is deleted so the UNIQUE index on
   (userId, courseId, materialId) does not block a fresh attempt.
   ============================================================ */
app.post('/api/user/quiz/:courseId/:materialId/start', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ success: false, message: 'userId required.' });

    const course = await Course.findById(req.params.courseId)
      .select('isPremium materials')
      .lean();
    if (!course) return res.status(404).json({ success: false, message: 'Course not found.' });

    const mat = (course.materials || []).find(
      m => String(m._id) === String(req.params.materialId)
    );
    if (!mat) return res.status(404).json({ success: false, message: 'Material not found.' });

    const quiz = Array.isArray(mat.quiz) ? mat.quiz : [];
    if (quiz.length === 0) {
      return res.status(400).json({ success: false, message: 'This test has no questions.' });
    }

    /* ============================================================
       ⭐ ATTEMPT-LIMIT ENFORCEMENT
       ------------------------------------------------------------
       Counts how many times this student has already SUBMITTED
       this particular material (from User.quizResults[materialId]
       .attempts) and compares it to the admin-configured cap.
       A submission that is still in progress does NOT count — the
       student can resume it freely without burning an attempt.
       ============================================================ */
    const cfg          = mat.examConfig || {};
    const maxAttempts  = Math.max(0, Number(cfg.maxAttempts) || 0);

    const student = await User.findById(userId).select('quizResults').lean();
    if (!student) return res.status(404).json({ success: false, message: 'User not found.' });

    const existingResult = (student.quizResults || {})[String(req.params.materialId)] || {};
    const attemptsUsed   = Number(existingResult.attempts) || 0;

    const publishMode   = cfg.resultPublishMode || 'immediate';
    const publishedAtMs = existingResult.publishedAt
      ? new Date(existingResult.publishedAt).getTime()
      : null;
    const resultsVisible =
      publishMode === 'immediate' ||
      (publishMode === 'scheduled' && publishedAtMs !== null);

    /* ============================================================
       ⭐ FIX: Look for ANY existing session for this (user, course,
       material) triple — not just in-progress ones.

       The old code only queried `status:'in-progress'`, so a
       previously SUBMITTED row stayed in the DB untouched. Because
       the schema has a UNIQUE index on (userId, courseId,
       materialId), the subsequent QuizSession.create(...) then blew
       up with E11000 duplicate key. The client silently fell into
       "offline" mode without a real server session, and any later
       submit was rejected by the stale submitted row with code
       ALREADY_SUBMITTED.
       ============================================================ */
    let session = await QuizSession.findOne({
      userId:     String(userId),
      courseId:   String(req.params.courseId),
      materialId: String(req.params.materialId)
    });

    const isResuming = !!(session && session.status === 'in-progress');

    /* Refuse a fresh attempt once the cap is reached, unless we are
       literally resuming an already-open in-progress session. */
    if (!isResuming && maxAttempts > 0 && attemptsUsed >= maxAttempts) {
      return res.status(403).json({
        success: false,
        code: 'ATTEMPT_LIMIT_REACHED',
        message:
          `You have used all ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'} ` +
          `for this test.` +
          (resultsVisible
            ? ' Your result is available above.'
            : ' Your result will be visible once the instructor publishes it.'),
        attemptsUsed,
        maxAttempts,
        resultsVisible,
        resultsPending: !resultsVisible
      });
    }

    if (isResuming) {
      /* Resume — keep the SAME startedAt / durationSeconds / shuffle
         seed so refreshing never resets the clock or re-rolls order. */
      session.lastHeartbeat = new Date();
      await session.save();
      console.log(`[quiz/start] ♻️  resumed session user=${userId} mat=${req.params.materialId}`);
    } else {
      /* Delete any stale (submitted / expired) row so the unique
         index does not block the fresh create below. */
      if (session) {
        await QuizSession.deleteOne({ _id: session._id });
        console.log(
          `[quiz/start] 🗑️  cleared stale session (status=${session.status}) ` +
          `user=${userId} mat=${req.params.materialId}`
        );
      }

      const settings        = await getGlobalSettings();
      const durationSeconds = parseQuizTimeServer(cfg.totalTime);

      const shuffleSeed = crypto
        .createHash('sha256')
        .update(
          String(userId) + ':' + String(req.params.materialId) + ':' +
          Date.now() + ':' + crypto.randomBytes(8).toString('hex')
        )
        .digest('hex')
        .slice(0, 32);

      const qCount = quiz.length;
      let questionOrder = Array.from({ length: qCount }, (_, i) => i);
      if (settings.examShuffleQuestions !== false) {
        questionOrder = seededShuffleArray(questionOrder, shuffleSeed + ':q');
      }

      const optionOrders = {};
      if (settings.examShuffleOptions !== false) {
        quiz.forEach((q, i) => {
          const n = Array.isArray(q.options) ? q.options.length : 0;
          if (n > 1 && (q.type === 'single' || q.type === 'multiple')) {
            optionOrders[i] = seededShuffleArray(
              Array.from({ length: n }, (_, k) => k),
              shuffleSeed + ':o:' + i
            );
          }
        });
      }

      session = await QuizSession.create({
        userId:     String(userId),
        courseId:   String(req.params.courseId),
        materialId: String(req.params.materialId),
        startedAt:  new Date(),
        durationSeconds,
        shuffleSeed,
        questionOrder,
        optionOrders,
        status: 'in-progress'
      });
      console.log(
        `[quiz/start] ✅ new session user=${userId} mat=${req.params.materialId} ` +
        `duration=${durationSeconds}s q=${qCount} attempt=${attemptsUsed + 1}/${maxAttempts || '∞'}`
      );
    }

    const now = Date.now();
    const endsAt = session.startedAt.getTime() + session.durationSeconds * 1000;
    const remainingSeconds = session.durationSeconds > 0
      ? Math.max(0, Math.floor((endsAt - now) / 1000))
      : null;

    /* Per-quiz navigation policy (unchanged) */
    let allowBackNavigation;
    if (typeof cfg.allowBackNavigation === 'boolean') {
      allowBackNavigation = cfg.allowBackNavigation;
    } else {
      try {
        const s = await getGlobalSettings();
        allowBackNavigation = s.examForwardOnly === false;
      } catch (e) {
        allowBackNavigation = false;
      }
    }
    const showQuestionPalette = cfg.showQuestionPalette !== false;

    res.json({
      success: true,
      serverNow: now,
      startedAt: session.startedAt.getTime(),
      durationSeconds: session.durationSeconds,
      remainingSeconds,
      shuffleSeed: session.shuffleSeed,
      questionOrder: session.questionOrder,
      optionOrders: session.optionOrders,
      questionCount: quiz.length,
      allowBackNavigation,
      showQuestionPalette,

      /* ⭐ Attempt + publication metadata for the UI */
      attemptsUsed,
      maxAttempts,
      attemptsRemaining: maxAttempts > 0
        ? Math.max(0, maxAttempts - attemptsUsed)
        : null,
      resultPublishMode: publishMode,
      resultsVisible,
      resultPublishAt: cfg.resultPublishAt || null
    });
  } catch (e) {
    console.error('[quiz/start]', e);
    res.status(500).json({ success: false, message: 'Could not start test: ' + e.message });
  }
});
/* ============================================================
   GET /api/user/quiz/:courseId/:materialId/attempt-status
   ------------------------------------------------------------
   Cheap, unauthenticated-beyond-userId probe used by the
   material card to render the correct button label and to
   short-circuit openQuizPlayer() when the cap is reached.
   ============================================================ */
app.get('/api/user/quiz/:courseId/:materialId/attempt-status', async (req, res) => {
  try {
    const userId = String(req.query.userId || '');
    if (!userId) return res.status(400).json({ success: false, message: 'userId required.' });

    const course = await Course.findById(req.params.courseId)
      .select('materials')
      .lean();
    if (!course) return res.status(404).json({ success: false, message: 'Course not found.' });

    const mat = (course.materials || []).find(
      m => String(m._id) === String(req.params.materialId)
    );
    if (!mat) return res.status(404).json({ success: false, message: 'Material not found.' });

    const cfg          = mat.examConfig || {};
    const maxAttempts  = Math.max(0, Number(cfg.maxAttempts) || 0);
    const publishMode  = cfg.resultPublishMode || 'immediate';

    const student = await User.findById(userId).select('quizResults').lean();
    if (!student) return res.status(404).json({ success: false, message: 'User not found.' });

    const r = (student.quizResults || {})[String(req.params.materialId)] || {};
    const attemptsUsed = Number(r.attempts) || 0;
    const publishedAt  = r.publishedAt || null;
    const publishedMs  = publishedAt ? new Date(publishedAt).getTime() : null;

    /* If the publish mode is 'scheduled' and the deadline has
       passed but the cron hasn't run yet (max 60 s lag), treat it
       as published anyway so the student never sees a stale
       "pending" state. */
    let resultsVisible = false;
    if (publishedMs) {
      resultsVisible = true;
    } else if (publishMode === 'immediate' && attemptsUsed > 0) {
      resultsVisible = true;
    } else if (publishMode === 'scheduled') {
      const absolute = cfg.resultPublishAt ? new Date(cfg.resultPublishAt).getTime() : null;
      if (absolute && Date.now() >= absolute && attemptsUsed > 0) {
        resultsVisible = true;
      } else if (!absolute && cfg.resultPublishDelayHours > 0 && attemptsUsed > 0) {
        /* Delay is per-student from lastAttemptAt. */
        const last = r.lastAttemptAt ? new Date(r.lastAttemptAt).getTime() : null;
        if (last && Date.now() >= last + cfg.resultPublishDelayHours * 3600 * 1000) {
          resultsVisible = true;
        }
      }
    }

    const attemptsRemaining = maxAttempts > 0
      ? Math.max(0, maxAttempts - attemptsUsed)
      : null;

    const canAttempt   = (maxAttempts === 0) || (attemptsUsed < maxAttempts);
    const hasSubmitted = attemptsUsed > 0;

    /* Small, single-word status the client can switch on. */
    let status;
    if (!hasSubmitted)                                    status = 'not-started';
    else if (resultsVisible)                              status = 'results-ready';
    else                                                  status = 'pending';
    if (!canAttempt && !resultsVisible)                   status = 'exhausted-pending';
    if (!canAttempt &&  resultsVisible)                   status = 'exhausted-ready';

    res.json({
      success: true,
      status,
      attemptsUsed,
      maxAttempts,
      attemptsRemaining,
      canAttempt,
      hasSubmitted,
      resultsVisible,
      resultPublishMode: publishMode,
      resultPublishAt: cfg.resultPublishAt || null,
      lastAttemptAt: r.lastAttemptAt || null,
      score: resultsVisible ? {
        autoMarks:  Number(r.marksEarned)   || 0,
        autoMax:    Number(r.marksPossible) || 0,
        subjMarks:  Number(r.subjectiveMarksAwarded) || 0,
        subjMax:    Number(r.subjectiveMaxTotal)     || 0,
        finalMarks: Number(r.finalMarksEarned) || null,
        finalMax:   Number(r.finalMarksPossible) || null,
        percent:    Number(r.finalPercent) || Number(r.percent) || 0,
        pendingEvaluation: !!r.pendingEvaluation
      } : null
    });
  } catch (e) {
    console.error('[quiz/attempt-status]', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

/* ============================================================
   QUIZ — HEARTBEAT  (drift-corrected countdown + server enforcement)
   ------------------------------------------------------------
   GET /api/user/quiz/:courseId/:materialId/heartbeat?userId=…

   The client polls this every 15 s. The server compares wall
   clock against the session's deadline and, if time is up and
   the session is still marked "in-progress", marks it expired.
   The client's next tick will see remainingSeconds <= 0 and
   submit — but even if the client never ticks, the server has
   already locked the deadline.
   ============================================================ */
app.get('/api/user/quiz/:courseId/:materialId/heartbeat', async (req, res) => {
  try {
    const userId = String(req.query.userId || '');
    if (!userId) return res.status(400).json({ success: false, message: 'userId required.' });

    const session = await QuizSession.findOne({
      userId,
      courseId: String(req.params.courseId),
      materialId: String(req.params.materialId)
    });
    if (!session) return res.status(404).json({ success: false, message: 'No active session.' });
    if (session.status !== 'in-progress') {
      return res.json({ success: true, expired: true, status: session.status, remainingSeconds: 0 });
    }

    session.lastHeartbeat = new Date();
    const now = Date.now();
    const endsAt = session.startedAt.getTime() + session.durationSeconds * 1000;
    const remainingSeconds = session.durationSeconds > 0
      ? Math.max(0, Math.floor((endsAt - now) / 1000))
      : null;

    let expired = false;
    if (session.durationSeconds > 0 && remainingSeconds === 0) {
      session.status = 'expired';
      expired = true;
    }
    await session.save();

    res.json({
      success: true,
      serverNow: now,
      endsAt,
      remainingSeconds,
      expired,
      status: session.status
    });
  } catch (e) {
    console.error('[quiz/heartbeat]', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ============================================================
   QUIZ — RESET SESSION  (fresh attempt on retake)
   ------------------------------------------------------------
   POST /api/user/quiz/:courseId/:materialId/reset
   Body: { userId }

   Deletes the current session row so /start creates a new one
   with a new timer and a new shuffle seed. Called by Retake.
   ============================================================ */
app.post('/api/user/quiz/:courseId/:materialId/reset', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ success: false, message: 'userId required.' });

    const result = await QuizSession.deleteOne({
      userId: String(userId),
      courseId: String(req.params.courseId),
      materialId: String(req.params.materialId)
    });
    console.log(
      `[quiz/reset] user=${userId} mat=${req.params.materialId} ` +
      `removed=${result.deletedCount}`
    );
    res.json({ success: true, removed: result.deletedCount || 0 });
  } catch (e) {
    console.error('[quiz/reset]', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ============================================================
   QUIZ — Grade submission (student)
   Supports: single, multiple, integer, matrix
   ============================================================ */
app.post('/api/user/quiz/:courseId/:materialId', async (req, res) => {
  try {
    const { userId, answers, timeSpentPerQuestion, autoSubmitted } = req.body || {};
    if (!userId) return res.status(400).json({ success: false, message: 'userId required' });
    if (!Array.isArray(answers)) {
      return res.status(400).json({ success: false, message: 'answers must be an array' });
    }

    /* ---- Server-side deadline enforcement ----
       Load the session (if one exists) and refuse submissions that
       arrived after the server-recorded deadline + grace. This
       catches the case where a student disables JS, edits the
       client clock, or replays a stale request. */
    let _session = null;
    try {
      _session = await QuizSession.findOne({
        userId: String(userId),
        courseId: String(req.params.courseId),
        materialId: String(req.params.materialId)
      });
    } catch (_) { /* non-fatal — session may not exist for legacy flows */ }

    if (_session && _session.status === 'submitted') {
      return res.status(409).json({
        success: false,
        code: 'ALREADY_SUBMITTED',
        message: 'This test has already been submitted.'
      });
    }

    if (_session && _session.durationSeconds > 0) {
      let graceSec = 30;
      try {
        const _gs = await getGlobalSettings();
        graceSec = Number(_gs.examServerTimerGraceSec) || 30;
      } catch (_) {}
      const endsAt = _session.startedAt.getTime() + _session.durationSeconds * 1000;
      const overdueMs = Date.now() - endsAt;
      if (overdueMs > graceSec * 1000) {
        _session.status = 'expired';
        _session.autoSubmitted = true;
        _session.submittedAt = new Date();
        try { await _session.save(); } catch (_) {}
        console.warn(
          `[quiz/submit] ⏰ rejected late submission user=${userId} overdue=${Math.round(overdueMs/1000)}s`
        );
        return res.status(410).json({
          success: false,
          code: 'TIME_EXPIRED',
          message: 'Your attempt has expired. Answers must be submitted before the deadline.'
        });
      }
    }

    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });
    const mat = course.materials.id(req.params.materialId);
    if (!mat) return res.status(404).json({ success: false, message: 'Material not found' });

    const quiz = mat.quiz || [];
    if (quiz.length === 0) return res.status(400).json({ success: false, message: 'This material has no questions' });

    let score = 0;                    // auto-graded correct count (excludes subjective)
    let totalMarksPossible = 0;       // marks from AUTO-GRADED questions only
    let marksEarned = 0;              // auto-graded marks
    let autoGradedCount = 0;          // number of questions that CAN be auto-graded
    let subjectiveMaxTotal = 0;       // max marks from subjective questions
    let subjectiveCount = 0;          // number of subjective questions
    const subjectiveAnswers = {};     // { "<qi>": [{ url, fileName }] }
    const subjectiveQuestionMeta = {};// { "<qi>": { maxMarks, instructions } }

    const results = quiz.map((q, i) => {
      const ans = answers[i];
      const qType = q.type || 'single';
      const qMarks = typeof q.marks === 'number' ? q.marks : 4;
      const qNeg   = typeof q.negativeMarks === 'number' ? q.negativeMarks : -1;

      // ─── SUBJECTIVE: never auto-graded ───
      if (qType === 'subjective') {
        const subMax = Number(q.subjectiveMaxMarks) || qMarks || 10;
        subjectiveMaxTotal += subMax;
        subjectiveCount++;
        subjectiveAnswers[i] = Array.isArray(ans) ? ans.filter(x => x && x.url) : [];
        subjectiveQuestionMeta[i] = {
          maxMarks: subMax,
          instructions: q.subjectiveInstructions || ''
        };

        return {
          type: 'subjective',
          correct: false,
          manualReview: true,
          chosen: subjectiveAnswers[i],
          maxMarks: subMax,
          instructions: q.subjectiveInstructions || '',
          explanation: q.explanation || '',
          marks: qMarks,
          negativeMarks: 0
        };
      }

      // ─── All other types can be auto-graded ───
      autoGradedCount++;
      totalMarksPossible += qMarks;

      let correct = false;

      if (qType === 'single') {
        const chosen = Array.isArray(ans) ? ans[0] : ans;
        const correctIdx = (q.correctIndexes && q.correctIndexes[0] != null)
          ? q.correctIndexes[0]
          : (typeof q.correctIndex === 'number' ? q.correctIndex : 0);
        correct = (chosen === correctIdx);
      }
      else if (qType === 'multiple') {
        const chosen = Array.isArray(ans) ? [...ans].map(Number).sort() : [];
        const expected = [...(q.correctIndexes || [])].map(Number).sort();
        correct = chosen.length === expected.length &&
                  chosen.every((v, k) => v === expected[k]);
      }
      else if (qType === 'integer') {
        const chosen = Number(ans);
        const expected = Number(q.integerAnswer);
        const tol = Number(q.integerTolerance) || 0;
        correct = !isNaN(chosen) && !isNaN(expected) && Math.abs(chosen - expected) <= tol;
      }
      else if (qType === 'numerical') {
        // ⭐ NEW: answer accepted if rangeMin ≤ answer ≤ rangeMax
        const chosen = Number(ans);
        const min = Number(q.rangeMin);
        const max = Number(q.rangeMax);
        correct = !isNaN(chosen) && !isNaN(min) && !isNaN(max) &&
                  chosen >= min && chosen <= max;
      }
           else if (qType === 'matrix') {
        const chosen = Array.isArray(ans) ? ans : [];
        const rows = q.matrixRows || [];
        if (rows.length === 0) correct = false;
        else {
          let hits = 0;
          rows.forEach((row, ri) => {
            const val = chosen[ri];
            /* ⚠️ A missing row serialises as null over JSON.
               Number(null) === 0, so without this guard a blank row
               would be counted as correct whenever the true answer is
               index 0. Reject null/undefined/empty outright. */
            if (val === null || val === undefined || val === '') return;
            if (Number(val) === Number(row.correctIndex)) hits++;
          });
          correct = (hits === rows.length);
        }
      }

      if (correct) {
        score++;
        marksEarned += qMarks;
      } else {
        const attempted =
          (qType === 'integer' || qType === 'numerical')
            ? (ans !== null && ans !== undefined && ans !== '' && !isNaN(Number(ans)))
            : (Array.isArray(ans) ? ans.filter(x => x !== undefined && x !== null && x !== '').length > 0
                                 : (ans !== null && ans !== undefined && ans !== -1));
        if (attempted && qNeg < 0) marksEarned += qNeg;
      }

      return {
        type: qType,
        correct,
        chosen: ans,
        correctIndexes: q.correctIndexes || (typeof q.correctIndex === 'number' ? [q.correctIndex] : []),
        integerAnswer: q.integerAnswer,
        integerTolerance: q.integerTolerance || 0,
        rangeMin: q.rangeMin,
        rangeMax: q.rangeMax,
        matrixRows: q.matrixRows || [],
        explanation: q.explanation || '',
        marks: qMarks,
        negativeMarks: qNeg
      };
    });

    // Auto-graded score is out of autoGradedCount.
    // If there are subjective questions, they will be added later by admin.
    const total = autoGradedCount;                    // legacy field name
    const pct = autoGradedCount > 0 ? Math.round((score / autoGradedCount) * 100) : 0;
    const normalizedMarks = totalMarksPossible > 0
      ? Math.max(0, Math.round(marksEarned * 100) / 100)
      : 0;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!user.quizResults) user.quizResults = new Map();
    const prev = user.quizResults.get(req.params.materialId) || { attempts: 0 };

    user.quizResults.set(req.params.materialId, {
      score,                                  // auto-graded correct count
      total: autoGradedCount,                 // auto-graded total
      percent: pct,
      marksEarned: normalizedMarks,           // auto-graded marks
      marksPossible: totalMarksPossible,      // auto-graded max marks
      attempts: (prev.attempts || 0) + 1,
      lastAttemptAt: new Date(),

      // ⭐ NEW: subjective tracking
      subjectiveAnswers,
      subjectiveQuestionMeta,
      subjectiveMaxTotal,
      subjectiveCount,
      subjectiveEvaluations: prev.subjectiveEvaluations || {},
      pendingEvaluation: subjectiveCount > 0,
      manuallyEvaluated: false
    });

    logActivity(user, {
      type: 'quiz',
      courseId: req.params.courseId,
      materialId: req.params.materialId,
      score, total: autoGradedCount
    });

    // ⭐ Award XP for the quiz attempt
    const baseXP = 25;
    const accuracyBonus = autoGradedCount > 0
      ? Math.round((score / autoGradedCount) * 25)
      : 0;
    const perfectBonus = (score === autoGradedCount && autoGradedCount > 0) ? 50 : 0;
    const totalXP = baseXP + accuracyBonus + perfectBonus;
    const xpResult = awardXP(user, totalXP, 'quiz-complete');

    await user.save();

    /* ============================================================
       ⭐ RESULT-PUBLICATION GATE
       ------------------------------------------------------------
       • 'immediate' → existing behaviour; score is returned now.
       • 'scheduled' → hide the score until the admin-configured
                       time (or per-student delay) is reached.
       • 'manual'    → hide the score until the admin clicks
                       "Publish Now".
       In all three modes the score is stored in the DB immediately
       so nothing is lost — only the response is filtered.
       ============================================================ */
    const cfg            = mat.examConfig || {};
    const publishMode    = cfg.resultPublishMode || 'immediate';
    const publishAtMs    = cfg.resultPublishAt ? new Date(cfg.resultPublishAt).getTime() : null;
    const delayHours     = Math.max(0, Number(cfg.resultPublishDelayHours) || 0);
    const delayMs        = delayHours * 3600 * 1000;
    const submittedAtMs  = Date.now();

    let resultsVisible = false;
    let publishAtForThis = null;      // absolute epoch ms when this student will see the score

    if (publishMode === 'immediate') {
      resultsVisible = true;
    } else if (publishMode === 'scheduled') {
      if (publishAtMs) {
        // Absolute deadline wins over the per-student delay
        publishAtForThis = publishAtMs;
        resultsVisible   = submittedAtMs >= publishAtMs;
      } else if (delayMs > 0) {
        publishAtForThis = submittedAtMs + delayMs;
        resultsVisible   = false;    // never visible on submit for a delayed release
      } else {
        // scheduled but no time configured → fall back to manual
        resultsVisible = false;
      }
    } else {
      // 'manual' → hidden until admin publishes
      resultsVisible = false;
    }

    /* If the result IS visible right now, stamp publishedAt so the
       rest of the system (student material card, "View Result"
       button, etc.) sees a consistent state. */
    if (resultsVisible) {
      try {
        await User.updateOne(
          { _id: user._id },
          {
            $set: {
              [`quizResults.${req.params.materialId}.publishedAt`]:        new Date(submittedAtMs),
              [`quizResults.${req.params.materialId}.manuallyEvaluated`]:  true,
              [`quizResults.${req.params.materialId}.finalMarksEarned`]:   normalizedMarks,
              [`quizResults.${req.params.materialId}.finalMarksPossible`]: totalMarksPossible,
              [`quizResults.${req.params.materialId}.finalPercent`]:       pct
            }
          }
        );
      } catch (e) { /* silent */ }
    }

    /* Non-blocking: bump today's quiz counters */
    DailyUsage.updateOne(
      { userId: String(user._id), date: istDateKey() },
      {
        $inc: { quizzesTaken: 1, quizzesCompleted: 1 },
        $setOnInsert: {
          username: user.username || '',
          fullName: user.fullName || '',
          firstSeenAt: new Date()
        }
      },
      { upsert: true }
    ).catch(() => {});

    /* ---- Persist per-question time analytics + close the session ---- */
    if (_session) {
      try {
        if (timeSpentPerQuestion && typeof timeSpentPerQuestion === 'object') {
          _session.timeSpentPerQuestion = timeSpentPerQuestion;
        }
        _session.status = 'submitted';
        _session.submittedAt = new Date();
        if (autoSubmitted === true) _session.autoSubmitted = true;
        await _session.save();
      } catch (sessErr) {
        console.warn('[quiz/submit] session close failed:', sessErr.message);
      }
    }

    /* ---- Store per-question time on the result record too ---- */
    if (timeSpentPerQuestion && typeof timeSpentPerQuestion === 'object') {
      try {
        const r = user.quizResults.get(String(req.params.materialId));
        if (r) {
          r.timeSpentPerQuestion = timeSpentPerQuestion;
          r.timeSpentTotalSeconds = Object.values(timeSpentPerQuestion)
            .reduce((s, v) => s + (Number(v) || 0), 0);
          user.quizResults.set(String(req.params.materialId), r);
          await user.save();
        }
      } catch (tErr) {
        console.warn('[quiz/submit] time analytics persist failed:', tErr.message);
      }
    }

    /* ============================================================
       Response — different shape depending on publication state.
       Every key from the previous version is preserved when the
       result is visible; a small, additive `pendingPublication`
       block is returned when it isn't.
       ============================================================ */
    const baseMeta = {
      attempts:          (prev.attempts || 0) + 1,
      attemptsUsed:      (prev.attempts || 0) + 1,
      maxAttempts:       Math.max(0, Number(cfg.maxAttempts) || 0),
      resultPublishMode: publishMode,
      resultPublishAt:   publishAtForThis ? new Date(publishAtForThis).toISOString() : null,
      resultsVisible
    };

    if (!resultsVisible) {
      /* Score is hidden. Send enough info for the UI to render an
         informative "Results Pending" card, but no numbers. */
      return res.json({
        success: true,
        pendingPublication: true,
        pendingEvaluation: subjectiveCount > 0 && !resultsVisible,
        subjectiveCount,
        subjectiveMaxTotal,
        ...baseMeta,
        message: publishMode === 'manual'
          ? 'Your answers are recorded. Your instructor will publish the results shortly.'
          : publishAtForThis
            ? 'Your answers are recorded. Results will be published on the scheduled date.'
            : 'Your answers are recorded. Results will be published soon.'
      });
    }

    res.json({
      success: true,
      score,
      total: autoGradedCount,
      percent: pct,
      marksEarned: normalizedMarks,
      marksPossible: totalMarksPossible,
      results,
      attempts: (prev.attempts || 0) + 1,

      subjectiveCount,
      subjectiveMaxTotal,
      pendingEvaluation: subjectiveCount > 0,

      xp: user.xp || 0,
      level: user.level || 1,
      levelInfo: computeLevel(user.xp || 0),
      xpResult,

      ...baseMeta
    });
  } catch (e) {
    console.error('[quiz/grade]', e);
    res.status(500).json({ success: false, message: 'Error grading quiz: ' + e.message });
  }
});
/* ============================================================
   ADMIN — Evaluate a Subjective Answer
   ------------------------------------------------------------
   Admin awards marks for one subjective question of one student.
   Recomputes total marks and marks the submission as evaluated
   when all subjective questions have been graded.
   ============================================================ */
app.post('/api/admin/quiz/evaluate-subjective', requireAdminAuth, async (req, res) => {
  try {
    const { userId, materialId, questionIndex, awardedMarks, feedback } = req.body || {};

    if (!userId || materialId === undefined || questionIndex === undefined) {
      return res.status(400).json({
        success: false,
        message: 'userId, materialId and questionIndex are required.'
      });
    }

    const marks = Number(awardedMarks);
    if (isNaN(marks) || marks < 0) {
      return res.status(400).json({ success: false, message: 'Invalid marks value.' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (!user.quizResults) user.quizResults = new Map();
    const result = user.quizResults.get(String(materialId));
    if (!result) {
      return res.status(404).json({ success: false, message: 'No quiz result found for this material.' });
    }

    const meta = (result.subjectiveQuestionMeta || {})[questionIndex];
    const maxAllowed = meta ? Number(meta.maxMarks) : 100;
    if (marks > maxAllowed) {
      return res.status(400).json({
        success: false,
        message: `Marks cannot exceed ${maxAllowed} for this question.`
      });
    }

    if (!result.subjectiveEvaluations) result.subjectiveEvaluations = {};
    result.subjectiveEvaluations[questionIndex] = {
      awardedMarks: marks,
      feedback: String(feedback || '').slice(0, 500),
      evaluatedAt: new Date(),
      evaluatedBy: String(req.adminUser._id)
    };

    // Recompute total subjective marks awarded
    let subjectiveMarksAwarded = 0;
    Object.values(result.subjectiveEvaluations).forEach(ev => {
      subjectiveMarksAwarded += Number(ev.awardedMarks) || 0;
    });
    result.subjectiveMarksAwarded = subjectiveMarksAwarded;

    // If all subjective questions have been graded → mark as fully evaluated
    const totalSubjective = Object.keys(result.subjectiveQuestionMeta || {}).length;
    const gradedSubjective = Object.keys(result.subjectiveEvaluations).length;
    result.pendingEvaluation = gradedSubjective < totalSubjective;
    result.manuallyEvaluated = gradedSubjective >= totalSubjective;
    result.evaluatedAt = new Date();

    // Final marks = auto-graded marks + subjective marks awarded
    result.finalMarksEarned = (Number(result.marksEarned) || 0) + subjectiveMarksAwarded;
    result.finalMarksPossible = (Number(result.marksPossible) || 0) +
                                (Number(result.subjectiveMaxTotal) || 0);

    user.quizResults.set(String(materialId), result);
    await user.save();

    console.log(`[admin/quiz/evaluate] ✅ user=${user.username} material=${materialId} Q${questionIndex} → ${marks} marks`);

    res.json({
      success: true,
      message: 'Marks awarded successfully.',
      result
    });
  } catch (e) {
    console.error('[admin/quiz/evaluate-subjective]', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

/* ============================================================
   ADMIN — List Pending Subjective Evaluations
   ------------------------------------------------------------
   Returns a list of every quiz submission that has ungraded
   subjective answers, so the admin can work through them.
   ============================================================ */
app.get('/api/admin/quiz/pending-subjective', requireAdminAuth, async (req, res) => {
  try {
    const users = await User.find({
      $or: [
        { 'quizResults.pendingEvaluation': true },
        { 'quizResults.subjectiveAnswers': { $exists: true, $ne: {} } }
      ]
    })
    .select('username fullName email quizResults')
    .lean();

    const rows = [];
    users.forEach(u => {
      const results = u.quizResults || {};
      Object.entries(results).forEach(([materialId, r]) => {
        if (!r || !r.subjectiveAnswers) return;
        const totalSubj = Object.keys(r.subjectiveQuestionMeta || {}).length;
        const gradedSubj = Object.keys(r.subjectiveEvaluations || {}).length;
        if (totalSubj === 0) return;             // nothing to grade
        if (gradedSubj >= totalSubj) return;     // already done

        rows.push({
          userId: u._id,
          username: u.username,
          fullName: u.fullName || '',
          email: u.email || '',
          materialId,
          attempts: r.attempts || 1,
          lastAttemptAt: r.lastAttemptAt,
          subjectiveMaxTotal: r.subjectiveMaxTotal || 0,
          subjectiveMarksAwarded: r.subjectiveMarksAwarded || 0,
          pendingCount: totalSubj - gradedSubj,
          totalSubjective: totalSubj,
          subjectiveAnswers: r.subjectiveAnswers,
          subjectiveQuestionMeta: r.subjectiveQuestionMeta,
          subjectiveEvaluations: r.subjectiveEvaluations || {}
        });
      });
    });

    rows.sort((a, b) => new Date(b.lastAttemptAt || 0) - new Date(a.lastAttemptAt || 0));

    res.json({ success: true, pending: rows });
  } catch (e) {
    console.error('[admin/quiz/pending-subjective]', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});


app.get('/api/user/quiz-results/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('quizResults').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, results: Object.fromEntries(user.quizResults || new Map()) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ============================================================
   ANALYTICS
   ============================================================ */
app.get('/api/user/analytics/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('-password').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    /* ---- SAFE Map/Plain-Object → Plain Object converter ----
       Why: `.lean()` returns Mongoose Map fields as plain objects,
       not Maps. `Object.fromEntries(plainObject)` throws
       "object is not iterable". This helper handles BOTH cases. */
    const toPlain = (v) => {
      if (!v) return {};
      if (v instanceof Map) return Object.fromEntries(v);
      if (typeof v === 'object' && !Array.isArray(v)) return v;
      return {};
    };

    const log = Array.isArray(user.activityLog) ? user.activityLog : [];
    const progressMap = toPlain(user.progress);
    const quizResults = toPlain(user.quizResults);

    const uniqueDays = new Set(log.map(a => a.date));
    const totalViews = log.filter(a => a.type === 'view').length;
    const totalQuizzes = log.filter(a => a.type === 'quiz').length;

    const quizScores = Object.values(quizResults)
      .filter(q => q && typeof q.score === 'number' && typeof q.total === 'number' && q.total > 0)
      .map(q => (q.score / q.total) * 100);
    const avgQuizScore = quizScores.length
      ? Math.round(quizScores.reduce((s, v) => s + v, 0) / quizScores.length)
      : 0;

    const totalMaterialsCompleted = Object.values(progressMap)
      .reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);

    const joinedDaysAgo = user.createdAt
      ? Math.max(1, Math.round((Date.now() - new Date(user.createdAt).getTime()) / 86400000))
      : 0;

    const summary = {
      studyDays: uniqueDays.size,
      totalViews,
      totalQuizzes,
      totalMaterialsCompleted,
      avgQuizScore,
      currentStreak: user.streakCount || 0,
      longestStreak: user.longestStreak || 0,
      joinedDaysAgo
    };

    const dailyCounts = {};
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 365);
    const cutoffStr = toDateKey(cutoff);
    log.forEach(a => {
      if (a.date && a.date >= cutoffStr) {
        dailyCounts[a.date] = (dailyCounts[a.date] || 0) + 1;
      }
    });
    const heatmap = Object.entries(dailyCounts).map(([date, count]) => ({ date, count }));

    const weekly = [];
    const now = new Date();
    for (let w = 11; w >= 0; w--) {
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      end.setDate(end.getDate() - (w * 7));
      const start = new Date(end);
      start.setDate(start.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      const startStr = toDateKey(start);
      const endStr = toDateKey(end);
      const inWeek = log.filter(a => a.date >= startStr && a.date <= endStr);
      weekly.push({
        label: start.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }),
        views: inWeek.filter(a => a.type === 'view').length,
        quizzes: inWeek.filter(a => a.type === 'quiz').length
      });
    }

    const quizLog = log
      .filter(a => a.type === 'quiz' && typeof a.score === 'number' && typeof a.total === 'number' && a.total > 0)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      .slice(-20);
    const quizTrend = quizLog.map(a => ({
      date: a.date,
      percent: Math.round((a.score / a.total) * 100),
      score: a.score,
      total: a.total
    }));

    const interactedCourseIds = new Set();
    Object.keys(progressMap).forEach(cid => {
      if ((progressMap[cid] || []).length > 0) interactedCourseIds.add(cid);
    });
    log.forEach(a => { if (a.courseId) interactedCourseIds.add(a.courseId); });

    const courseProgress = [];
    if (interactedCourseIds.size > 0) {
      const courses = await Course.find({ _id: { $in: Array.from(interactedCourseIds) } })
        .select('name code materials')
        .lean();
      courses.forEach(c => {
        const cid = c._id.toString();
        const completed = (progressMap[cid] || []).length;
        const total = (c.materials || []).length;
        if (total > 0) {
          courseProgress.push({
            courseId: cid,
            courseName: c.name,
            courseCode: c.code || '',
            completed,
            total,
            percent: Math.round((completed / total) * 100)
          });
        }
      });
      courseProgress.sort((a, b) => b.percent - a.percent);
    }

    res.json({
      success: true,
      analytics: { summary, heatmap, weekly, quizTrend, courseProgress }
    });
  } catch (e) {
    console.error('Analytics error:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

/* ============================================================
   PAYMENTS
   ============================================================ */
/* ============================================================
   RAZORPAY — lazily-initialised client with clear diagnostics
   ------------------------------------------------------------
   WHY THIS EXISTS:
     • The old code built the Razorpay client at module load.
       If env vars were missing, it silently created a broken
       client, and every payment call failed with a cryptic
       "401 Unauthorized" buried deep inside the flow.
     • Now, if keys are missing we throw a HUMAN-READABLE error
       the moment Razorpay is actually touched.
     • Keys are validated for the correct rzp_test_/rzp_live_
       prefix so you catch mix-ups immediately.
     • The client auto-rebuilds if you rotate keys at runtime.
   ============================================================ */
let _razorpayClient = null;
let _razorpayKeyUsed = null;

function getRazorpay() {
  const keyId     = (process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();

  if (!keyId || !keySecret) {
    const missing = [];
    if (!keyId)     missing.push('RAZORPAY_KEY_ID');
    if (!keySecret) missing.push('RAZORPAY_KEY_SECRET');
    throw new Error(
      'Razorpay is not configured. Missing environment variable(s): ' +
      missing.join(', ') +
      '. Add them in your hosting dashboard (Render → Environment) and redeploy.'
    );
  }

  if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId)) {
    console.warn(
      '[razorpay] ⚠️  RAZORPAY_KEY_ID has an unexpected format. ' +
      'Expected "rzp_test_…" or "rzp_live_…". Got: ' + keyId.slice(0, 14) + '…'
    );
  }
  if (keyId.length < 20 || keySecret.length < 20) {
    console.warn(
      '[razorpay] ⚠️  Key length looks suspicious. Double-check you copied ' +
      'the FULL Key Secret (it is only shown once).'
    );
  }

  if (_razorpayClient && _razorpayKeyUsed === keyId) {
    return _razorpayClient;
  }

  _razorpayClient = new Razorpay({
    key_id:     keyId,
    key_secret: keySecret
  });
  _razorpayKeyUsed = keyId;

  console.log(
    '[razorpay] ✅ Client ready · mode: ' +
    (keyId.startsWith('rzp_live_') ? 'LIVE 💰' : 'TEST 🧪') +
    ' · key: ' + keyId.slice(0, 12) + '…'
  );
  return _razorpayClient;
}

/* Drop-in replacement so existing `razorpay.orders.create(...)` calls
   keep working without touching every route. */
const razorpay = {
  get orders()        { return getRazorpay().orders; },
  get subscriptions() { return getRazorpay().subscriptions; },
  get plans()         { return getRazorpay().plans; },
  get payments()      { return getRazorpay().payments; },
  get refunds()       { return getRazorpay().refunds; }
};

/* Boot-time sanity log (non-fatal — just so you SEE the state) */
(function logRazorpayBootState() {
  const kid = (process.env.RAZORPAY_KEY_ID || '').trim();
  const ksec = (process.env.RAZORPAY_KEY_SECRET || '').trim();
  const whsec = (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
  if (!kid || !ksec) {
    console.error('❌ Razorpay NOT configured — payments will fail.');
    console.error('   Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in your env.');
  } else {
    console.log('✅ Razorpay env loaded · mode:', kid.startsWith('rzp_live_') ? 'LIVE' : 'TEST');
  }
  if (!whsec) {
    console.warn('⚠️  RAZORPAY_WEBHOOK_SECRET missing — webhook will reject all events.');
  }
})();

/* ============================================================
   CREATE RAZORPAY ORDER — SECURE VERSION
   ============================================================ */
app.post('/api/create-order', async (req, res) => {
  try {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      console.error('[create-order] ❌ Razorpay keys missing from env');
      return res.status(500).json({
        success: false,
        message: 'Payment gateway is not configured. Please contact support.'
      });
    }

    const { amount, userId, itemId } = req.body || {};

    if (!userId || !itemId) {
      return res.status(400).json({
        success: false,
        message: 'Missing user or item information.'
      });
    }

    const amountRupees = Number(amount);
    if (!Number.isFinite(amountRupees) || amountRupees <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount. Please refresh the page and try again.'
      });
    }

    let itemName = 'Item';
    let expectedPrice = 0;

    const course = await Course.findById(itemId)
      .select('name price isPremium materials')
      .lean();

    if (course) {
      itemName = course.name;
      expectedPrice = Number(course.price) || 0;
    } else {
      const parent = await Course.findOne({ 'materials._id': itemId })
        .select('name materials')
        .lean();

      if (parent) {
        const mat = (parent.materials || []).find(m => String(m._id) === String(itemId));
        if (mat) {
          itemName = mat.title;
          expectedPrice = Number(mat.price) || 0;
        }
      }
    }

    if (expectedPrice <= 0) {
      return res.status(400).json({
        success: false,
        message: 'This item does not require payment.'
      });
    }

    if (Math.abs(expectedPrice - amountRupees) > 0.01) {
      console.warn('[create-order] ⚠️ Price mismatch', { sent: amountRupees, expected: expectedPrice, itemId });
      return res.status(400).json({
        success: false,
        message: 'Price mismatch. Please refresh and try again.'
      });
    }

    const buyer = await User.findById(userId).select('purchases').lean();
    if (buyer && Array.isArray(buyer.purchases) && buyer.purchases.includes(String(itemId))) {
      return res.status(400).json({
        success: false,
        message: 'You already own this item.'
      });
    }

    const amountPaise = Math.round(amountRupees * 100);
    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: 'aero_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      notes: {
        userId:   String(userId),
        itemId:   String(itemId),
        itemName: String(itemName).slice(0, 120),
        purpose:  'course-purchase'
      }
    });

    console.log(`[create-order] ✅ ${order.id} · ₹${amountRupees} · user=${userId} · item=${itemId}`);

    res.json({
      success: true,
      key_id: process.env.RAZORPAY_KEY_ID,
      order: {
        id:       order.id,
        amount:   order.amount,
        currency: order.currency
      }
    });

  } catch (e) {
    console.error('[create-order] ❌', e);
    const friendly = (e && e.error && e.error.description)
      ? e.error.description
      : (e.message || 'Could not create order.');
    res.status(500).json({ success: false, message: friendly });
  }
});
/* ============================================================
   SUBSCRIPTION — SETTINGS + CHECKOUT + MANAGEMENT
   ============================================================ */

/* ---- Public: read current subscription plan info ---- */
app.get('/api/settings/subscription', async (req, res) => {
  try {
    const cached = cacheGet('settings:subscription');
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Cache-Control', 'public, max-age=120');
      return res.json(cached);
    }
    const s = await getGlobalSettings();
    const payload = {
      success: true,
      settings: {
        enabled:     s.subscriptionEnabled,
        amount:      s.subscriptionAmount,
        title:       s.subscriptionTitle,
        description: s.subscriptionDesc
      },
      exam: {
        maxStrikes:       Number(s.examMaxStrikes) || 3,
        forwardOnly:      s.examForwardOnly !== false,
        shuffleQuestions: s.examShuffleQuestions !== false,
        shuffleOptions:   s.examShuffleOptions !== false,
        serverTimerGraceSec: Number(s.examServerTimerGraceSec) || 30
      }
    };
    cacheSet('settings:subscription', payload, 5 * 60 * 1000);
    res.setHeader('Cache-Control', 'public, max-age=120');
    res.json(payload);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ============================================================
   ORGANIZATION / OWNER PROFILE — public read + admin edit
   ============================================================ */
app.get('/api/settings/owner', async (req, res) => {
  try {
    // Browser must NEVER cache this — hide/show toggles need to reach
    // students instantly. The server-side in-memory cache below still
    // protects MongoDB from repeated reads.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const cached = cacheGet('settings:owner');
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }

    const s = await getGlobalSettings();
    const op = (s.ownerProfile && typeof s.ownerProfile === 'object')
      ? s.ownerProfile
      : (typeof s.toObject === 'function'
          ? (s.toObject().ownerProfile || {})
          : {});

    const payload = {
      success: true,
      owner: {
        name:    op.name  || 'Krish Yadav',
        title:   op.title || 'Founder & Course Director',
        role:    op.role  || 'Founder',
        bio:     op.bio   || '',
        email:   op.email || '',
        phone:   op.phone || '',
        photo:   op.photo || '',
        visible: op.visible !== false
      }
    };

    cacheSet('settings:owner', payload, 5 * 60 * 1000);
    res.setHeader('X-Cache', 'MISS');
    res.json(payload);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.put('/api/admin/settings/owner', requireAdminAuth, async (req, res) => {
  try {
    const { name, title, role, bio, email, phone, photo, visible } = req.body || {};

    const s = await getGlobalSettings();
    if (!s.ownerProfile) s.ownerProfile = {};

    if (typeof name  === 'string')  s.ownerProfile.name  = name.trim().slice(0, 80);
    if (typeof title === 'string')  s.ownerProfile.title = title.trim().slice(0, 120);
    if (typeof role  === 'string')  s.ownerProfile.role  = role.trim().slice(0, 60);
    if (typeof bio   === 'string')  s.ownerProfile.bio   = bio.trim().slice(0, 2000);
    if (typeof email === 'string')  s.ownerProfile.email = email.trim().slice(0, 200);
    if (typeof phone === 'string')  s.ownerProfile.phone = phone.trim().slice(0, 40);
    if (typeof photo === 'string')  s.ownerProfile.photo = photo; // base64 or ''
    if (typeof visible === 'boolean') s.ownerProfile.visible = visible;  // ⭐ NEW
    s.ownerProfile.updatedAt = new Date();
    s.updatedAt = new Date();

    await s.save();
    cacheClear('settings:');
    invalidateGlobalSettingsCache();

    res.json({
      success: true,
      message: 'Organization profile updated.',
      owner: s.ownerProfile
    });
  } catch (e) {
    console.error('[admin/settings/owner]', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

/* ============================================================
   CONTACT TEAM MEMBER — spam-protected internal relay
   ------------------------------------------------------------
   Students fill a form; the backend emails the team member with
   a reply-to set to the student. Raw emails are never exposed.
   ============================================================ */
const contactTeamLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many messages. Please wait 10 minutes.' }
});

app.post('/api/contact/team', contactTeamLimiter, async (req, res) => {
  try {
    const { toEmail, toName, fromName, fromEmail, subject, message } = req.body || {};

    // ---- Validation ----
    if (!toEmail || !fromEmail || !fromName || !subject || !message) {
      return res.status(400).json({ success: false, message: 'All fields are required.' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(String(fromEmail))) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }
    const cleanSubject = String(subject).trim().slice(0, 200);
    const cleanMessage = String(message).trim().slice(0, 5000);
    const cleanFromName = String(fromName).trim().slice(0, 80);
    const cleanToEmail = String(toEmail).trim().toLowerCase().slice(0, 200);
    const cleanToName  = String(toName || 'Team Member').trim().slice(0, 80);

    if (!cleanSubject || !cleanMessage) {
      return res.status(400).json({ success: false, message: 'Subject and message cannot be empty.' });
    }

    console.log(`[contact/team] relay ${fromEmail} → ${cleanToEmail}`);

    // ---- Send via existing transporter ----
    await withTimeout(
      transporter.sendMail({
        to: cleanToEmail,
        replyTo: String(fromEmail).trim(),
        subject: `[Portal Contact] ${cleanSubject}`,
        text:
          `New message from the Aerospace Portal contact form.\n\n` +
          `From:  ${cleanFromName} <${fromEmail}>\n` +
          `To:    ${cleanToName}\n` +
          `Subject: ${cleanSubject}\n\n` +
          `${cleanMessage}\n\n` +
          `——\nReply directly to this email to respond to ${cleanFromName}.`,
        html: `
          <div style="font-family:Inter,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px 20px;color:#14161c;line-height:1.6;background:#ffffff;">
            <div style="border-left:4px solid #6366f1;padding-left:14px;margin-bottom:22px;">
              <div style="font-size:18px;font-weight:700;color:#14161c;">New Portal Contact Message</div>
              <div style="font-size:12px;color:#8b8d98;letter-spacing:.5px;">AEROSPACE DEPARTMENT · IIT KHARAGPUR</div>
            </div>

            <table style="width:100%;border-collapse:collapse;margin-bottom:18px;font-size:13.5px;">
              <tr><td style="padding:6px 0;color:#8b8d98;width:80px;">From</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(cleanFromName)} &lt;${escapeHtml(fromEmail)}&gt;</td></tr>
              <tr><td style="padding:6px 0;color:#8b8d98;">To</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(cleanToName)}</td></tr>
              <tr><td style="padding:6px 0;color:#8b8d98;">Subject</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(cleanSubject)}</td></tr>
            </table>

            <div style="background:#f6f4f1;border-radius:8px;padding:16px 18px;font-size:14.5px;white-space:pre-wrap;">${escapeHtml(cleanMessage)}</div>

            <p style="font-size:12.5px;color:#8b8d98;margin-top:22px;padding-top:14px;border-top:1px solid #ebe7e0;">
              Reply directly to this email to reach <strong>${escapeHtml(cleanFromName)}</strong>.
            </p>
          </div>`
      }),
      30000,
      'Contact team email'
    );

    res.json({ success: true, message: 'Message sent. They will reply to your email soon.' });
  } catch (e) {
    console.error('[contact/team]', e);
    res.status(500).json({ success: false, message: 'Could not send message: ' + e.message });
  }
});

/* ---- Admin: update plan info ---- */
app.put('/api/admin/settings/subscription', requireAdminAuth, async (req, res) => {
  try {
    const { amount, title, description, enabled } = req.body || {};

    const s = await getGlobalSettings();
    if (typeof amount === 'number' && amount >= 0) s.subscriptionAmount = amount;
    if (typeof title === 'string') s.subscriptionTitle = title.trim() || s.subscriptionTitle;
    if (typeof description === 'string') s.subscriptionDesc = description.trim() || s.subscriptionDesc;
    if (typeof enabled === 'boolean') s.subscriptionEnabled = enabled;
    s.updatedAt = new Date();
    await s.save();
    cacheClear('settings:');
    invalidateGlobalSettingsCache();

    res.json({
      success: true,
      message: 'Subscription settings saved.',
      settings: {
        enabled: s.subscriptionEnabled,
        amount: s.subscriptionAmount,
        title: s.subscriptionTitle,
        description: s.subscriptionDesc
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ---- Ensure a Razorpay Plan exists matching the current amount ---- */
async function ensureRazorpayPlan(s) {
  // ---- PRIORITY 1: use a manually-configured plan_id from .env ----
  const envPlanId = process.env.RAZORPAY_PLAN_ID;
  if (envPlanId && envPlanId.startsWith('plan_')) {
    // (Optional) sanity-check that the plan exists on Razorpay
    try {
      const plan = await razorpay.plans.fetch(envPlanId);
      const planAmount = plan && plan.item ? Number(plan.item.amount) : null;
      const wanted = Math.round(Number(s.subscriptionAmount) * 100);
      if (planAmount && planAmount !== wanted) {
        console.warn(
          `[subscription] ⚠️ Amount mismatch — ` +
          `Razorpay plan is ₹${planAmount / 100}/month but ` +
          `admin setting is ₹${s.subscriptionAmount}/month. ` +
          `Razorpay will charge ₹${planAmount / 100}. Please align them in the admin Subscriptions tab.`
        );
      }
      return plan.id;
    } catch (e) {
      console.warn('[subscription] Could not fetch env plan_id, falling back:', e.message);
      // fall through to the next branch
    }
  }

  // ---- PRIORITY 2: use the plan_id already stored in Settings ----
  if (s.razorpayPlanId) {
    try {
      const plan = await razorpay.plans.fetch(s.razorpayPlanId);
      if (plan && plan.id) return s.razorpayPlanId;
    } catch (e) {
      console.warn('[subscription] Stored plan fetch failed:', e.message);
    }
  }

  // ---- PRIORITY 3: auto-create a plan (original behaviour) ----
  const wantedAmount = Math.round(Number(s.subscriptionAmount) * 100);

  const plan = await razorpay.plans.create({
    period: 'monthly',
    interval: 1,
    item: {
      name: s.subscriptionTitle || 'All-Access Monthly Pass',
      amount: wantedAmount,
      currency: 'INR',
      description: s.subscriptionDesc || ''
    },
    notes: { product: 'aero-all-access' }
  });

  s.razorpayPlanId = plan.id;
  await s.save();
  invalidateGlobalSettingsCache();
  return plan.id;
}

/* ---- Student: start subscription checkout ---- */
/* ============================================================
   SUBSCRIPTION PLANS — multi-tier CRUD + checkout + coupons
   ============================================================ */

/* ---- Public: list all enabled plans ---- */
app.get('/api/subscription/plans', async (req, res) => {
  try {
    const s = await getGlobalSettings();
    const plans = (s.subscriptionPlans || [])
      .filter(p => p.enabled)
      .map(p => ({
        id: p.id,
        title: p.title,
        description: p.description,
        durationDays: p.durationDays,
        amount: p.amount,
        badge: p.badge || '',
        featured: !!p.featured
      }));
    res.json({
      success: true,
      enabled: !!s.subscriptionEnabled,
      plans,
      referral: {
        enabled: !!s.referralEnabled,
        threshold: s.referralThreshold,
        rewardDays: s.referralRewardDays,
        rewardTitle: s.referralRewardTitle,
        rewardDesc:  s.referralRewardDesc
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ---- Admin: list ALL plans (including disabled) ---- */
app.get('/api/admin/subscription-plans', requireAdminAuth, async (req, res) => {
  try {
    const s = await getGlobalSettings();
    res.json({
      success: true,
      plans: (s.subscriptionPlans || []).map(p => p.toObject ? p.toObject() : p)
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ---- Admin: create custom plan ---- */
app.post('/api/admin/subscription-plans', requireAdminAuth, async (req, res) => {
  try {
    const { title, description, durationDays, amount, badge, featured, enabled } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ success:false, message:'Title is required.' });
    const days = parseInt(durationDays, 10);
    if (!days || days < 1)   return res.status(400).json({ success:false, message:'Valid duration (days) is required.' });
    const amt = Number(amount);
    if (!(amt >= 0))         return res.status(400).json({ success:false, message:'Valid amount is required.' });

    const s = await getGlobalSettings();
    if (!Array.isArray(s.subscriptionPlans)) s.subscriptionPlans = [];
    if (s.subscriptionPlans.length >= 20) {
      return res.status(400).json({ success:false, message:'Max 20 plans allowed.' });
    }

    const id = 'plan_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
    s.subscriptionPlans.push({
      id,
      title: String(title).trim().slice(0, 80),
      description: String(description || '').trim().slice(0, 240),
      durationDays: days,
      amount: amt,
      badge: String(badge || '').trim().slice(0, 30),
      featured: !!featured,
      enabled: enabled !== false,
      razorpayPlanId: null,
      createdAt: new Date()
    });
    s.updatedAt = new Date();
    await s.save();
    cacheClear('settings:');
    invalidateGlobalSettingsCache();
    res.json({ success: true, message: 'Plan created.', plan: s.subscriptionPlans[s.subscriptionPlans.length - 1] });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ---- Admin: update plan ---- */
app.put('/api/admin/subscription-plans/:planId', requireAdminAuth, async (req, res) => {
  try {
    const s = await getGlobalSettings();
    const plan = (s.subscriptionPlans || []).find(p => p.id === req.params.planId);
    if (!plan) return res.status(404).json({ success:false, message:'Plan not found.' });

    const { title, description, durationDays, amount, badge, featured, enabled } = req.body || {};
    if (title !== undefined)       plan.title = String(title).trim().slice(0, 80);
    if (description !== undefined) plan.description = String(description).trim().slice(0, 240);
    if (durationDays !== undefined) {
      const d = parseInt(durationDays, 10);
      if (d >= 1) plan.durationDays = d;
    }
    if (amount !== undefined) {
      const a = Number(amount);
      if (a >= 0) plan.amount = a;
    }
    if (badge !== undefined)   plan.badge = String(badge).trim().slice(0, 30);
    if (featured !== undefined) plan.featured = !!featured;
    if (enabled !== undefined)  plan.enabled = !!enabled;

    /* ⭐ Invalidate the cached Razorpay plan if the amount OR the
       duration changed. Checking only `amount` is a bug: changing
       a plan from 1-month to 6-month while keeping the same price
       would silently keep billing monthly via the old Razorpay plan. */
    if (amount !== undefined || durationDays !== undefined) {
      plan.razorpayPlanId = null;
    }

    s.updatedAt = new Date();
    await s.save();
    cacheClear('settings:');
    invalidateGlobalSettingsCache();
    res.json({ success: true, message: 'Plan updated.', plan });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ---- Admin: delete plan ---- */
app.delete('/api/admin/subscription-plans/:planId', requireAdminAuth, async (req, res) => {
  try {
    const s = await getGlobalSettings();
    const before = (s.subscriptionPlans || []).length;
    s.subscriptionPlans = (s.subscriptionPlans || []).filter(p => p.id !== req.params.planId);
    if (s.subscriptionPlans.length === before) {
      return res.status(404).json({ success:false, message:'Plan not found.' });
    }
    s.updatedAt = new Date();
    await s.save();
    cacheClear('settings:');
    invalidateGlobalSettingsCache();
    res.json({ success: true, message: 'Plan deleted.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ============================================================
   COUPONS
   ============================================================ */

/* ---- Admin: list coupons ---- */
app.get('/api/admin/coupons', requireAdminAuth, async (req, res) => {
  try {
    const list = await Coupon.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, coupons: list });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ---- Admin: create coupon ---- */
app.post('/api/admin/coupons', requireAdminAuth, async (req, res) => {
  try {
    const { code, description, discountPercent, maxUses, expiresAt } = req.body || {};
    const cleanCode = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (cleanCode.length < 3 || cleanCode.length > 30) {
      return res.status(400).json({ success:false, message:'Coupon code must be 3–30 characters (A-Z, 0-9, _, -).' });
    }
    const pct = parseInt(discountPercent, 10);
    if (!pct || pct < 1 || pct > 100) {
      return res.status(400).json({ success:false, message:'Discount must be 1–100.' });
    }
    const exists = await Coupon.findOne({ code: cleanCode });
    if (exists) return res.status(409).json({ success:false, message:'That code already exists.' });

    const doc = await Coupon.create({
      code: cleanCode,
      description: String(description || '').trim().slice(0, 200),
      discountPercent: pct,
      maxUses: Math.max(0, parseInt(maxUses, 10) || 0),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      createdBy: String(req.adminUser._id)
    });
    console.log(`[coupon] ✅ Created ${cleanCode} (${pct}%) by admin ${req.adminUser._id}`);
    res.json({ success: true, message: 'Coupon created.', coupon: doc });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ---- Admin: update coupon ---- */
app.put('/api/admin/coupons/:id', requireAdminAuth, async (req, res) => {
  try {
    const doc = await Coupon.findById(req.params.id);
    if (!doc) return res.status(404).json({ success:false, message:'Not found.' });
    const { description, discountPercent, maxUses, active, expiresAt } = req.body || {};
    if (description !== undefined) doc.description = String(description).trim().slice(0, 200);
    if (discountPercent !== undefined) {
      const p = parseInt(discountPercent, 10);
      if (p >= 1 && p <= 100) doc.discountPercent = p;
    }
    if (maxUses !== undefined) doc.maxUses = Math.max(0, parseInt(maxUses, 10) || 0);
    if (active !== undefined)  doc.active = !!active;
    if (expiresAt !== undefined) doc.expiresAt = expiresAt ? new Date(expiresAt) : null;
    await doc.save();
    res.json({ success: true, message: 'Coupon updated.', coupon: doc });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ---- Admin: delete coupon ---- */
app.delete('/api/admin/coupons/:id', requireAdminAuth, async (req, res) => {
  try {
    await Coupon.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Coupon deleted.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ---- Public: validate coupon (preview discount before payment) ---- */
app.post('/api/validate-coupon', async (req, res) => {
  try {
    const { code, planId } = req.body || {};
    const cleanCode = String(code || '').trim().toUpperCase();
    if (!cleanCode) return res.status(400).json({ success:false, message:'Coupon code is required.' });

    const coupon = await Coupon.findOne({ code: cleanCode });
    if (!coupon) return res.status(404).json({ success:false, message:'Invalid coupon code.' });
    if (!coupon.isValid()) {
      let reason = 'This coupon is no longer valid.';
      if (!coupon.active) reason = 'This coupon has been disabled.';
      else if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) reason = 'This coupon has expired.';
      else if (coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses) reason = 'This coupon has reached its usage limit.';
      return res.status(400).json({ success:false, message: reason });
    }

    const s = await getGlobalSettings();
    const plan = (s.subscriptionPlans || []).find(p => p.id === planId);
    if (!plan) return res.status(404).json({ success:false, message:'Plan not found.' });

    const originalAmount = Number(plan.amount) || 0;
    const discountAmount = Math.round(originalAmount * coupon.discountPercent) / 100;
    const finalAmount = Math.max(1, Math.round((originalAmount - discountAmount) * 100) / 100);

    res.json({
      success: true,
      valid: true,
      code: coupon.code,
      discountPercent: coupon.discountPercent,
      originalAmount,
      discountAmount,
      finalAmount,
      message: `Coupon applied — ${coupon.discountPercent}% off!`
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ============================================================
   SUBSCRIPTION CHECKOUT — supports plans + coupons
   ------------------------------------------------------------
   Two modes:
     • No coupon  → Razorpay SUBSCRIPTION (auto-renewing)
     • With coupon → Razorpay ORDER (one-time payment for plan.durationDays)
   ============================================================ */
/* ============================================================
   RAZORPAY PLAN RESOLVER
   ------------------------------------------------------------
   Resolves (or creates) a Razorpay plan that matches the admin's
   internal plan definition (amount + billing interval).

   KEY BEHAVIOURS:
     • Caches the created plan_id back into Settings so the SAME
       Razorpay plan is reused for every future subscriber.
     • Verifies BOTH amount AND interval when reusing a cached id —
       changing a plan's duration invalidates the old id.
     • Maps durationDays onto the closest Razorpay period/interval
       (daily / weekly / monthly / yearly) instead of blindly
       rounding to months.
   ============================================================ */
async function ensureRazorpayPlanForThisPlan(plan) {
  const planAmount   = Math.max(0, Number(plan.amount) || 0);
  const planDays     = Math.max(1, Number(plan.durationDays) || 30);
  const wantedAmount = Math.round(planAmount * 100);

  /* ---- Map durationDays → Razorpay period/interval ----
     Razorpay accepts:
       daily   : 1–90
       weekly  : 1–52
       monthly : 1, 2, 3, 6, 12
       yearly  : 1, 2, 3
     We pick the closest exact match. Anything else falls back to
     daily so the amount is still charged for the correct period. */
  let interval, period;
  if (planDays % 365 === 0 && (planDays / 365) <= 3) {
    period   = 'yearly';
    interval = planDays / 365;
  } else if (planDays % 30 === 0 &&
             [1, 2, 3, 6, 12].includes(planDays / 30)) {
    period   = 'monthly';
    interval = planDays / 30;
  } else if (planDays % 7 === 0 && (planDays / 7) <= 52) {
    period   = 'weekly';
    interval = planDays / 7;
  } else {
    period   = 'daily';
    interval = Math.min(90, planDays);
  }

  /* ---- 1) Reuse cached plan if it fully matches ---- */
  if (plan.razorpayPlanId) {
    try {
      const fetched   = await razorpay.plans.fetch(plan.razorpayPlanId);
      const fAmount   = fetched && fetched.item ? Number(fetched.item.amount) : null;
      const fInterval = fetched && fetched.interval != null ? Number(fetched.interval) : null;
      const fPeriod   = fetched && fetched.period ? String(fetched.period) : null;

      if (fAmount === wantedAmount &&
          fInterval === interval &&
          fPeriod === period) {
        return plan.razorpayPlanId;
      }
      console.log(
        `[plan] cached Razorpay plan mismatch — ` +
        `have ${fAmount}p/${fInterval}${fPeriod}, want ${wantedAmount}p/${interval}${period}. ` +
        `Creating a new one.`
      );
    } catch (e) {
      console.warn('[plan] cached razorpayPlanId invalid:', e.message);
    }
  }

  /* ---- 2) Create a new Razorpay plan ---- */
  const created = await razorpay.plans.create({
    period,
    interval,
    item: {
      name:        plan.title,
      amount:      wantedAmount,
      currency:    'INR',
      description: plan.description || ''
    },
    notes: { internalPlanId: plan.id }
  });

  /* ---- 3) ⭐ Persist the id back so the NEXT student reuses it ----
     Without this, every checkout creates a duplicate Razorpay plan. */
  try {
    const s = await getGlobalSettings();
    const stored = (s.subscriptionPlans || []).find(p => p.id === plan.id);
    if (stored) {
      stored.razorpayPlanId = created.id;
      s.updatedAt = new Date();
      await s.save();
      invalidateGlobalSettingsCache();
      cacheClear('settings:');
      console.log(
        `[plan] ✅ Cached Razorpay plan id "${created.id}" on internal plan "${plan.id}" ` +
        `(${interval} ${period}, ₹${planAmount})`
      );
    }
  } catch (saveErr) {
    console.warn('[plan] Could not persist razorpayPlanId:', saveErr.message);
  }

  return created.id;
}

app.post('/api/subscribe/create', async (req, res) => {
  try {
    const { userId, planId, couponCode } = req.body || {};
    if (!userId) return res.status(400).json({ success:false, message:'userId required.' });
    if (!planId) return res.status(400).json({ success:false, message:'planId required.' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success:false, message:'User not found.' });

    const s = await getGlobalSettings();
    if (!s.subscriptionEnabled) {
      return res.status(400).json({ success:false, message:'Subscription is not enabled yet.' });
    }
    const plan = (s.subscriptionPlans || []).find(p => p.id === planId && p.enabled);
    if (!plan) return res.status(404).json({ success:false, message:'Plan not found or disabled.' });

    /* ---- Coupon (optional) ---- */
    let coupon = null;
    let finalAmount = Number(plan.amount) || 0;
    if (couponCode) {
      const cleanCode = String(couponCode).trim().toUpperCase();
      coupon = await Coupon.findOne({ code: cleanCode });
      if (!coupon || !coupon.isValid()) {
        return res.status(400).json({ success:false, message:'Coupon is invalid or expired.' });
      }
      const discount = Math.round(finalAmount * coupon.discountPercent) / 100;
      finalAmount = Math.max(1, Math.round((finalAmount - discount) * 100) / 100);
    }

    /* ---- Mode 1: One-time ORDER (with coupon) ---- */
    if (coupon) {
      const order = await razorpay.orders.create({
        amount: Math.round(finalAmount * 100),   // paise
        currency: 'INR',
        receipt: 'aero_plan_' + Date.now().toString(36),
        notes: {
          userId: String(user._id),
          planId: plan.id,
          couponCode: coupon.code,
          purpose: 'aero-one-time-subscription',
          durationDays: plan.durationDays
        }
      });

      if (!user.subscription) user.subscription = {};
      user.subscription.status = 'pending';
      user.subscription.planId = plan.id;
      user.subscription.planTitle = plan.title;
      user.subscription.planDurationDays = plan.durationDays;
      user.subscription.amount = plan.amount;
      user.subscription.amountPaid = finalAmount;
      user.subscription.couponApplied = coupon.code;
      user.subscription.lastOrderId = order.id;
      user.subscription.paymentMode = 'one-time';
      user.subscription.autoRenew = false;
      await user.save();

      console.log(`[subscribe/create] one-time order ${order.id} for ${user.username} · ₹${finalAmount} (coupon ${coupon.code})`);

      return res.json({
        success: true,
        mode: 'one-time',
        key_id: process.env.RAZORPAY_KEY_ID,
        orderId: order.id,
        amount: finalAmount,
        originalAmount: plan.amount,
        discountPercent: coupon.discountPercent,
        couponCode: coupon.code,
        planTitle: plan.title,
        durationDays: plan.durationDays
      });
    }

    /* ---- Mode 2: Auto-renewing SUBSCRIPTION (no coupon) ---- */
    const rzpPlanId = await ensureRazorpayPlanForThisPlan(plan);
    const subscription = await razorpay.subscriptions.create({
      plan_id: rzpPlanId,
      customer_notify: 1,
      quantity: 1,
      total_count: 100,
      notes: {
        userId: String(user._id),
        planId: plan.id,
        purpose: 'aero-all-access'
      }
    });

    if (!user.subscription) user.subscription = {};
    user.subscription.status = 'pending';
    user.subscription.planId = plan.id;
    user.subscription.planTitle = plan.title;
    user.subscription.planDurationDays = plan.durationDays;
    user.subscription.razorpayPlanId = rzpPlanId;
    user.subscription.subscriptionId = subscription.id;
    user.subscription.amount = plan.amount;
    user.subscription.amountPaid = plan.amount;
    user.subscription.couponApplied = null;
    user.subscription.paymentMode = 'subscription';
    user.subscription.autoRenew = true;
    await user.save();

    console.log(`[subscribe/create] subscription ${subscription.id} for ${user.username} · ₹${plan.amount} · plan ${plan.id}`);

    res.json({
      success: true,
      mode: 'subscription',
      key_id: process.env.RAZORPAY_KEY_ID,
      subscriptionId: subscription.id,
      amount: plan.amount,
      originalAmount: plan.amount,
      planTitle: plan.title,
      durationDays: plan.durationDays
    });
  } catch (e) {
    console.error('[subscribe/create]', e);
    res.status(500).json({ success: false, message: 'Could not start subscription: ' + e.message });
  }
});

/* ---- Verify (subscription mode) ---- */
app.post('/api/subscribe/verify', async (req, res) => {
  try {
    const { userId, razorpay_subscription_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!userId || !razorpay_subscription_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success:false, message:'Missing verification fields.' });
    }
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_payment_id + '|' + razorpay_subscription_id)
      .digest('hex');
    if (!safeEqualHex(razorpay_signature, expected)) {
      return res.status(400).json({ success:false, message:'Invalid subscription signature.' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success:false, message:'User not found.' });

    let sub = null;
    try { sub = await razorpay.subscriptions.fetch(razorpay_subscription_id); } catch (e) {}

    const s = await getGlobalSettings();
    const planId = (user.subscription && user.subscription.planId) || null;
    const plan = (s.subscriptionPlans || []).find(p => p.id === planId);
    const durationDays = plan ? plan.durationDays : 30;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

    if (!user.subscription) user.subscription = {};
    user.subscription.active = true;
    user.subscription.status = 'active';
    user.subscription.subscriptionId = razorpay_subscription_id;
    user.subscription.razorpayPlanId = (sub && sub.plan_id) || user.subscription.razorpayPlanId;
    user.subscription.startedAt = user.subscription.startedAt || now;
    user.subscription.expiresAt = expiresAt;
    user.subscription.planDurationDays = durationDays;
    user.subscription.autoRenew = true;
    user.subscription.paymentMode = 'subscription';
    user.subscription.lastPaymentId = razorpay_payment_id;
    user.subscription.history = user.subscription.history || [];
    user.subscription.history.push({
      paymentId: razorpay_payment_id,
      amount: user.subscription.amountPaid || user.subscription.amount || 0,
      status: 'charged',
      note: 'Subscription activated',
      date: now
    });
    _clearAuthUserCache();          // ⭐ NEW
    await user.save();

    // ---- Referral: bump referrer's subscribed count ----
    if (user.referredBy) {
      try {
        const referrer = await User.findOne({ referralCode: user.referredBy });
        if (referrer) {
          if (!referrer.referralStats) referrer.referralStats = {};
          referrer.referralStats.totalSubscribed = (referrer.referralStats.totalSubscribed || 0) + 1;
          await referrer.save();
        }
      } catch (e) { /* silent */ }
    }

    res.json({ success: true, message: 'Subscription activated!', user: serializeUser(user) });
  } catch (e) {
    console.error('[subscribe/verify]', e);
    res.status(500).json({ success: false, message: 'Verify failed: ' + e.message });
  }
});

/* ---- Verify (one-time order mode with coupon) ---- */
app.post('/api/subscribe/verify-order', async (req, res) => {
  try {
    const {
      userId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body || {};
    if (!userId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success:false, message:'Missing verification fields.' });
    }

    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');
    if (!safeEqualHex(razorpay_signature, expected)) {
      return res.status(400).json({ success:false, message:'Invalid payment signature.' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success:false, message:'User not found.' });

    if (!user.subscription) user.subscription = {};
    const now = new Date();
    const durationDays = user.subscription.planDurationDays || 30;
    const base = (user.subscription.expiresAt && new Date(user.subscription.expiresAt) > now)
      ? new Date(user.subscription.expiresAt) : now;
    const expiresAt = new Date(base.getTime() + durationDays * 24 * 60 * 60 * 1000);

    user.subscription.active = true;
    user.subscription.status = 'active';
    user.subscription.startedAt = user.subscription.startedAt || now;
    user.subscription.expiresAt = expiresAt;
    user.subscription.autoRenew = false;
    user.subscription.paymentMode = 'one-time';
    user.subscription.lastPaymentId = razorpay_payment_id;
    user.subscription.history = user.subscription.history || [];
    user.subscription.history.push({
      paymentId: razorpay_payment_id,
      amount: user.subscription.amountPaid || 0,
      status: 'charged',
      note: `One-time purchase${user.subscription.couponApplied ? ' · coupon ' + user.subscription.couponApplied : ''}`,
      date: now
    });
    _clearAuthUserCache();          // ⭐ NEW
    await user.save();

    // ---- Mark coupon used ----
    if (user.subscription.couponApplied) {
      try {
        const coupon = await Coupon.findOne({ code: user.subscription.couponApplied });
        if (coupon) {
          coupon.usedCount = (coupon.usedCount || 0) + 1;
          coupon.usedBy = coupon.usedBy || [];
          coupon.usedBy.push({
            userId: String(user._id),
            userEmail: user.email || '',
            planId: user.subscription.planId,
            amountSaved: Math.max(0, (user.subscription.amount || 0) - (user.subscription.amountPaid || 0)),
            usedAt: now
          });
          await coupon.save();
        }
      } catch (e) { console.warn('[coupon-use]', e.message); }
    }

    // ---- Referral tracking ----
    if (user.referredBy) {
      try {
        const referrer = await User.findOne({ referralCode: user.referredBy });
        if (referrer) {
          if (!referrer.referralStats) referrer.referralStats = {};
          referrer.referralStats.totalSubscribed = (referrer.referralStats.totalSubscribed || 0) + 1;
          await referrer.save();
        }
      } catch (e) { /* silent */ }
    }

    res.json({ success: true, message: 'Subscription activated!', user: serializeUser(user) });
  } catch (e) {
    console.error('[subscribe/verify-order]', e);
    res.status(500).json({ success: false, message: 'Verify failed: ' + e.message });
  }
});

/* ============================================================
   REFERRAL PROGRAM — public user endpoint + admin control
   ============================================================ */

/* ---- Student: my referral info ---- */
app.get('/api/user/referral/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId)
      .select('username fullName referralCode referralStats referredBy');
    if (!user) return res.status(404).json({ success:false, message:'User not found.' });

    // Ensure user has a code
    if (!user.referralCode) {
      await ensureReferralCode(user);
    }

    const s = await getGlobalSettings();
    const threshold = Math.max(1, Number(s.referralThreshold) || 3);
    const total = (user.referralStats && user.referralStats.totalReferred) || 0;
    const rewardedFor = (user.referralStats && user.referralStats.rewardedFor) || 0;
    const rewardsEarned = (user.referralStats && user.referralStats.rewardsEarned) || 0;
    const nextRewardAt = (Math.floor(total / threshold) + 1) * threshold;

    // List of people this user has referred (limited)
    const referredUsers = await User.find({ referredBy: user.referralCode })
      .select('username fullName createdAt subscription')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json({
      success: true,
      referralCode: user.referralCode,
      stats: {
        totalReferred: total,
        totalSubscribed: (user.referralStats && user.referralStats.totalSubscribed) || 0,
        rewardsEarned,
        rewardedFor,
        nextRewardAt,
        progressInCycle: total % threshold,
        threshold
      },
      program: {
        enabled: !!s.referralEnabled,
        threshold: s.referralThreshold,
        rewardDays: s.referralRewardDays,
        rewardTitle: s.referralRewardTitle,
        rewardDesc:  s.referralRewardDesc
      },
      referredUsers: referredUsers.map(u => ({
        username: u.username,
        fullName: u.fullName || '',
        joinedAt: u.createdAt,
        isSubscribed: !!(u.subscription && u.subscription.active &&
          (!u.subscription.expiresAt || new Date(u.subscription.expiresAt) > new Date()))
      }))
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ---- Admin: read referral settings ---- */
app.get('/api/admin/referral-settings', requireAdminAuth, async (req, res) => {
  try {
    const s = await getGlobalSettings();
    res.json({
      success: true,
      settings: {
        enabled:     !!s.referralEnabled,
        threshold:   s.referralThreshold,
        rewardDays:  s.referralRewardDays,
        rewardTitle: s.referralRewardTitle,
        rewardDesc:  s.referralRewardDesc
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ---- Admin: update referral settings ---- */
app.put('/api/admin/referral-settings', requireAdminAuth, async (req, res) => {
  try {
    const { enabled, threshold, rewardDays, rewardTitle, rewardDesc } = req.body || {};
    const s = await getGlobalSettings();
    if (typeof enabled === 'boolean') s.referralEnabled = enabled;
    if (threshold !== undefined) {
      const t = parseInt(threshold, 10);
      if (t >= 1 && t <= 100) s.referralThreshold = t;
    }
    if (rewardDays !== undefined) {
      const d = parseInt(rewardDays, 10);
      if (d >= 1 && d <= 3650) s.referralRewardDays = d;
    }
    if (rewardTitle !== undefined) s.referralRewardTitle = String(rewardTitle).trim().slice(0, 80);
    if (rewardDesc !== undefined)  s.referralRewardDesc  = String(rewardDesc).trim().slice(0, 240);
    s.updatedAt = new Date();
    await s.save();
    cacheClear('settings:');
    invalidateGlobalSettingsCache();
    res.json({
      success: true,
      message: 'Referral settings saved.',
      settings: {
        enabled: s.referralEnabled,
        threshold: s.referralThreshold,
        rewardDays: s.referralRewardDays,
        rewardTitle: s.referralRewardTitle,
        rewardDesc: s.referralRewardDesc
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ---- Admin: top referrers leaderboard ---- */
app.get('/api/admin/referrals', requireAdminAuth, async (req, res) => {
  try {
    const topReferrers = await User.find({ 'referralStats.totalReferred': { $gt: 0 } })
      .select('username fullName email referralCode referralStats subscription')
      .sort({ 'referralStats.totalReferred': -1 })
      .limit(100)
      .lean();

    const totalWithCode = await User.countDocuments({ role: 'student', referralCode: { $ne: null } });
    const totalReferred = await User.countDocuments({ referredBy: { $ne: null } });

    const s = await getGlobalSettings();
    res.json({
      success: true,
      settings: {
        enabled: s.referralEnabled,
        threshold: s.referralThreshold,
        rewardDays: s.referralRewardDays,
        rewardTitle: s.referralRewardTitle,
        rewardDesc: s.referralRewardDesc
      },
      totals: { totalWithCode, totalReferred },
      referrers: topReferrers.map(u => {
        const stats = u.referralStats || {};
        const isSubbed = !!(u.subscription && u.subscription.active &&
          (!u.subscription.expiresAt || new Date(u.subscription.expiresAt) > new Date()));
        return {
          _id: u._id,
          username: u.username,
          fullName: u.fullName || '',
          email: u.email || '',
          referralCode: u.referralCode,
          totalReferred: stats.totalReferred || 0,
          totalSubscribed: stats.totalSubscribed || 0,
          rewardsEarned: stats.rewardsEarned || 0,
          rewardedFor: stats.rewardedFor || 0,
          lastRewardAt: stats.lastRewardAt,
          isSubscribed: isSubbed,
          subscriptionExpiresAt: u.subscription && u.subscription.expiresAt
        };
      })
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ---- Admin: manually grant a referral reward to a user ---- */
app.post('/api/admin/referrals/:userId/grant-reward', requireAdminAuth, async (req, res) => {
  try {
    const { days } = req.body || {};
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success:false, message:'User not found.' });

    const s = await getGlobalSettings();
    const d = parseInt(days, 10) || s.referralRewardDays || 30;

    await grantReferralReward(user, d, s);
    res.json({
      success: true,
      message: `Granted ${d} day(s) of premium to ${user.username}.`,
      user: serializeUser(user)
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});


/* ============================================================
   SUBSCRIPTION CANCELLATION — OTP-VERIFIED
   ------------------------------------------------------------
   Flow:
     1. POST /api/subscribe/cancel/send-otp  → emails a 6-digit code
     2. POST /api/subscribe/cancel/verify    → verifies code + cancels

   Security:
     • OTP is 6 digits, expires in 10 minutes
     • Max 5 wrong attempts before the OTP is invalidated
     • Uses the same transporter as OTP registration / bulk email
     • Email is masked in the response (e.g. "kr***@gmail.com")
   ============================================================ */
const cancelOtpStore = {}; // userId -> { otp, expiresAt, attempts, email }

function maskEmail(email) {
  if (!email || typeof email !== 'string') return 'your email';
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

/* ---- Step 1: send OTP ---- */
app.post('/api/subscribe/cancel/send-otp', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ success: false, message: 'userId required.' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (!user.subscription || !user.subscription.active || user.subscription.status !== 'active') {
      return res.status(400).json({ success: false, message: 'You have no active subscription to cancel.' });
    }

    if (!user.email || !String(user.email).trim()) {
      return res.status(400).json({
        success: false,
        message: 'No email address on file. Please contact support to cancel your subscription.'
      });
    }

    if (!EMAIL_USER || !EMAIL_PASS) {
      return res.status(500).json({
        success: false,
        message: 'Email service is not configured on the server.'
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store / overwrite previous OTP for this user
    cancelOtpStore[userId] = {
      otp,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
      attempts: 0,
      email: user.email
    };

    const html = `
      <div style="font-family:Inter,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;padding:26px 22px;color:#14161c;line-height:1.6;background:#ffffff;">
        <div style="border-left:4px solid #ef4444;padding-left:14px;margin-bottom:22px;">
          <div style="font-size:18px;font-weight:700;color:#14161c;">Aerospace Department</div>
          <div style="font-size:12px;color:#8b8d98;letter-spacing:.5px;">IIT KHARAGPUR</div>
        </div>

        <h2 style="font-size:20px;font-weight:800;color:#14161c;margin:0 0 10px;">Confirm subscription cancellation</h2>
        <p style="font-size:14.5px;margin:0 0 18px;">
          Hi ${escapeHtml(user.fullName || user.username || 'Student')},<br><br>
          We received a request to <strong>cancel your All-Access subscription</strong>.
          If this was you, enter the verification code below. If you didn't request this, ignore this email — <em>your subscription will stay active.</em>
        </p>

        <div style="text-align:center;margin:26px 0;">
          <div style="display:inline-block;padding:16px 28px;border-radius:12px;background:linear-gradient(135deg,#eef2ff,#e0e7ff);border:1px solid #c7d2fe;">
            <div style="font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#4f46e5;margin-bottom:6px;">Verification Code</div>
            <div style="font-size:34px;font-weight:900;letter-spacing:10px;color:#312e81;font-family:'Courier New',monospace;">${otp}</div>
          </div>
        </div>

        <p style="font-size:13px;color:#4a4d5a;margin:18px 0 0;">
          This code expires in <strong>10 minutes</strong>. Do not share it with anyone.
        </p>

        <div style="border-top:1px solid #ebe7e0;margin-top:26px;padding-top:16px;font-size:12.5px;color:#8b8d98;">
          — Aerospace Department<br/>IIT Kharagpur
        </div>
      </div>`;

    const text =
      `Confirm subscription cancellation\n\n` +
      `Hi ${user.fullName || user.username || 'Student'},\n\n` +
      `Your verification code is: ${otp}\n\n` +
      `This code expires in 10 minutes. If you did not request this, ignore this email — your subscription will stay active.\n\n` +
      `— Aerospace Department\nIIT Kharagpur`;

    await withTimeout(
      transporter.sendMail({
        to: user.email,
        subject: 'Confirm your subscription cancellation — Aerospace Department',
        text,
        html
      }),
      30000,
      'Cancel OTP send'
    );

    console.log(`[subscribe/cancel/send-otp] OTP sent to ${user.email} (user ${userId})`);

    res.json({
      success: true,
      message: 'Verification code sent to your email.',
      email: maskEmail(user.email)
    });
  } catch (e) {
    console.error('[subscribe/cancel/send-otp] Error:', e);
    res.status(500).json({ success: false, message: 'Could not send verification code: ' + e.message });
  }
});

/* ---- Step 2: verify OTP + cancel ---- */
app.post('/api/subscribe/cancel/verify', async (req, res) => {
  try {
    const { userId, otp } = req.body || {};
    if (!userId || !otp) {
      return res.status(400).json({ success: false, message: 'userId and otp are required.' });
    }

    const record = cancelOtpStore[userId];
    if (!record) {
      return res.status(400).json({
        success: false,
        message: 'No verification code was requested. Please request a new one.'
      });
    }

    if (Date.now() > record.expiresAt) {
      delete cancelOtpStore[userId];
      return res.status(400).json({
        success: false,
        message: 'This code has expired. Please request a new one.'
      });
    }

    if (record.attempts >= 5) {
      delete cancelOtpStore[userId];
      return res.status(400).json({
        success: false,
        message: 'Too many incorrect attempts. Please request a new code.'
      });
    }

    if (String(otp).trim() !== record.otp) {
      record.attempts++;
      const left = 5 - record.attempts;
      return res.status(400).json({
        success: false,
        message: `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} remaining.`
      });
    }

    // ✅ OTP verified — burn it before we do anything else
    delete cancelOtpStore[userId];

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (!user.subscription || !user.subscription.active) {
      return res.status(400).json({ success: false, message: 'This subscription is no longer active.' });
    }

    // Try to cancel on Razorpay's side (best-effort)
    if (user.subscription.subscriptionId) {
      try {
        await razorpay.subscriptions.cancel(user.subscription.subscriptionId, false);
      } catch (e) {
        console.warn('[subscribe/cancel/verify] razorpay cancel failed:', e.message);
      }
    }

    user.subscription.active = false;
    user.subscription.autoRenew = false;
    user.subscription.status = 'cancelled';
    user.subscription.history = user.subscription.history || [];
    user.subscription.history.push({
      status: 'revoked',
      amount: 0,
      note: 'Cancelled by user (OTP verified)',
      date: new Date()
    });
    _clearAuthUserCache();          // ⭐ NEW
    await user.save();

    console.log(`[subscribe/cancel/verify] Subscription cancelled for user ${userId}`);

    res.json({
      success: true,
      message: 'Subscription cancelled. You can continue using it until the end of the current billing period.',
      user: serializeUser(user)
    });
  } catch (e) {
    console.error('[subscribe/cancel/verify] Error:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

/* ---- Admin: list all subscriptions + current settings ---- */
app.get('/api/admin/subscriptions', requireAdminAuth, async (req, res) => {
  try {

    const users = await User.find({ 'subscription.status': { $in: ['pending','active','expired','cancelled','halted'] } })
      .select('fullName username email role purchases subscription').lean();

    const now = new Date();
    const subscriptions = users.map(u => {
      const s = u.subscription || {};
      const role = String(u.role || '').toLowerCase();

      // ---- Paid subscription state (the raw truth) ----
      const hasPaidActiveSub = !!(s.active && s.status === 'active' &&
        (!s.expiresAt || new Date(s.expiresAt) > now));

      // ---- Effective access state for display ----
      //   • Active paid sub             → 'active'
      //   • Admin (platform-wide access)→ 'admin'
      //   • Payment started but never completed → 'pending'
      //   • Cancelled / halted          → 'cancelled'
      //   • Expired paid sub            → 'expired'
      const isAdminUser = role === 'admin';
      const isPending   = s.status === 'pending' && !s.active;
      const isCancelled = s.status === 'cancelled' || s.status === 'halted';
      const isExpired   = !!(s.expiresAt && new Date(s.expiresAt) < now &&
                             s.status === 'active');

      let effectiveStatus;
      if (hasPaidActiveSub) effectiveStatus = 'active';
      else if (isAdminUser) effectiveStatus = 'admin';
      else if (isPending)   effectiveStatus = 'pending';
      else if (isCancelled) effectiveStatus = 'cancelled';
      else if (isExpired)   effectiveStatus = 'expired';
      else                  effectiveStatus = s.status || 'none';

      const daysLeft = s.expiresAt
        ? Math.ceil((new Date(s.expiresAt) - now) / 86400000)
        : null;

      return {
        _id: u._id,
        fullName: u.fullName,
        username: u.username,
        email: u.email,
        role: u.role || 'student',
        subscription: s,
        isActive: hasPaidActiveSub,                        // raw paid-active
        hasAccess: hasPaidActiveSub || isAdminUser,        // effective access
        effectiveStatus,                                   // ⭐ for display
        daysLeft
      };
    });

    const settings = await getGlobalSettings();
    res.json({
      success: true,
      subscriptions,
      settings: {
        enabled:     settings.subscriptionEnabled,
        amount:      settings.subscriptionAmount,
        title:       settings.subscriptionTitle,
        description: settings.subscriptionDesc
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ---- Admin: grant subscription manually ---- */
app.post('/api/admin/subscription/:userId/grant', requireAdminAuth, async (req, res) => {
  try {
    const { days, note } = req.body || {};

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const s = await getGlobalSettings();
    const now = new Date();
    const d = parseInt(days, 10) || 30;
    const expiresAt = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);

    if (!user.subscription) user.subscription = {};
    user.subscription.active = true;
    user.subscription.status = 'active';
    user.subscription.startedAt = user.subscription.startedAt || now;
    user.subscription.expiresAt = expiresAt;
    user.subscription.amount = s.subscriptionAmount || user.subscription.amount || 0;
    user.subscription.autoRenew = false;
    user.subscription.history = user.subscription.history || [];
    user.subscription.history.push({
      status: 'granted', amount: 0,
      note: note || `Admin granted ${d} day(s)`, date: now
    });
    _clearAuthUserCache();          // ⭐ NEW
    await user.save();

    res.json({ success: true, message: 'Subscription granted.', user: serializeUser(user) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ---- Admin: revoke ---- */
app.post('/api/admin/subscription/:userId/revoke', requireAdminAuth, async (req, res) => {
  try {
    const { note } = req.body || {};

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (user.subscription && user.subscription.subscriptionId) {
      try { await razorpay.subscriptions.cancel(user.subscription.subscriptionId, false); } catch (e) {}
    }

    if (!user.subscription) user.subscription = {};
    user.subscription.active = false;
    user.subscription.status = 'cancelled';
    user.subscription.autoRenew = false;
    user.subscription.expiresAt = new Date();
    user.subscription.history = user.subscription.history || [];
    user.subscription.history.push({
      status: 'revoked', amount: 0,
      note: note || 'Admin revoked', date: new Date()
    });
    _clearAuthUserCache();          // ⭐ NEW
    await user.save();

    res.json({ success: true, message: 'Subscription revoked.', user: serializeUser(user) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ---- Admin: extend ---- */
app.post('/api/admin/subscription/:userId/extend', requireAdminAuth, async (req, res) => {
  try {
    const { days } = req.body || {};

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const d = parseInt(days, 10) || 30;
    if (!user.subscription) user.subscription = {};
    const base = (user.subscription.expiresAt && new Date(user.subscription.expiresAt) > new Date())
      ? new Date(user.subscription.expiresAt) : new Date();
    user.subscription.expiresAt = new Date(base.getTime() + d * 24 * 60 * 60 * 1000);
    user.subscription.active = true;
    user.subscription.status = 'active';
    user.subscription.history = user.subscription.history || [];
    user.subscription.history.push({
      status: 'granted', amount: 0,
      note: `Extended by ${d} day(s)`, date: new Date()
    });
    _clearAuthUserCache();          // ⭐ NEW
    await user.save();

    res.json({ success: true, message: 'Extended.', user: serializeUser(user) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});
/* ============================================================
   VERIFY PAYMENT
   ============================================================ */
/* ============================================================
   VERIFY RAZORPAY PAYMENT — SECURE VERSION
   ============================================================ */
app.post('/api/verify-payment', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      courseId,
      userId
    } = req.body || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Missing payment verification fields.' });
    }
    if (!courseId || !userId) {
      return res.status(400).json({ success: false, message: 'Missing item or user information.' });
    }
    if (!process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ success: false, message: 'Payment gateway is not configured.' });
    }

    const expectedSign = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');

    if (!safeEqualHex(razorpay_signature, expectedSign)) {
      console.warn('[verify-payment] ❌ Signature mismatch', { razorpay_order_id, userId });
      return res.status(400).json({ success: false, message: 'Invalid payment signature.' });
    }

    let order;
    try {
      order = await razorpay.orders.fetch(razorpay_order_id);
    } catch (e) {
      console.error('[verify-payment] Could not fetch order:', e.message);
      return res.status(400).json({ success: false, message: 'Could not verify order with payment gateway.' });
    }

    const notes = order.notes || {};
    if (String(notes.userId) !== String(userId)) {
      return res.status(403).json({ success: false, message: 'This payment belongs to a different account.' });
    }
    if (String(notes.itemId) !== String(courseId)) {
      return res.status(403).json({ success: false, message: 'This payment is for a different item.' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (!Array.isArray(user.purchases)) user.purchases = [];
    if (!user.purchases.includes(String(courseId))) {
      user.purchases.push(String(courseId));
      await user.save();
      _clearAuthUserCache();   // ⚡ force re-read on next auth-check
      console.log(`[verify-payment] ✅ Unlocked ${courseId} for ${user.username}`);
    } else {
      console.log(`[verify-payment] ℹ️ ${user.username} already owned ${courseId}`);
    }

    res.json({
      success: true,
      message: 'Payment verified successfully!',
      purchases: user.purchases
    });

  } catch (error) {
    console.error('[verify-payment] ❌', error);
    res.status(500).json({ success: false, message: 'Server error while verifying payment.' });
  }
});
/* ============================================================
   RAZORPAY WEBHOOK — Auto-capture payments (ADD THIS BLOCK)
   ============================================================ */
app.post('/api/razorpay-webhook', async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error('[Webhook] ❌ RAZORPAY_WEBHOOK_SECRET not set — rejecting');
      return res.status(500).send('Webhook not configured');
    }

    const signature = req.headers['x-razorpay-signature'];
    if (!signature) {
      console.error('[Webhook] ❌ Missing signature header');
      return res.status(400).send('Missing signature');
    }

    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body));

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (!safeEqualHex(signature, expectedSignature)) {
      console.error('[Webhook] ❌ Invalid signature');
      return res.status(400).send('Invalid signature');
    }

    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); }
    catch (e) { return res.status(400).send('Invalid JSON'); }

    const event = payload.event;
    const data  = payload.payload || {};

    /* ---- Idempotency: bail out if this exact event was already processed ---- */
    const eventId = String(
      payload.event_id ||
      (data.payment && data.payment.entity && data.payment.entity.id) ||
      (data.subscription && data.subscription.entity && data.subscription.entity.id) ||
      (event + ':' + JSON.stringify(payload.created_at || ''))
    );

    try {
      await WebhookEvent.create({ eventId, eventType: event });
    } catch (dupErr) {
      if (dupErr && dupErr.code === 11000) {
        console.log(`[Webhook] ⏭️  Duplicate event ${eventId} (${event}) — skipped`);
        return res.status(200).json({ status: 'ok', duplicate: true });
      }
      console.warn('[Webhook] dedupe check failed (proceeding):', dupErr.message);
    }

    if (event === 'payment.captured') {
      const payment = data.payment && data.payment.entity;
      if (payment && payment.order_id) {
        const orderId = payment.order_id;
        const paymentId = payment.id;
        console.log(`[Webhook] Payment captured: ${paymentId} for order ${orderId}`);

        const order = await razorpay.orders.fetch(orderId);
        const userId = order.notes.userId;
        const itemId = order.notes.itemId;

        if (userId && itemId) {
          const user = await User.findById(userId);
          if (user && !user.purchases.includes(itemId)) {
            user.purchases.push(itemId);
            await user.save();
            console.log(`[Webhook] Unlocked item ${itemId} for user ${userId}`);
          }
        }

        // ---- NEW: one-time subscription purchase (via coupon) ----
        if (userId && order.notes && order.notes.purpose === 'aero-one-time-subscription') {
          const user = await User.findById(userId);
          if (user) {
            const planId = order.notes.planId;
            const durationDays = parseInt(order.notes.durationDays, 10) || 30;
            const now = new Date();
            if (!user.subscription) user.subscription = {};
            const base = (user.subscription.expiresAt && new Date(user.subscription.expiresAt) > now)
              ? new Date(user.subscription.expiresAt) : now;
            user.subscription.active = true;
            user.subscription.status = 'active';
            user.subscription.planId = planId;
            user.subscription.expiresAt = new Date(base.getTime() + durationDays * 24 * 60 * 60 * 1000);
            user.subscription.autoRenew = false;
            user.subscription.paymentMode = 'one-time';
            user.subscription.lastPaymentId = paymentId;
            user.subscription.history = user.subscription.history || [];
            user.subscription.history.push({
              paymentId,
              amount: (payment.amount || 0) / 100,
              status: 'charged',
              note: 'One-time subscription (webhook)',
              date: now
            });
            _clearAuthUserCache();          // ⭐ NEW
            await user.save();
            console.log(`[Webhook] ✅ One-time subscription activated for ${user.username} (${durationDays}d)`);

            // Mark coupon used
            if (order.notes.couponCode) {
              try {
                const coupon = await Coupon.findOne({ code: order.notes.couponCode });
                if (coupon) {
                  coupon.usedCount = (coupon.usedCount || 0) + 1;
                  coupon.usedBy = coupon.usedBy || [];
                  coupon.usedBy.push({
                    userId: String(user._id),
                    userEmail: user.email || '',
                    planId,
                    amountSaved: 0,
                    usedAt: now
                  });
                  await coupon.save();
                }
              } catch (e) { /* silent */ }
            }
          }
        }
      }
    }

    if (event === 'subscription.charged' || event === 'subscription.authenticated') {
      const subEntity = (data.subscription && data.subscription.entity) || {};
      const payEntity = (data.payment && data.payment.entity) || {};
      const notes = subEntity.notes || {};
      const userId = notes.userId;

      if (userId) {
        const user = await User.findById(userId);
        if (user) {
          const now = new Date();

          /* ── FIX: resolve the REAL plan duration instead of hardcoding 30 days.
             Bug: 6-month and 12-month plans were being treated as 30 days
             whenever the payment arrived via the webhook (e.g. user closed
             the browser before the client-side verify ran).               */
          let durationDays = 30;
          try {
            const planIdFromNotes = (notes && notes.planId) || null;
            const s = await getGlobalSettings();
            const matchedPlan = (s.subscriptionPlans || [])
              .find(p => p.id === planIdFromNotes);
            if (matchedPlan && matchedPlan.durationDays) {
              durationDays = matchedPlan.durationDays;
            } else if (user.subscription && user.subscription.planDurationDays) {
              durationDays = user.subscription.planDurationDays;
            }
          } catch (planErr) {
            console.warn('[Webhook] Could not resolve plan duration, using 30d:', planErr.message);
          }

          const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

          if (!user.subscription) user.subscription = {};
          user.subscription.active = true;
          user.subscription.status = 'active';
          user.subscription.subscriptionId = subEntity.id || user.subscription.subscriptionId;
          user.subscription.planId = subEntity.plan_id || user.subscription.planId;
          user.subscription.planDurationDays = durationDays;
          user.subscription.startedAt = user.subscription.startedAt || now;
          user.subscription.expiresAt = expiresAt;
          user.subscription.autoRenew = true;
          if (payEntity.id) user.subscription.lastPaymentId = payEntity.id;
          user.subscription.history = user.subscription.history || [];
          user.subscription.history.push({
            paymentId: payEntity.id || null,
            amount: payEntity.amount ? (payEntity.amount / 100) : 0,
            status: 'charged',
            note: event,
            planDurationDays: durationDays,
            date: now
          });
          _clearAuthUserCache();          // ⭐ NEW
          await user.save();
          console.log(`[Webhook] Subscription ${event} → user ${userId} active for ${durationDays}d, until ${expiresAt.toISOString()}`);
        }
      }
    }

    if (event === 'subscription.cancelled' ||
        event === 'subscription.halted' ||
        event === 'subscription.completed' ||
        event === 'subscription.paused') {
      const subEntity = (data.subscription && data.subscription.entity) || {};
      const notes = subEntity.notes || {};
      const userId = notes.userId;
      if (userId) {
        const user = await User.findById(userId);
        if (user && user.subscription) {
          user.subscription.active = false;
          user.subscription.status = event === 'subscription.halted' ? 'halted' : 'cancelled';
          user.subscription.autoRenew = false;
          user.subscription.history = user.subscription.history || [];
          user.subscription.history.push({
            status: event.replace('subscription.', ''),
            amount: 0,
            note: event,
            date: new Date()
          });
          await user.save();
          console.log(`[Webhook] Subscription ${event} → user ${userId}`);
        }
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('[Webhook] Error:', error);
    res.status(500).json({ status: 'error' });
  }
});

/* ============================================================
   USER DATA
   ============================================================ */
app.post('/api/user/bookmarks/:courseId', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'userId required' });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const cid = req.params.courseId;
    const list = user.bookmarks || [];
    const idx = list.indexOf(cid);
    if (idx >= 0) list.splice(idx, 1); else list.push(cid);
    user.bookmarks = list;
    await user.save();
    res.json({ success: true, bookmarks: list, bookmarked: idx < 0 });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/user/me/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    /* ⚡ Skip the write when the streak day hasn't changed.
       The client hits this endpoint on almost every navigation, so
       we now only persist when today's date differs from the stored
       one. On a typical day this saves ~95% of the writes. */
    if (user.role === 'student' && user.lastActiveDate !== todayStr()) {
      bumpStreak(user);
      try { await user.save(); } catch (e) { /* non-fatal */ }
    }

    res.json({ success: true, user: serializeUser(user) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/user/progress/:courseId/:materialId', async (req, res) => {
  try {
    const { userId, viewed } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'userId required' });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.progress) user.progress = new Map();
    const cid = req.params.courseId;
    const mid = req.params.materialId;
    let arr = user.progress.get(cid) || [];

    const wasAlreadyViewed = arr.includes(mid);

    if (viewed === false) arr = arr.filter(x => x !== mid);
    else if (!wasAlreadyViewed) arr.push(mid);
    user.progress.set(cid, arr);

    let xpResult = null;
    if (viewed !== false) {
      user.lastActivity = { courseId: cid, materialId: mid, timestamp: new Date() };
      bumpStreak(user);
      logActivity(user, { type: 'view', courseId: cid, materialId: mid });

      // ⭐ Award XP only on FIRST completion
      if (!wasAlreadyViewed) {
        xpResult = awardXP(user, 10, 'material-view');

        /* Non-blocking: bump today's views + materialsCompleted counters.
           Fire-and-forget so the response never waits for the DB. */
        DailyUsage.updateOne(
          { userId: String(user._id), date: istDateKey() },
          {
            $inc: { materialsCompleted: 1, views: 1 },
            $setOnInsert: {
              username: user.username || '',
              fullName: user.fullName || '',
              firstSeenAt: new Date()
            }
          },
          { upsert: true }
        ).catch(() => {});
      }
    }

    await user.save();

    res.json({
      success: true,
      progress: Object.fromEntries(user.progress),
      lastActivity: user.lastActivity,
      streakCount: user.streakCount,
      longestStreak: user.longestStreak,
      lastActiveDate: user.lastActiveDate,
      xp: user.xp || 0,
      level: user.level || 1,
      levelInfo: computeLevel(user.xp || 0),
      xpResult
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ============================================================
   NOTIFICATIONS
   ============================================================ */
app.get('/api/user/notifications/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('notifications').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const list = (user.notifications || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 30);
    res.json({ success: true, notifications: list });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/user/notifications/:userId/mark-read', async (req, res) => {
  try {
    const { notifId, all } = req.body;
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (all) user.notifications.forEach(n => { n.read = true; });
    else if (notifId) { const n = user.notifications.find(x => x.id === notifId); if (n) n.read = true; }
    await user.save();
    res.json({ success: true, notifications: user.notifications });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ============================================================
   STUDENTS LIST
   ============================================================ */
app.get('/api/students', requireAdminAuth, async (req, res) => {
  try {
    /* ⚡ Only the fields the admin UI actually renders. Excluding
       activityLog / quizResults / notifications cuts the payload
       from tens of MB down to a few hundred KB. */
    const students = await User.find({ role: 'student' })
      .select('username fullName email phone role createdAt subscription')
      .sort({ createdAt: -1 })
      .lean();

    /* ⭐ PREMIUM-ACCESS FLAGS (admin Students tab search/filter).
       Computed here so the client never has to interpret raw
       subscription state, and so the payload stays small — the
       subscription history array is deliberately NOT shipped. */
    const now = Date.now();
    const studentsOut = students.map(s => {
      const sub = s.subscription || {};
      const expiresMs = sub.expiresAt ? new Date(sub.expiresAt).getTime() : null;
      const premiumActive = !!(sub.active === true && sub.status === 'active' &&
        (expiresMs === null || expiresMs > now));
      return {
        _id: s._id,
        username: s.username,
        fullName: s.fullName,
        email: s.email,
        phone: s.phone,
        role: s.role,
        createdAt: s.createdAt,
        premium: {
          active: premiumActive,
          status: sub.status || 'none',
          expiresAt: sub.expiresAt || null,
          daysLeft: expiresMs === null ? null : Math.ceil((expiresMs - now) / 86400000)
        }
      };
    });

    res.json({ success: true, students: studentsOut });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
/* ============================================================
   VIDEO SESSION — PREMIUM PROTECTED (checks COURSE + MATERIAL)
   ============================================================ */
app.post('/api/materials/:courseId/:materialId/video-session',
  attachUserFromToken,
  async (req, res) => {
  try {
    /* ⚠️ SECURITY: We must NOT trust a client-supplied userId — a
       student could pass another student's _id and stream their
       premium video. The attachUserFromToken middleware reads the
       signed JWT from the Authorization header (added automatically
       by the client-side fetch interceptor) and gives us an
       authoritative req.authUser. */

    if (!mongoose.Types.ObjectId.isValid(req.params.courseId)) {
      return res.status(400).json({ success: false, message: 'Invalid course ID.' });
    }

    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

    const mat = course.materials.id(req.params.materialId);
    if (!mat) return res.status(404).json({ success: false, message: 'Material not found' });
    if (!mat.url) return res.status(400).json({ success: false, message: 'No video URL on this material.' });

    /* ---- Premium gate: EITHER course or material may be premium ---- */
    const isPremiumMat    = mat.isPremium    === true || mat.isPremium    === 'true';
    const isPremiumCourse = course.isPremium === true || course.isPremium === 'true';

    if (isPremiumMat || isPremiumCourse) {
      const user = req.authUser;   // ← authoritative, from the JWT
      if (!user) {
        return res.status(403).json({
          success: false,
          message: 'Purchase or subscription required to watch this video.'
        });
      }

      const ownsCourse   = (user.purchases || []).includes(String(course._id));
      const ownsMaterial = (user.purchases || []).includes(String(mat._id));
      const subscribed   = userHasActiveSubscription(user);
      const isAdminUser  = String(user.role || '').trim().toLowerCase() === 'admin';

      if (!ownsCourse && !ownsMaterial && !subscribed && !isAdminUser) {
        return res.status(403).json({
          success: false,
          message: 'Purchase or subscription required to watch this video.'
        });
      }
    }

    const url = String(mat.url).trim();
    const ytId = extractYouTubeId(url);

    if (ytId) {
      return res.json({
        success: true, kind: 'youtube', videoId: ytId,
        title: mat.title, expiresAt: Date.now() + (2 * 60 * 60 * 1000)
      });
    }

    if (/youtube\.com|youtu\.be/i.test(url)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid YouTube link. Please provide a direct video URL, not a playlist or channel link.'
      });
    }

    if (!/^https?:\/\//i.test(url) && !/^blob:/i.test(url) && !url.startsWith('/uploads/')) {
      return res.status(400).json({ success: false, message: 'Unsupported video URL.' });
    }

    res.json({
      success: true, kind: 'direct', directUrl: url,
      title: mat.title, expiresAt: Date.now() + (2 * 60 * 60 * 1000)
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});


/* ============================================================
   PLAYLISTS
   ============================================================ */
app.post('/api/courses/:courseId/playlists', requireAdminAuth, async (req, res) => {
  try {
    const { title, description, materialIds } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ success: false, message: 'Title is required.' });
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found.' });

    const playlist = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: title.trim(),
      description: (description || '').trim(),
      materialIds: Array.isArray(materialIds) ? materialIds.slice() : [],
      createdAt: new Date()
    };
    course.playlists.push(playlist);
    await course.save();
    cacheClear('courses:');
    res.json({ success: true, message: 'Playlist created.', playlist });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error: ' + e.message }); }
});

app.post('/api/courses/:courseId/playlists/auto-videos', requireAdminAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found.' });

    const videoIds = (course.materials || [])
      .filter(m => m.type === 'video' && (m.url || m.fileData))
      .map(m => m._id.toString());

    if (videoIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No video materials in this course yet.' });
    }

    const playlist = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: (req.body && req.body.title) ? String(req.body.title).trim() : 'All Video Lectures',
      description: 'Auto-generated playlist from all video materials in this course.',
      materialIds: videoIds,
      createdAt: new Date()
    };
    course.playlists.push(playlist);
    await course.save();
    cacheClear('courses:');
    res.json({
      success: true,
      message: 'Auto playlist created with ' + videoIds.length + ' video' + (videoIds.length === 1 ? '' : 's') + '.',
      playlist
    });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error: ' + e.message }); }
});

app.put('/api/courses/:courseId/playlists/:playlistId', requireAdminAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found.' });
    const pl = (course.playlists || []).find(p => p.id === req.params.playlistId);
    if (!pl) return res.status(404).json({ success: false, message: 'Playlist not found.' });
    if (req.body.title !== undefined) pl.title = String(req.body.title).trim();
    if (req.body.description !== undefined) pl.description = String(req.body.description || '').trim();
    if (Array.isArray(req.body.materialIds)) pl.materialIds = req.body.materialIds;
    await course.save();
    cacheClear('courses:');
    res.json({ success: true, message: 'Playlist updated.', playlist: pl });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error: ' + e.message }); }
});

app.delete('/api/courses/:courseId/playlists/:playlistId', requireAdminAuth, async (req, res) => {
  try {
    await Course.findByIdAndUpdate(
      req.params.courseId,
      { $pull: { playlists: { id: req.params.playlistId } } }
    );
    cacheClear('courses:');
    res.json({ success: true, message: 'Playlist deleted.' });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error: ' + e.message }); }
});

app.post('/api/courses/:courseId/playlists/:playlistId/materials', requireAdminAuth, async (req, res) => {
  try {
    const { materialId } = req.body || {};
    if (!materialId) return res.status(400).json({ success: false, message: 'materialId required.' });
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found.' });
    const pl = (course.playlists || []).find(p => p.id === req.params.playlistId);
    if (!pl) return res.status(404).json({ success: false, message: 'Playlist not found.' });
    if (!pl.materialIds.includes(materialId)) pl.materialIds.push(materialId);
    await course.save();
    cacheClear('courses:');
    res.json({ success: true, message: 'Added to playlist.', playlist: pl });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error: ' + e.message }); }
});

app.delete('/api/courses/:courseId/playlists/:playlistId/materials/:materialId', requireAdminAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found.' });
    const pl = (course.playlists || []).find(p => p.id === req.params.playlistId);
    if (!pl) return res.status(404).json({ success: false, message: 'Playlist not found.' });
    pl.materialIds = pl.materialIds.filter(id => id !== req.params.materialId);
    await course.save();
    cacheClear('courses:');
    res.json({ success: true, message: 'Removed from playlist.', playlist: pl });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error: ' + e.message }); }
});
/* ============================================================
   EMAIL REPLY FETCHER (IMAP) — HARDENED
   ------------------------------------------------------------
   Fixes the "Socket timeout" uncaught exception and the
   "Connection not available" spam you saw in error.log.

   Key improvements:
     • Hard timeouts on EVERY phase (connect / greeting / socket)
     • client.on('error') swallows late socket errors (imapflow bug)
     • withTimeout() wrapper guarantees the promise never hangs
     • In-flight guard prevents overlapping runs
     • Finally-block ALWAYS closes the client cleanly
     • Logs one short line on failure, not a full stack
   ============================================================ */

// ⚡ Global safety net — swallows noisy IMAP/TLS socket errors that
//    would otherwise crash the process. Real errors still log.
process.on('uncaughtException', (err) => {
  const msg = String((err && err.message) || err || '');
  if (/Socket timeout|Connection not available|ECONNRESET|EPIPE|ETIMEDOUT/i.test(msg)) {
    console.warn('[uncaughtException] swallowed IMAP/TLS noise:', msg);
    return;
  }
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  const msg = String((reason && reason.message) || reason || '');
  if (/Socket timeout|Connection not available|ECONNRESET|EPIPE|ETIMEDOUT/i.test(msg)) {
    console.warn('[unhandledRejection] swallowed IMAP/TLS noise:', msg);
    return;
  }
  console.error('[unhandledRejection]', reason);
});

const fetchEmailReplies = async () => {
  if (!EMAIL_USER || !EMAIL_PASS) return;
  if (!USE_SMTP) return;

  // In-flight guard: skip if a previous run is still going
  if (fetchEmailReplies._inFlight) {
    console.log('[IMAP] Skipping — previous fetch still in flight');
    return;
  }
  fetchEmailReplies._inFlight = true;

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    logger: false,
    // ⚡ Hard timeouts — Gmail can hang for 60+ s without these
    connectionTimeout: 10000,   // TCP connect
    greetingTimeout:   10000,   // server banner
    socketTimeout:     20000,   // idle socket
    tls: { rejectUnauthorized: false }
  });

  // ⚡ CRITICAL: swallow late socket errors that imapflow leaks
  client.on('error', (err) => {
    console.warn('[IMAP] client error (non-fatal):', (err && err.message) || err);
  });

  try {
    await withTimeout(client.connect(), 15000, 'IMAP connect');

    const lock = await client.getMailboxLock('INBOX');
    try {
      for await (const message of client.fetch(
        { seen: false },
        { envelope: true, source: true }
      )) {
        const parsed = await simpleParser(message.source);

        await EmailReply.create({
          from:    parsed.from?.text || 'Unknown Sender',
          subject: parsed.subject   || '(No Subject)',
          text:    parsed.text || parsed.html || 'No content',
          date:    parsed.date || new Date()
        });

        try {
          await client.messageFlagsAdd(message.uid, ['\\Seen']);
        } catch (_) { /* ignore */ }

        console.log(`[IMAP] Saved reply from: ${parsed.from?.text}`);
      }
    } finally {
      try { lock.release(); } catch (_) {}
    }

    try { await withTimeout(client.logout(), 5000, 'IMAP logout'); } catch (_) {}
  } catch (err) {
    // Short one-liner only — no stack trace
    console.warn('[IMAP] fetch failed (non-fatal):', (err && err.message) || err);
  } finally {
    try { client.close(); } catch (_) {}
    fetchEmailReplies._inFlight = false;
  }
};

/* ============================================================
   IMAP Polling — OFF by default. Set ENABLE_IMAP_POLLING=true
   in .env to re-enable. Manual refresh still works any time.
   ============================================================ */
if (process.env.ENABLE_IMAP_POLLING === 'true') {
  console.log('[IMAP] Polling enabled — every 15 minutes');
  setInterval(() => {
    fetchEmailReplies().catch(err => {
      console.warn('[IMAP] poll failed (non-fatal):', (err && err.message) || err);
    });
  }, 15 * 60 * 1000);
} else {
  console.log('[IMAP] Polling disabled. Set ENABLE_IMAP_POLLING=true to enable auto-polling.');
}

// API Endpoint for admin dashboard
app.get('/api/admin/email-replies', requireAdminAuth, async (req, res) => {
  try {
    // Live IMAP pull ONLY when the admin explicitly asks for a refresh
    if (req.query.refresh === '1' && USE_SMTP) {
      try {
        await withTimeout(fetchEmailReplies(), 15000, 'IMAP refresh');
      } catch (e) {
        console.warn('[IMAP] Live refresh failed (non-fatal):', (e && e.message) || e);
      }
    }
    const replies = await EmailReply.find().sort({ date: -1 }).limit(50).lean();
    res.json({ success: true, replies });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});
/* ============================================================
   DIAGNOSTIC — Admin login transport check
   Open: /api/admin/login-diag        (status only)
   Open: /api/admin/login-diag?send=1 (also sends a real test email)
   ============================================================ */
app.get('/api/admin/login-diag', requireAdminAuth, async (req, res) => {
  const report = {
    ok: true,
    env: {
      BREVO_API_KEY:      !!process.env.BREVO_API_KEY,
      BREVO_SENDER_EMAIL: process.env.BREVO_SENDER_EMAIL || null,
      RESEND_API_KEY:     !!process.env.RESEND_API_KEY,
      EMAIL_USER:         process.env.EMAIL_USER || null,
      EMAIL_PASS:         !!process.env.EMAIL_PASS,
      JWT_SECRET:         !!process.env.JWT_SECRET,
      
      ADMIN_EMAIL:        process.env.ADMIN_EMAIL || null
    },
    transports: { brevo: USE_BREVO, smtp: USE_SMTP, resend: USE_RESEND },
    verify: null,
    adminUser: null,
    sendTest: null
  };

  try {
    report.verify = await transporter.verify();
  } catch (e) {
    report.verify = { ok: false, error: e.message };
    report.ok = false;
  }

  try {
    const admin = await User.findOne({ role: 'admin' }).select('username email').lean();
    if (!admin) {
      report.adminUser = '(no admin exists — run /setup-admin)';
      report.ok = false;
    } else {
      report.adminUser = {
        username: admin.username,
        email: admin.email || '(none — will fall back to ADMIN_EMAIL)'
      };
      if (!admin.email && !process.env.ADMIN_EMAIL) {
        report.adminUser.warning = 'No email anywhere — 2FA can never be delivered.';
        report.ok = false;
      }
    }
  } catch (e) {
    report.adminUser = 'DB error: ' + e.message;
    report.ok = false;
  }

  if (req.query.send === '1' && report.verify && report.verify.ok) {
    try {
      const admin = await User.findOne({ role: 'admin' }).select('email username').lean();
      const to = (admin && admin.email) || process.env.ADMIN_EMAIL;
      if (!to) throw new Error('No recipient address available.');
      await transporter.sendMail({
        to,
        subject: 'Aerospace Portal — Login Diagnostic',
        text: `Diagnostic email sent at ${new Date().toISOString()}.\nIf you received this, 2FA OTP delivery will work.`
      });
      report.sendTest = { ok: true, to };
    } catch (e) {
      report.sendTest = { ok: false, to: null, error: e.message };
      report.ok = false;
    }
  }

  res.json(report);
});

/* ============================================================
   EMAIL SELF-TEST (open in browser to verify sending works)
   ============================================================ */
app.get('/api/admin/test-email', requireAdminAuth, async (req, res) => {
  try {
    const info = await transporter.sendMail({
      to: process.env.EMAIL_USER,
      subject: 'Aero test email',
      text: 'If you received this, email is working. — ' + new Date().toISOString()
    });
    res.json({ success: true, sentTo: process.env.EMAIL_USER, info });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});
/* ============================================================
   ALUMNI & FRIENDS — Public submission + Admin approval
   ------------------------------------------------------------
   Public endpoints (anyone can submit / view approved):
     POST /api/alumni/submit
     GET  /api/alumni
     POST /api/friends/submit
     GET  /api/friends

   Admin endpoints (require adminId):
     GET    /api/admin/community
     PUT    /api/admin/alumni/:id/approve
     PUT    /api/admin/alumni/:id/reject
     DELETE /api/admin/alumni/:id
     PUT    /api/admin/friends/:id/approve
     PUT    /api/admin/friends/:id/reject
     DELETE /api/admin/friends/:id
   ============================================================ */

const communitySubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many submissions. Please try again later.' }
});

/* ---------- Helper: verify admin ---------- */
async function requireAdmin(adminId) {
  if (!adminId) return null;
  const u = await User.findById(adminId).select('role').lean();
  if (!u || String(u.role || '').trim().toLowerCase() !== 'admin') return null;
  return u;
}

/* ---------- Public: Submit alumni ---------- */
app.post('/api/alumni/submit', communitySubmitLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) {
      return res.status(400).json({ success: false, message: 'Name is required.' });
    }
    if (!b.bio || !String(b.bio).trim()) {
      return res.status(400).json({ success: false, message: 'A short bio is required.' });
    }
    const doc = new Alumni({
      name:        String(b.name).trim().slice(0, 80),
      batch:       String(b.batch || '').trim().slice(0, 40),
      degree:      String(b.degree || '').trim().slice(0, 120),
      currentRole: String(b.currentRole || '').trim().slice(0, 120),
      company:     String(b.company || '').trim().slice(0, 120),
      location:    String(b.location || '').trim().slice(0, 100),
      email:       String(b.email || '').trim().slice(0, 200),
      phone:       String(b.phone || '').trim().slice(0, 40),
      linkedin:    String(b.linkedin || '').trim().slice(0, 300),
      bio:         String(b.bio).trim().slice(0, 1500),
      photo:       String(b.photo || '').slice(0, 500),
      status: 'pending'
    });
    await doc.save();
    res.json({ success: true, message: 'Thanks! Your details were submitted. Admin will review soon.' });
  } catch (e) {
    console.error('[alumni/submit]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* ---------- Public: List approved alumni ---------- */
app.get('/api/alumni', async (req, res) => {
  try {
    const alumni = await Alumni.find({ status: 'approved' })
      .select('-email -phone -approvedBy')
      .sort({ approvedAt: -1 })
      .lean();
    res.json({ success: true, alumni });
  } catch (e) {
    console.error('[alumni/list]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* ---------- Public: Submit friend ---------- */
app.post('/api/friends/submit', communitySubmitLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) {
      return res.status(400).json({ success: false, message: 'Name is required.' });
    }
    if (!b.role || !String(b.role).trim()) {
      return res.status(400).json({ success: false, message: 'Role is required.' });
    }
    const doc = new Friend({
      name:     String(b.name).trim().slice(0, 80),
      role:     String(b.role).trim().slice(0, 120),
      bio:      String(b.bio || '').trim().slice(0, 800),
      email:    String(b.email || '').trim().slice(0, 200),
      phone:    String(b.phone || '').trim().slice(0, 40),
      linkedin: String(b.linkedin || '').trim().slice(0, 300),
      photo:    String(b.photo || '').slice(0, 500),
      status: 'pending'
    });
    await doc.save();
    res.json({ success: true, message: 'Thanks for joining! Admin will verify and publish soon.' });
  } catch (e) {
    console.error('[friends/submit]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* ---------- Public: List approved friends ---------- */
app.get('/api/friends', async (req, res) => {
  try {
    const friends = await Friend.find({ status: 'approved' })
      .select('-email -phone -approvedBy')
      .sort({ approvedAt: -1 })
      .lean();
    res.json({ success: true, friends });
  } catch (e) {
    console.error('[friends/list]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* ---------- Admin: List all community entries ---------- */
app.get('/api/admin/community', requireAdminAuth, async (req, res) => {
  try {

    const alumni  = await Alumni.find().sort({ submittedAt: -1 }).lean();
    const friends = await Friend.find().sort({ submittedAt: -1 }).lean();
    res.json({ success: true, alumni, friends });
  } catch (e) {
    console.error('[admin/community]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* ---------- Admin: Approve / Reject / Delete ALUMNI ---------- */
app.put('/api/admin/alumni/:id/approve', requireAdminAuth, async (req, res) => {
  try {
    const doc = await Alumni.findByIdAndUpdate(
      req.params.id,
      { status: 'approved', approvedAt: new Date(), approvedBy: String(req.adminUser._id) },
      { new: true }
    );
    if (!doc) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: 'Alumni approved.' });
  } catch (e) {
    console.error('[admin/alumni/approve]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.put('/api/admin/alumni/:id/reject', requireAdminAuth, async (req, res) => {
  try {
    const doc = await Alumni.findByIdAndUpdate(
      req.params.id,
      { status: 'rejected', approvedAt: null },
      { new: true }
    );
    if (!doc) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: 'Alumni rejected.' });
  } catch (e) {
    console.error('[admin/alumni/reject]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.delete('/api/admin/alumni/:id', requireAdminAuth, async (req, res) => {
  try {
    await Alumni.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Alumni deleted.' });
  } catch (e) {
    console.error('[admin/alumni/delete]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* ---------- Admin: Approve / Reject / Delete FRIEND ---------- */
app.put('/api/admin/friends/:id/approve', requireAdminAuth, async (req, res) => {
  try {
    const doc = await Friend.findByIdAndUpdate(
      req.params.id,
      { status: 'approved', approvedAt: new Date(), approvedBy: String(req.adminUser._id) },
      { new: true }
    );
    if (!doc) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: 'Friend approved.' });
  } catch (e) {
    console.error('[admin/friends/approve]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.put('/api/admin/friends/:id/reject', requireAdminAuth, async (req, res) => {
  try {
    const doc = await Friend.findByIdAndUpdate(
      req.params.id,
      { status: 'rejected', approvedAt: null },
      { new: true }
    );
    if (!doc) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: 'Friend rejected.' });
  } catch (e) {
    console.error('[admin/friends/reject]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.delete('/api/admin/friends/:id', requireAdminAuth, async (req, res) => {
  try {
    await Friend.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Friend deleted.' });
  } catch (e) {
    console.error('[admin/friends/delete]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});
/* ============================================================
   STUDENT FEEDBACK SYSTEM  (with admin moderation)
   ============================================================ */
const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many feedback submissions. Please try again later.' }
});

/* Public: submit feedback (goes in as `pending`) */
app.post('/api/feedback/submit', feedbackLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.message || !String(b.message).trim()) {
      return res.status(400).json({ success: false, message: 'Feedback message is required.' });
    }
    const doc = new Feedback({
      studentName:     String(b.studentName     || '').trim().slice(0, 80),
      studentUsername: String(b.studentUsername || '').trim().slice(0, 60),
      studentEmail:    String(b.studentEmail    || '').trim().slice(0, 200),
      courseId:        b.courseId ? String(b.courseId) : null,
      courseName:      String(b.courseName || '').trim().slice(0, 200),
      rating:          Math.min(5, Math.max(1, parseInt(b.rating, 10) || 5)),
      title:           String(b.title || '').trim().slice(0, 120),
      message:         String(b.message).trim().slice(0, 2000),
      status: 'pending'
    });
    await doc.save();
    res.json({ success: true, message: 'Thanks! Your feedback was submitted for review.' });
  } catch (e) {
    console.error('[feedback/submit]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* Public: list APPROVED feedback only */
app.get('/api/feedback', async (req, res) => {
  try {
    const list = await Feedback.find({ status: 'approved' })
      .select('-studentEmail -approvedBy')
      .sort({ approvedAt: -1 })
      .limit(60)
      .lean();
    res.json({ success: true, feedback: list });
  } catch (e) {
    console.error('[feedback/list]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* Admin: list everything */
app.get('/api/admin/feedback', requireAdminAuth, async (req, res) => {
  try {
    const list = await Feedback.find().sort({ submittedAt: -1 }).limit(500).lean();
    res.json({ success: true, feedback: list });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* Admin: approve */
app.put('/api/admin/feedback/:id/approve', requireAdminAuth, async (req, res) => {
  try {
    const doc = await Feedback.findByIdAndUpdate(
      req.params.id,
      { status: 'approved', approvedAt: new Date(), approvedBy: String(req.adminUser._id) },
      { new: true }
    );
    if (!doc) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: 'Feedback approved.' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* Admin: reject */
app.put('/api/admin/feedback/:id/reject', requireAdminAuth, async (req, res) => {
  try {
    const doc = await Feedback.findByIdAndUpdate(
      req.params.id,
      { status: 'rejected', approvedAt: null },
      { new: true }
    );
    if (!doc) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, message: 'Feedback rejected.' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* Admin: delete */
app.delete('/api/admin/feedback/:id', requireAdminAuth, async (req, res) => {
  try {
    await Feedback.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Feedback deleted.' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});


/* ============================================================
   STUDENT CONTRIBUTION PORTAL
   ============================================================ */
const contributionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many uploads. Please try again later.' }
});

/* Student: submit a contribution (file already uploaded via /api/upload) */
app.post('/api/contributions/submit', contributionLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) {
      return res.status(400).json({ success: false, message: 'Title is required.' });
    }
    if (!b.fileUrl) {
      return res.status(400).json({ success: false, message: 'A file is required.' });
    }
    const doc = new Contribution({
      studentName:     String(b.studentName     || '').trim().slice(0, 80),
      studentUsername: String(b.studentUsername || '').trim().slice(0, 60),
      studentEmail:    String(b.studentEmail    || '').trim().slice(0, 200),
      title:           String(b.title).trim().slice(0, 160),
      description:     String(b.description || '').trim().slice(0, 1000),
      subject:         String(b.subject || '').trim().slice(0, 120),
      fileUrl:         String(b.fileUrl).slice(0, 1000),
      cloudUrl:        String(b.cloudUrl || '').slice(0, 1000),
      diskName:        String(b.diskName || '').slice(0, 260),
      fileName:        String(b.fileName || '').trim().slice(0, 260),
      fileSize:        Number(b.fileSize) || 0,
      fileType:        String(b.fileType || '').slice(0, 120),
      cloudinaryPublicId: String(b.cloudinaryPublicId || '').slice(0, 300),
      status: 'pending'
    });
    await doc.save();
    res.json({ success: true, message: 'Contribution submitted! The admin will review it.' });
  } catch (e) {
    console.error('[contributions/submit]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* Student: list own contributions */
app.get('/api/contributions/mine/:username', async (req, res) => {
  try {
    const username = String(req.params.username || '').toLowerCase();
    if (!username) return res.json({ success: true, contributions: [] });
    const list = await Contribution.find({ studentUsername: username })
      .select('-cloudinaryPublicId')
      .sort({ submittedAt: -1 })
      .limit(50)
      .lean();
    res.json({ success: true, contributions: list });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* Admin: list all contributions */
app.get('/api/admin/contributions', requireAdminAuth, async (req, res) => {
  try {
    const list = await Contribution.find().sort({ submittedAt: -1 }).limit(500).lean();
    res.json({ success: true, contributions: list });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* ============================================================
   ADMIN — Download a contribution
   ------------------------------------------------------------
   Source order (first hit wins):
     1. Local disk  (UPLOAD_DIR/<filename from fileUrl>)
     2. Cloudinary signed private_download_url
     3. Any absolute URL stored on the doc (cloudUrl / fileUrl)
   On a successful Cloudinary fetch, the file is cached to disk
   so the next request is instant.
   ============================================================ */
app.get('/api/admin/contributions/:id/download', requireAdminAuth, async (req, res) => {
  try {
    const doc = await Contribution.findById(req.params.id).lean();
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Contribution not found.' });
    }

    // ---- Safe attachment filename ----
    const safeName = String(doc.fileName || 'contribution')
      .replace(/["\\\r\n]/g, '')
      .slice(0, 200) || 'contribution';

    // ---- Content-Type from extension ----
    const ext = (path.extname(doc.fileName || doc.fileUrl || '') || '').toLowerCase();
    const MIME_MAP = {
      '.pdf':  'application/pdf',
      '.doc':  'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.ppt':  'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.xls':  'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.txt':  'text/plain; charset=utf-8',
      '.csv':  'text/csv; charset=utf-8',
      '.zip':  'application/zip',
      '.jpg':  'image/jpeg', '.jpeg': 'image/jpeg',
      '.png':  'image/png',  '.webp': 'image/webp', '.gif': 'image/gif',
      '.mp4':  'video/mp4',  '.webm': 'video/webm', '.mov': 'video/quicktime',
      '.avi':  'video/x-msvideo', '.mkv': 'video/x-matroska',
      '.mp3':  'audio/mpeg', '.wav':  'audio/wav',  '.ogg': 'audio/ogg'
    };
    const contentType = MIME_MAP[ext] || doc.fileType || 'application/octet-stream';

    const markDownloaded = () => {
      Contribution.findByIdAndUpdate(doc._id, {
        status: 'downloaded',
        downloadedAt: new Date()
      }).catch(e => console.warn('[contribution/download] status update failed:', e.message));
    };

    // ─── Step 1: local disk ───────────────────────────────────
    // The stored fileUrl is '/uploads/<actual-filename>' — extract it.
    let diskFilename = null;
    const urlMatch = String(doc.fileUrl || '').match(/\/uploads\/([^/?#]+)$/);
    if (urlMatch && urlMatch[1]) {
      diskFilename = path.basename(urlMatch[1]);   // sanitize against traversal
    }

    if (diskFilename) {
      const diskPath = path.join(UPLOAD_DIR, diskFilename);
      if (fs.existsSync(diskPath)) {
        console.log('[contribution/download] ✅ disk hit:', diskFilename);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        markDownloaded();
        return fs.createReadStream(diskPath).pipe(res);
      }
      console.log('[contribution/download] 💾 disk miss:', diskFilename);
    }

    // ─── Step 2/3: Cloudinary ─────────────────────────────────
    const candidates = [];

    if (doc.cloudinaryPublicId) {
      try {
        // Cloudinary stores PDFs as resource_type "image" by default.
        let rt = 'image';
        const url   = String(doc.fileUrl || '');
        const fname = String(doc.fileName || '').toLowerCase();

        if (/\/video\/upload\//.test(url) || /\.(mp4|webm|mov|avi|mkv|mp3|wav|ogg)$/.test(fname)) rt = 'video';
        else if (/\/raw\/upload\//.test(url) || /\.(docx?|pptx?|xlsx?|txt|csv|zip|ppt|doc|xls)$/.test(fname)) rt = 'raw';
        else if (/\.pdf$/i.test(fname)) rt = 'image';

        const format = (doc.fileName || '').split('.').pop() || '';
        const signedUrl = cloudinary.utils.private_download_url(
          doc.cloudinaryPublicId,
          format,
          {
            resource_type: rt,
            type: 'upload',
            expires_at: Math.floor(Date.now() / 1000) + 300
          }
        );
        candidates.push({ name: 'cloudinary-signed(' + rt + ')', url: signedUrl });
      } catch (e) {
        console.warn('[contribution/download] signed URL build failed:', e.message);
      }
    }

    // Node fetch needs an absolute URL — only push https:// values.
    for (const u of [doc.cloudUrl, doc.fileUrl]) {
      if (u && /^https?:\/\//i.test(u)) {
        candidates.push({ name: 'stored-url', url: u });
        break;
      }
    }

    let response = null;
    let usedName = '';

    for (const c of candidates) {
      try {
        console.log(`[contribution/download] trying ${c.name}: ${c.url.slice(0, 120)}…`);
        const r = await fetch(c.url, { redirect: 'follow' });
        if (r.ok) {
          response = r;
          usedName = c.name;
          console.log(`[contribution/download] ✅ ${c.name} → HTTP ${r.status}`);
          break;
        }
        console.warn(`[contribution/download] ❌ ${c.name} → HTTP ${r.status}`);
      } catch (e) {
        console.warn(`[contribution/download] ❌ ${c.name} → ${e.message}`);
      }
    }

    if (!response) {
      console.error('[contribution/download] no source returned a file');
      return res.status(404).json({
        success: false,
        message: 'Could not locate this file. It may have been removed from both disk and backup storage.'
      });
    }

    // Stream directly to client instead of buffering into memory
    const { Readable } = require('stream');
    const contentLength = response.headers.get('content-length');
    
    res.setHeader('Content-Type', response.headers.get('content-type') || contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');

    markDownloaded();

    // Convert Web Stream to Node Stream and pipe directly to the client.
    // (We intentionally do NOT buffer the whole file into memory — large
    //  contributions are streamed chunk-by-chunk straight through.)
    Readable.fromWeb(response.body).pipe(res);
    console.log(`[contribution/download] ✅ streaming via ${usedName}`);
  } catch (e) {
    console.error('[admin/contributions/download] fatal:', e);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Server error: ' + e.message });
    }
  }
});

/* Admin: delete a contribution (from Cloudinary AND DB) */
app.delete('/api/admin/contributions/:id', requireAdminAuth, async (req, res) => {
  try {
    const doc = await Contribution.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: 'Not found.' });

    if (doc.cloudinaryPublicId) {
      try {
        let rt = 'image';
        if (/\/video\/upload\//.test(doc.fileUrl))     rt = 'video';
        else if (/\/raw\/upload\//.test(doc.fileUrl))  rt = 'raw';
        else if (/\.(mp4|webm|mov|avi|mkv)$/i.test(doc.fileName || '')) rt = 'video';
        else if (/\.(pdf|docx?|pptx?|xlsx?|txt|csv|zip)$/i.test(doc.fileName || '')) rt = 'raw';
        await cloudinary.uploader.destroy(doc.cloudinaryPublicId, { resource_type: rt });
      } catch (e) {
        console.warn('[contribution delete] cloudinary destroy failed:', e.message);
      }
    }

    await Contribution.findByIdAndDelete(doc._id);
    res.json({ success: true, message: 'Contribution deleted from platform.' });
  } catch (e) {
    console.error('[admin/contributions/delete]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});


/* ============================================================
   STUDENT DATA BACKUP — CSV EXPORT / IMPORT
   ============================================================ */
const csvBackupUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function parseCSV(text) {
  const rows = [];
  let cur = [], field = '', inQuotes = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++;
    } else {
      if (c === '"')       { inQuotes = true; i++; continue; }
      if (c === ',')       { cur.push(field); field = ''; i++; continue; }
      if (c === '\r')      { i++; continue; }
      if (c === '\n')      { cur.push(field); rows.push(cur); cur = []; field = ''; i++; continue; }
      field += c; i++;
    }
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  return rows;
}

/* Admin: export students to CSV */
app.get('/api/admin/students/export-csv', requireAdminAuth, async (req, res) => {
  try {
    const students = await User.find({ role: 'student' })
      .select('username password role fullName email phone createdAt')
      .sort({ createdAt: 1 })
      .lean();

    const header = ['username', 'passwordHash', 'role', 'fullName', 'email', 'phone', 'createdAt'];
    const lines  = [header.join(',')];

    students.forEach(s => {
      lines.push([
        csvEscape(s.username),
        csvEscape(s.password),
        csvEscape(s.role || 'student'),
        csvEscape(s.fullName || ''),
        csvEscape(s.email || ''),
        csvEscape(s.phone || ''),
        csvEscape(s.createdAt ? new Date(s.createdAt).toISOString() : '')
      ].join(','));
    });

    const csv = '\uFEFF' + lines.join('\n');
    const filename = `aero-students-backup-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader('Access-Control-Expose-Headers', 'X-Aero-Preview-Percent, X-Aero-Preview-Mode');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (e) {
    console.error('[admin/students/export-csv]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* Admin: import students from CSV */
app.post('/api/admin/students/import-csv',
  requireAdminAuth,
  csvBackupUpload.single('csvFile'),
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ success: false, message: 'CSV file is required.' });
      }
      let csvText = req.file.buffer.toString('utf8');
      if (csvText.charCodeAt(0) === 0xFEFF) csvText = csvText.slice(1);

      const rows = parseCSV(csvText).filter(r => r.length > 0 && (r.length > 1 || (r[0] || '').trim()));
      if (rows.length < 2) {
        return res.status(400).json({ success: false, message: 'CSV must contain a header and at least one row.' });
      }

      const header = rows[0].map(h => h.trim().toLowerCase());
      const idx = {
        username:     header.indexOf('username'),
        passwordHash: header.indexOf('passwordhash') >= 0 ? header.indexOf('passwordhash') : header.indexOf('password'),
        role:         header.indexOf('role'),
        fullName:     header.indexOf('fullname'),
        email:        header.indexOf('email'),
        phone:        header.indexOf('phone'),
        createdAt:    header.indexOf('createdat')
      };

      if (idx.username === -1 || idx.passwordHash === -1) {
        return res.status(400).json({
          success: false,
          message: 'CSV must include "username" and "passwordHash" columns.'
        });
      }

      let created = 0, updated = 0, skipped = 0;
      const errors = [];

      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length === 0) continue;

        const username     = (r[idx.username]     || '').trim().toLowerCase();
        const passwordHash = (r[idx.passwordHash] || '').trim();

        if (!username || !passwordHash) { skipped++; continue; }

        try {
          const existing = await User.findOne({ username });
          const update = {
            password: passwordHash,
            role:     (idx.role     >= 0 ? (r[idx.role] || 'student').trim().toLowerCase() : 'student') || 'student',
            fullName: (idx.fullName >= 0 ? (r[idx.fullName] || '').trim() : ''),
            email:    (idx.email    >= 0 ? (r[idx.email]    || '').trim() : ''),
            phone:    (idx.phone    >= 0 ? (r[idx.phone]    || '').trim() : '')
          };
          if (existing) {
            await User.updateOne({ _id: existing._id }, { $set: update });
            updated++;
          } else {
            const doc = new User({ username, ...update });
            if (idx.createdAt >= 0 && r[idx.createdAt]) {
              const d = new Date(r[idx.createdAt]);
              if (!isNaN(d)) doc.createdAt = d;
            }
            await doc.save();
            created++;
          }
        } catch (e) {
          errors.push({ row: i + 1, username, error: e.message });
        }
      }

      res.json({
        success: true,
        message: `Import complete — ${created} created, ${updated} updated, ${skipped} skipped.`,
        created, updated, skipped, errors
      });
    } catch (e) {
      console.error('[admin/students/import-csv]', e);
      res.status(500).json({ success: false, message: 'Server error: ' + e.message });
    }
  }
);

/* ============================================================
   ADMIN — LIVE ACTIVITY DASHBOARD
   ------------------------------------------------------------
   Shows who's online now, recent logins, and recent actions.
   ============================================================ */
app.get('/api/admin/live-activity', requireAdminAuth, async (req, res) => {
  try {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const [totalStudents, activeSessions, recentLogins] = await Promise.all([
      User.countDocuments({ role: 'student' }),

      User.find({ role: 'student', 'activeSession.lastSeenAt': { $gte: fiveMinAgo } })
        .select('username fullName email activeSession lastActivity')
        .sort({ 'activeSession.lastSeenAt': -1 })
        .limit(50)
        .lean(),

      User.find({ role: 'student', 'activeSession.loginAt': { $gte: oneHourAgo } })
        .select('username fullName email activeSession')
        .sort({ 'activeSession.loginAt': -1 })
        .limit(50)
        .lean()
    ]);

    const users = await User.find({ role: 'student' })
      .select('username fullName activityLog')
      .lean();

    const recentActivity = [];
    users.forEach(u => {
      (u.activityLog || []).forEach(a => {
        const ts = new Date(a.timestamp);
        if (ts >= oneHourAgo) {
          recentActivity.push({
            username: u.username,
            fullName: u.fullName || '',
            type: a.type,
            courseId: a.courseId,
            materialId: a.materialId,
            score: a.score,
            total: a.total,
            timestamp: a.timestamp
          });
        }
      });
    });
    recentActivity.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    recentActivity.length = Math.min(recentActivity.length, 60);

    res.json({
      success: true,
      stats: {
        totalStudents,
        activeNow: activeSessions.length,
        loginsLastHour: recentLogins.length
      },
      activeSessions,
      recentLogins,
      recentActivity
    });
  } catch (e) {
    console.error('[admin/live-activity]', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ============================================================
   AI DOUBT SOLVER — Google Gemini API
   ------------------------------------------------------------
   • Primary model:  gemini-2.5-pro    (best reasoning quality)
   • Fallback chain: gemini-2.5-flash → gemini-2.0-flash
   • SDK:            @google/genai v2.x
   • Requires:       GEMINI_API_KEY in .env
   ============================================================ */

/* ---- Rate limiter — 10 requests / minute, per-user when possible ---- */
const aiDoubtLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Prefer userId (from body) → per-user limit. Fall back to IP.
  // This stops one abusive student from rate-limiting the whole hostel/campus.
  keyGenerator: (req) => {
    try {
      if (req.body && req.body.userId) return 'u:' + String(req.body.userId).slice(0, 60);
      const auth = req.headers.authorization || '';
      if (auth.startsWith('Bearer ')) {
        const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
        if (decoded && decoded.id) return 'u:' + String(decoded.id);
      }
    } catch (e) { /* invalid token — fall through to IP */ }
    return 'ip:' + (req.ip || 'anon');
  },
  message: { success: false, message: 'Too many AI requests. Please wait a minute.' }
});

/* ---- Lazy singleton Gemini client ---- */
let _geminiClient = null;
function getGeminiClient() {
  if (_geminiClient) return _geminiClient;

  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('Gemini is not configured. Missing GEMINI_API_KEY.');
  }

  _geminiClient = new GoogleGenAI({ apiKey });
  console.log('[ai] ✅ Gemini client ready · key:', apiKey.slice(0, 8) + '…');
  return _geminiClient;
}

/* ============================================================
   POST /api/ai/solve-doubt
   Body:    { question: string, courseId?: string }
   Returns: { success: true, answer: string, model: string }
   ============================================================ */
app.post('/api/ai/solve-doubt', aiDoubtLimiter, async (req, res) => {
  try {
    const { question, courseId } = req.body || {};

    /* ---------- 1. Validation ---------- */
    if (!question || !String(question).trim()) {
      return res.status(400).json({ success: false, message: 'Question is required.' });
    }
    if (String(question).length > 2000) {
      return res.status(400).json({ success: false, message: 'Question too long (max 2000 chars).' });
    }
    if (!process.env.GEMINI_API_KEY) {
      console.error('[ai] ❌ GEMINI_API_KEY is not set');
      return res.status(500).json({
        success: false,
        message: 'AI is not configured. Please ask the admin to set GEMINI_API_KEY.'
      });
    }

    /* ---------- 2. Optional course context (RAG-lite) ---------- */
    let contextBlock = '';
    if (courseId) {
      try {
        const course = await Course.findById(courseId)
          .select('name code description materials.title materials.description materials.type')
          .lean();
        if (course) {
          const matList = (course.materials || [])
            .slice(0, 20)
            .map(m => `- ${m.title} (${m.type}): ${(m.description || '').slice(0, 120)}`)
            .join('\n');
          contextBlock =
            `Course: ${course.name} (${course.code})\n` +
            `Description: ${(course.description || '').slice(0, 400)}\n` +
            `Available materials:\n${matList}\n`;
        }
      } catch (e) {
        console.warn('[ai/solve-doubt] Course fetch failed:', e.message);
      }
    }

    /* ---------- 3. System instruction ---------- */
    const systemInstruction =
      'You are an expert teaching assistant for the Aerospace Department at IIT Kharagpur. ' +
      'Answer questions in a clear, student-friendly way. Use simple language and real-world analogies. ' +
      'For math/physics, show the derivation step-by-step. ' +
      'If you do not know something, say so honestly. ' +
      'Keep answers focused (under 400 words unless a derivation needs more). ' +
      'Use Markdown (bold, bullet lists, tables, code blocks). ' +
      'Use LaTeX with $...$ for inline math and $$...$$ for display math. ' +
      'Format your response in clean, readable Markdown.';

    /* ---------- 4. User prompt ---------- */
    const userPrompt = contextBlock
      ? `${contextBlock}\nStudent's doubt: ${question}`
      : `Student's doubt: ${question}`;

    /* ---------- 5. Model fallback chain (auto-discovered) ---------- */
    // Ask Google what models your key can actually use.
    // Cache the result for 10 minutes so we don't hit the API every request.
    let MODELS = [];
    try {
      const now = Date.now();
      if (!global.__aeroAiModelCache || (now - global.__aeroAiModelCache.at) > 10 * 60 * 1000) {
        const listResp = await getGeminiClient().models.list();
        const discovered = [];
        for await (const m of listResp) {
          const raw = String(m.name || '');           // e.g. "models/gemini-2.5-flash"
          const id  = raw.replace(/^models\//, '');
          if (!id) continue;
          // Only keep generateContent-capable gemini models
          const methods = m.supportedActions || m.supportedGenerationMethods || [];
          const canGenerate = Array.isArray(methods)
            ? methods.some(x => /generateContent/i.test(x))
            : true;
          if (canGenerate && /^gemini/i.test(id)) discovered.push(id);
        }
        // Prefer pro > flash > any
        discovered.sort((a, b) => {
          const rank = s => /pro/.test(s) ? 3 : /flash/.test(s) ? 2 : 1;
          return rank(b) - rank(a);
        });
        global.__aeroAiModelCache = { at: now, models: discovered };
        console.log('[ai] Discovered models:', discovered.join(', '));
      }
      MODELS = global.__aeroAiModelCache.models || [];
    } catch (e) {
      console.warn('[ai] Model discovery failed, using static fallback:', e.message);
      MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
    }

    if (MODELS.length === 0) {
      return res.status(503).json({
        success: false,
        message: 'AI is not configured — no usable Gemini models were found for this API key.'
      });
    }

    let answer = null;
    let usedModel = null;
    let lastError = null;

    const ai = getGeminiClient();

    for (const model of MODELS) {
      try {
        console.log(`[ai] Trying model: ${model}`);
        const t0 = Date.now();

        const response = await ai.models.generateContent({
          model,
          contents: userPrompt,
          config: {
            systemInstruction,
            temperature: 0.5,
            maxOutputTokens: 2048
          }
        });

        // @google/genai v2.x — `response.text` is a getter, not a function.
        const text = typeof response.text === 'function'
          ? response.text()
          : response.text;

        if (text && String(text).trim()) {
          answer = String(text).trim();
          usedModel = model;
          console.log(`[ai] ✅ ${model} succeeded (${answer.length} chars in ${Date.now() - t0}ms)`);
          break;
        }

        console.warn(`[ai] Model "${model}" returned empty text`);
        lastError = { model, message: 'Empty response' };
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        const status = err && (err.status || err.statusCode || (err.error && err.error.code));
        console.error(`[ai] ❌ Model "${model}" failed:`, msg);
        lastError = { model, message: msg, status };
      }
    }

    /* ---------- 6. Friendly failure ---------- */
    if (!answer) {
      let friendly = 'AI is temporarily unavailable. Please try again in a moment.';
      if (lastError) {
        const status = lastError.status;
        const msg = String(lastError.message || '');
        if (status === 401 || status === 403) {
          friendly = 'AI authentication failed. Please ask the admin to verify GEMINI_API_KEY.';
        } else if (status === 429) {
          friendly = 'AI rate limit reached. Please wait a minute and try again.';
        } else if (status === 400) {
          friendly = 'AI could not process that request. Try rephrasing your question.';
        } else if (status === 404) {
          friendly = 'AI model unavailable. Please contact admin to update the model name.';
        } else if (/network|fetch|ENOTFOUND|ETIMEDOUT|ECONNREFUSED/i.test(msg)) {
          friendly = 'Network error reaching the AI service. Check the server internet connection.';
        } else if (/api key|API_KEY_INVALID|invalid.*key/i.test(msg)) {
          friendly = 'AI API key is invalid. Please ask the admin to check GEMINI_API_KEY.';
        }
      }
      return res.status(503).json({ success: false, message: friendly });
    }

    /* ---------- 7. Success ---------- */
    return res.json({
      success: true,
      answer,
      model: usedModel
    });

  } catch (e) {
    console.error('[ai/solve-doubt] Fatal:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});
/* ============================================================
   ════════════════════════════════════════════════════════════
   /* ============================================================
   ════════════════════════════════════════════════════════════
   LIVE ACTIVITY TRACKING — v3 (Clean, Memory-Safe, Real-Time)
   ════════════════════════════════════════════════════════════
   Single source of truth for who's online, what they're doing,
   how long they've been doing it, and durable daily rollups.

   MEMORY DESIGN (hard limits):
     • onlineUsers Map       — one entry per connected user, ~400 B
     • sessionSeconds        — per entry, bounded accumulator
     • courseSeconds         — per entry, top-30 courses only (trimmed)
     • materialSeconds       — per entry, top-30 materials only (trimmed)
     • DailyUsage            — 1 doc per (user, day), TTL 180 days
     • SSE clients           — capped at 8 concurrent admin streams
     • Broadcast throttle    — max 1 push per 800 ms across ALL clients

   DATA FLOW:
     client heartbeat (20 s) → /api/heartbeat
       → onlineUsers Map (live)                    ← used by SSE
       → flush every 5 min  → DailyUsage (durable) ← used by reports
     client tab-close        → /api/heartbeat/offline
       → immediate flush + delete from Map
   ============================================================ */
/* ============================================================
   LIVE ACTIVITY CONFIG
   ============================================================ */
const ONLINE_WINDOW_MS     = 90 * 1000;
const ONLINE_CLEANUP_MS    = 20 * 1000;
const BROADCAST_MIN_MS     = 800;
const MAX_SSE_CLIENTS      = 8;
const HEARTBEAT_MAX_DELTA  = 60;
const FLUSH_EVERY_SEC      = 300;
const MAX_MAP_KEYS         = 30;
const MAX_RECENT_ACTIONS   = 5;   // per online user — for the "recent" trail

const onlineUsers = new Map();
const sseClients  = new Set();
const sseClientsLock = { locked: false, again: false };

/* ------------------------------------------------------------
   parseDeviceInfo — lightweight UA parser (no deps)
   ------------------------------------------------------------ */
function parseDeviceInfo(ua) {
  const s = String(ua || '').toLowerCase();
  let device = 'desktop';
  let os = 'Unknown';
  let browser = 'Unknown';

  if (/ipad|tablet|playbook|silk/.test(s) || (/android/.test(s) && !/mobile/.test(s))) device = 'tablet';
  else if (/mobile|iphone|ipod|android.*mobile|windows phone|blackberry/.test(s)) device = 'mobile';

  if (/iphone|ipad|ipod/.test(s)) os = 'iOS';
  else if (/android/.test(s)) os = 'Android';
  else if (/windows/.test(s)) os = 'Windows';
  else if (/macintosh|mac os x/.test(s)) os = 'macOS';
  else if (/linux/.test(s)) os = 'Linux';

  if (/edg\//.test(s)) browser = 'Edge';
  else if (/opr\/|opera/.test(s)) browser = 'Opera';
  else if (/chrome/.test(s) && !/edg\//.test(s)) browser = 'Chrome';
  else if (/firefox/.test(s)) browser = 'Firefox';
  else if (/safari/.test(s) && !/chrome/.test(s)) browser = 'Safari';

  return { device, os, browser };
}

/* ------------------------------------------------------------
   classifyAction — human-friendly label from (currentPage, material)
   ------------------------------------------------------------
   IMPORTANT: Page slugs are matched with EXACT strings, not
   `includes()`, because "course-detail" contains "ai" as a
   substring and would falsely match the AI-Solver branch.
   ------------------------------------------------------------ */
function classifyAction(entry) {
  const p = String(entry.currentPage || '').toLowerCase();

  /* ---- Media viewers (highest priority) ---- */
  if (p === 'viewing-pdf')   return { kind: 'reading', label: 'Reading PDF' };
  if (p === 'viewing-video') return { kind: 'video',   label: 'Watching video' };

  /* ---- Admin pages ---- */
  if (p === 'admin-quiz-editor')       return { kind: 'author',    label: 'Editing a quiz' };
  if (p.startsWith('admin-'))          return { kind: 'admin',     label: 'Admin work' };

  /* ---- Analytics ---- */
  if (p === 'analytics' || p === 'student-analytics') {
    return { kind: 'analytics', label: 'Viewing analytics' };
  }

  /* ---- AI Solver ---- */
  if (p === 'ai' || p === 'student-ai') {
    return { kind: 'ai', label: 'Using AI Solver' };
  }

  /* ---- Course detail ---- */
  if (p === 'course-detail' || entry.courseId) {
    if (entry.courseId && entry.materialId) {
      return { kind: 'reading', label: 'Studying material' };
    }
    return { kind: 'reading', label: 'In a course' };
  }

  /* ---- Browsing ---- */
  if (p === 'courses' || p === 'student-courses') {
    return { kind: 'browse', label: 'Browsing courses' };
  }
  if (p === 'saved' || p === 'student-saved') {
    return { kind: 'browse', label: 'Checking saved' };
  }

  /* ---- Home / idle ---- */
  if (p === 'home' || p === 'student-home' || p === '') {
    return { kind: 'idle', label: 'Home' };
  }

  return { kind: 'idle', label: 'Idle' };
}

/* ------------------------------------------------------------
   computeEngagement — 0-100 heat score from live signals
   ------------------------------------------------------------ */
function computeEngagement(entry) {
  let score = 0;
  const sessionSec = entry.sessionSeconds || 0;
  const lastSeenAgo = (Date.now() - (entry.lastSeen || 0)) / 1000;

  // Time on platform (up to 40 points)
  score += Math.min(40, Math.floor(sessionSec / 60) * 4);

  // Current focus (up to 30 points)
  if (entry.materialId) score += 30;
  else if (entry.courseId) score += 20;
  else if ((entry.currentPage || '').includes('quiz')) score += 25;

  // Recency (up to 20 points)
  if (lastSeenAgo < 30)      score += 20;
  else if (lastSeenAgo < 60) score += 12;
  else if (lastSeenAgo < 90) score += 5;

  // Interaction intensity (up to 10 points)
  const actionCount = (entry.recentActions || []).length;
  score += Math.min(10, actionCount * 2);

  return Math.min(100, Math.max(0, score));
}

function trimMap(obj, maxKeys) {
  const keys = Object.keys(obj);
  if (keys.length <= maxKeys) return obj;
  keys.sort((a, b) => (obj[b] || 0) - (obj[a] || 0));
  const keep = {};
  for (let i = 0; i < maxKeys; i++) keep[keys[i]] = obj[keys[i]];
  return keep;
}

/* ------------------------------------------------------------
   flushOnlineUsage — durable write (unchanged logic)
   ------------------------------------------------------------ */
async function flushOnlineUsage(entry) {
  if (!entry || !entry.userId) return;

  const totalDelta = (entry.sessionSeconds || 0) - (entry.flushedSeconds || 0);
  if (totalDelta < 3) return;

  const inc = { totalSeconds: totalDelta };
  const courseCur = entry.courseSeconds || {};
  const courseFlushed = entry.flushedCourseSeconds || {};
  for (const cid of Object.keys(courseCur)) {
    const d = (courseCur[cid] || 0) - (courseFlushed[cid] || 0);
    if (d > 0) inc[`courses.${cid}`] = d;
  }
  const matCur = entry.materialSeconds || {};
  const matFlushed = entry.flushedMaterialSeconds || {};
  for (const mid of Object.keys(matCur)) {
    const d = (matCur[mid] || 0) - (matFlushed[mid] || 0);
    if (d > 0) inc[`materials.${mid}`] = d;
  }

  const dateKey = istDateKey();
  try {
    await DailyUsage.updateOne(
      { userId: entry.userId, date: dateKey },
      {
        $inc: inc,
        $set: { username: entry.username || '', fullName: entry.fullName || '', lastSeenAt: new Date() },
        $setOnInsert: { firstSeenAt: new Date(entry.firstSeen || Date.now()), sessionCount: 1 }
      },
      { upsert: true }
    );
    entry.flushedSeconds = entry.sessionSeconds || 0;
    entry.flushedCourseSeconds = { ...(entry.courseSeconds || {}) };
    entry.flushedMaterialSeconds = { ...(entry.materialSeconds || {}) };
  } catch (e) {
    console.warn('[usage-flush] failed (will retry):', e.message);
  }
}

/* ------------------------------------------------------------
   buildOnlineSnapshot — enriched payload with material TYPE
   ------------------------------------------------------------
   v2 — bulletproof material lookup:
     • Sends  materialType, materialFileName, materialUrl  so the
       client can render the right icon even if `type` is missing.
     • Uses String()-keyed lookup on BOTH sides to avoid
       ObjectId-vs-string mismatches.
     • Falls back to filename sniffing when `type` is unknown.
   ------------------------------------------------------------ */
async function buildOnlineSnapshot() {
  const now = Date.now();
  const fresh = [];
  for (const entry of onlineUsers.values()) {
    if (now - entry.lastSeen <= ONLINE_WINDOW_MS) fresh.push(entry);
  }
  fresh.sort((a, b) => b.lastSeen - a.lastSeen);

  /* ---- Gather every course / material ID we need to resolve ---- */
  const courseIdSet   = new Set();
  const materialIdSet = new Set();

  for (const u of fresh) {
    if (u.courseId)   courseIdSet.add(String(u.courseId));
    if (u.materialId) materialIdSet.add(String(u.materialId));
    if (u.courseSeconds)   for (const cid of Object.keys(u.courseSeconds))   courseIdSet.add(String(cid));
    if (u.materialSeconds) for (const mid of Object.keys(u.materialSeconds)) materialIdSet.add(String(mid));
  }

  const courseMap   = {};
  const materialMap = {};

  if (courseIdSet.size > 0 || materialIdSet.size > 0) {
    const or = [];
    if (courseIdSet.size)   or.push({ _id:             { $in: Array.from(courseIdSet) } });
    if (materialIdSet.size) or.push({ 'materials._id': { $in: Array.from(materialIdSet) } });

    try {
      /* ⭐ Fetch every material field we might need for the icon */
      const courses = await Course.find({ $or: or })
        .select('name code materials._id materials.title materials.type materials.fileName materials.url')
        .lean();

      courses.forEach(c => {
        courseMap[String(c._id)] = { name: c.name, code: c.code || '' };
        (c.materials || []).forEach(m => {
          const key = String(m._id);
          materialMap[key] = {
            title:    m.title    || '',
            type:     String(m.type || '').trim().toLowerCase() || 'other',
            fileName: m.fileName || '',
            url:      m.url      || ''
          };
        });
      });

      console.log(
        `[live-snapshot] courses=${courses.length} ` +
        `materialsIndexed=${Object.keys(materialMap).length} ` +
        `looking for materialIds=[${Array.from(materialIdSet).join(', ')}]`
      );
    } catch (err) {
      console.warn('[live-snapshot] course/material lookup failed:', err.message);
    }
  }

  const topN = (obj, n) => {
    if (!obj) return {};
    const entries = Object.entries(obj);
    if (entries.length <= n) return { ...obj };
    entries.sort((a, b) => b[1] - a[1]);
    const out = {};
    for (let i = 0; i < n; i++) out[entries[i][0]] = entries[i][1];
    return out;
  };

  const users = fresh.map(u => {
    const action     = classifyAction(u);
    const engagement = computeEngagement(u);

    /* ⭐ Resolve material — string-keyed, never null on a real hit */
    const matKey  = u.materialId ? String(u.materialId) : null;
    const matInfo = matKey ? (materialMap[matKey] || null) : null;

    /* Debug: one line per user with an active material */
    if (matKey && !matInfo) {
      console.warn(
        `[live-snapshot] ⚠️  materialId "${matKey}" for @${u.username} ` +
        `not found in materialMap (have ${Object.keys(materialMap).length} entries)`
      );
    }

    return {
      userId:   u.userId,
      username: u.username,
      fullName: u.fullName,
      role:     u.role,
      currentPage: u.currentPage,
      lastSeen:  u.lastSeen,
      firstSeen: u.firstSeen,
      courseId:   u.courseId,
      materialId: u.materialId,

      courseName:    u.courseId && courseMap[u.courseId] ? courseMap[u.courseId].name : null,
      courseCode:    u.courseId && courseMap[u.courseId] ? courseMap[u.courseId].code : null,

      /* ⭐ The three fields the client needs for the icon */
      materialTitle:    matInfo ? matInfo.title    : null,
      materialType:     matInfo ? matInfo.type     : null,
      materialFileName: matInfo ? matInfo.fileName : null,
      materialUrl:      matInfo ? matInfo.url      : null,

      sessionSeconds: u.sessionSeconds || 0,
      courseSeconds:  topN(u.courseSeconds, 5),
      device:   u.device   || 'desktop',
      os:       u.os       || 'Unknown',
      browser:  u.browser  || 'Unknown',
      actionKind:  action.kind,
      actionLabel: action.label,
      engagement,
      recentActions: (u.recentActions || []).slice(-MAX_RECENT_ACTIONS)
    };
  });

  const students = users.filter(u => u.role === 'student');

  /* ---- Course heatmap (unchanged) ---- */
  const courseHeat = {};
  students.forEach(u => {
    const cs = u.courseSeconds || {};
    for (const cid of Object.keys(cs)) {
      if (!courseHeat[cid]) {
        courseHeat[cid] = {
          courseId: cid,
          name: courseMap[cid]?.name || '(unknown)',
          code: courseMap[cid]?.code || '',
          totalSeconds: 0,
          studentCount: 0
        };
      }
      courseHeat[cid].totalSeconds += cs[cid] || 0;
    }
    if (u.courseId) {
      if (!courseHeat[u.courseId]) {
        courseHeat[u.courseId] = {
          courseId: u.courseId,
          name: u.courseName || '(unknown)',
          code: u.courseCode || '',
          totalSeconds: 0,
          studentCount: 0
        };
      }
      courseHeat[u.courseId].studentCount += 1;
    }
  });
  const hotCourses = Object.values(courseHeat)
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
    .slice(0, 6);

  /* ---- Alerts (unchanged) ---- */
  const alerts = [];
  students.forEach(u => {
    if (!u.materialId) return;
    const matSec = (u.materialSeconds || {})[u.materialId] || 0;
    if (matSec > 15 * 60) {
      alerts.push({
        type: 'stuck', severity: 'info',
        userId: u.userId, username: u.username, fullName: u.fullName,
        message: `On "${u.materialTitle || 'a material'}" for ${Math.floor(matSec / 60)} min`,
        courseId: u.courseId, materialId: u.materialId
      });
    }
  });
  students.forEach(u => {
    if (u.actionKind === 'idle' && u.sessionSeconds > 5 * 60) {
      const idleSec = Math.floor((now - u.lastSeen) / 1000);
      alerts.push({
        type: 'idle', severity: 'warn',
        userId: u.userId, username: u.username, fullName: u.fullName,
        message: `Idle for ${idleSec}s on "${u.actionLabel}"`,
        courseId: u.courseId
      });
    }
  });
  students.forEach(u => {
    if (u.materialId && u.sessionSeconds > 90 * 60) {
      alerts.push({
        type: 'long-session', severity: 'success',
        userId: u.userId, username: u.username, fullName: u.fullName,
        message: `Deep focus for ${Math.floor(u.sessionSeconds / 60)} min`,
        courseId: u.courseId
      });
    }
  });
  const alertsBySeverity = alerts.sort((a, b) => {
    const order = { warn: 0, info: 1, success: 2 };
    return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
  }).slice(0, 8);

  /* ---- Sparkline (unchanged) ---- */
  const buckets = new Array(60).fill(0);
  const oneHourAgo = now - 60 * 60 * 1000;
  for (const u of onlineUsers.values()) {
    if (u.lastSeen >= oneHourAgo) {
      const idx = Math.min(59, Math.floor((u.lastSeen - oneHourAgo) / 60000));
      buckets[idx] += 1;
    }
  }

  /* ---- Device breakdown (unchanged) ---- */
  const deviceCounts = { desktop: 0, mobile: 0, tablet: 0 };
  students.forEach(u => {
    deviceCounts[u.device] = (deviceCounts[u.device] || 0) + 1;
  });

  return {
    success: true,
    counts: {
      total: users.length,
      students: students.length,
      admins: users.length - students.length,
      studying: students.filter(u => u.courseId).length,
      reading:  students.filter(u => u.actionKind === 'reading').length,
      watchingVideo: students.filter(u => u.actionKind === 'video').length,
      inQuiz:   students.filter(u => (u.currentPage || '').includes('quiz')).length,
      aiUsage:  students.filter(u => u.actionKind === 'ai').length
    },
    deviceCounts,
    users,
    hotCourses,
    alerts: alertsBySeverity,
    activityBuckets: buckets,
    fetchedAt: now
  };
}

async function broadcastOnlineNow() {
  if (sseClients.size === 0) return;
  try {
    const snapshot = await buildOnlineSnapshot();
    const payload  = 'data: ' + JSON.stringify(snapshot) + '\n\n';
    for (const res of sseClients) {
      try { res.write(payload); }
      catch (e) { sseClients.delete(res); }
    }
  } catch (e) { /* silent */ }
}

function scheduleBroadcast() {
  if (sseClients.size === 0) return;
  if (sseClientsLock.locked) { sseClientsLock.again = true; return; }
  sseClientsLock.locked = true;
  broadcastOnlineNow().finally(() => {
    setTimeout(() => {
      sseClientsLock.locked = false;
      if (sseClientsLock.again) {
        sseClientsLock.again = false;
        scheduleBroadcast();
      }
    }, BROADCAST_MIN_MS);
  });
}

/* Background sweep — flush + remove stale entries */
const _sweep = setInterval(() => {
  try {
    const now = Date.now();
    let removed = 0;
    for (const [id, entry] of onlineUsers.entries()) {
      if (now - entry.lastSeen > ONLINE_WINDOW_MS) {
        flushOnlineUsage(entry).catch(() => {});
        onlineUsers.delete(id);
        removed++;
      }
    }
    if (removed > 0) scheduleBroadcast();
  } catch (e) { /* silent */ }
}, ONLINE_CLEANUP_MS);
if (_sweep.unref) _sweep.unref();

const heartbeatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 90,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => {
    try {
      if (req.body && req.body.userId) return 'u:' + String(req.body.userId).slice(0, 60);
    } catch (e) {}
    return req.ip || 'anon';
  },
  handler: (req, res) => res.json({ success: true, tracked: false })
});

/* ============================================================
   POST /api/heartbeat
   ============================================================ */
app.post('/api/heartbeat', heartbeatLimiter, (req, res) => {
  try {
    const b = req.body || {};
    if (!b.userId) return res.json({ success: true, tracked: false });

    const userId = String(b.userId).slice(0, 60);
    const now    = Date.now();
    const prev   = onlineUsers.get(userId);

    let delta = 0;
    if (prev && prev.lastSeen) {
      const gap = Math.floor((now - prev.lastSeen) / 1000);
      delta = Math.min(Math.max(0, gap), HEARTBEAT_MAX_DELTA);
    }

    const entry = prev || {
      userId,
      firstSeen:               now,
      sessionSeconds:          0,
      flushedSeconds:          0,
      courseSeconds:           {},
      materialSeconds:         {},
      flushedCourseSeconds:    {},
      flushedMaterialSeconds:  {},
      recentActions:           []
    };

    entry.username    = String(b.username    || entry.username    || '').slice(0, 60);
        /* ---- NEW enrichment ---- */
    const uaInfo = parseDeviceInfo(req.headers['user-agent'] || '');
    entry.device  = b.device  || uaInfo.device;
    entry.os      = b.os      || uaInfo.os;
    entry.browser = b.browser || uaInfo.browser;

    /* recent actions trail */
    if (!entry.recentActions) entry.recentActions = [];
    if (b.lastAction && typeof b.lastAction === 'string') {
      const last = entry.recentActions[entry.recentActions.length - 1];
      if (!last || last.label !== b.lastAction) {
        entry.recentActions.push({
          label: String(b.lastAction).slice(0, 120),
          at: Date.now()
        });
        if (entry.recentActions.length > MAX_RECENT_ACTIONS) {
          entry.recentActions = entry.recentActions.slice(-MAX_RECENT_ACTIONS);
        }
      }
    }
    entry.fullName    = String(b.fullName    || entry.fullName    || b.username || '').slice(0, 80);
    entry.role        = String(b.role        || entry.role        || 'student').slice(0, 20);
    entry.currentPage = String(b.currentPage || 'home').slice(0, 40);
    entry.courseId    = b.courseId   ? String(b.courseId).slice(0, 40)   : null;
    entry.materialId  = b.materialId ? String(b.materialId).slice(0, 40) : null;
    entry.lastSeen    = now;

    if (delta > 0) {
      entry.sessionSeconds = (entry.sessionSeconds || 0) + delta;

      if (entry.courseId) {
        if (!entry.courseSeconds) entry.courseSeconds = {};
        entry.courseSeconds[entry.courseId] =
          (entry.courseSeconds[entry.courseId] || 0) + delta;
      }
      if (entry.materialId) {
        if (!entry.materialSeconds) entry.materialSeconds = {};
        entry.materialSeconds[entry.materialId] =
          (entry.materialSeconds[entry.materialId] || 0) + delta;
      }
    }

    /* Trim maps — hard bound on memory */
    if (entry.courseSeconds && Object.keys(entry.courseSeconds).length > MAX_MAP_KEYS) {
      entry.courseSeconds = trimMap(entry.courseSeconds, MAX_MAP_KEYS);
    }
    if (entry.materialSeconds && Object.keys(entry.materialSeconds).length > MAX_MAP_KEYS) {
      entry.materialSeconds = trimMap(entry.materialSeconds, MAX_MAP_KEYS);
    }

    onlineUsers.set(userId, entry);

    /* Periodic durable flush */
    if ((entry.sessionSeconds - (entry.flushedSeconds || 0)) >= FLUSH_EVERY_SEC) {
      flushOnlineUsage(entry).catch(() => {});
    }

    scheduleBroadcast();
    return res.json({ success: true, tracked: true, count: onlineUsers.size });
  } catch (e) {
    return res.json({ success: false, tracked: false });
  }
});

/* ============================================================
   POST /api/heartbeat/offline
   ============================================================ */
app.post('/api/heartbeat/offline', (req, res) => {
  try {
    const b = req.body || {};
    if (b.userId) {
      const userId = String(b.userId);
      const entry  = onlineUsers.get(userId);
      if (entry) {
        flushOnlineUsage(entry).catch(() => {});
        onlineUsers.delete(userId);
        scheduleBroadcast();
      }
    }
  } catch (e) { /* silent */ }
  res.json({ success: true });
});

/* ============================================================
   GET /api/admin/online-users — one-shot snapshot
   ============================================================ */
app.get('/api/admin/online-users', requireAdminAuth, async (req, res) => {
  try {
    const snapshot = await buildOnlineSnapshot();
    res.json(snapshot);
  } catch (e) {
    console.error('[admin/online-users]', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* ============================================================
   GET /api/admin/online-users/stream — SSE
   ============================================================ */
app.get('/api/admin/online-users/stream', async (req, res) => {
  try {
    const token = String(req.query.auth || '');
    if (!token) return res.status(401).end();
    const decoded = jwt.verify(token, JWT_SECRET);
    const u = await User.findById(decoded.id).select('role').lean();
    if (!u || String(u.role || '').trim().toLowerCase() !== 'admin') return res.status(403).end();
  } catch (e) {
    return res.status(401).end();
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  /* Evict oldest if we're at capacity */
  if (sseClients.size >= MAX_SSE_CLIENTS) {
    const oldest = sseClients.values().next().value;
    if (oldest && oldest !== res) {
      try { oldest.end(); } catch (e) {}
      sseClients.delete(oldest);
    }
  }

  sseClients.add(res);

  /* Send an immediate snapshot so the admin sees data instantly */
  try {
    const snapshot = await buildOnlineSnapshot();
    res.write('data: ' + JSON.stringify(snapshot) + '\n\n');
  } catch (e) {
    res.write('event: error\ndata: {"message":"snapshot failed"}\n\n');
  }

  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (e) {}
  }, 25000);

  const cleanup = () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  };
  req.on('close',  cleanup);
  req.on('aborted', cleanup);
});

/* ============================================================
   GET /api/admin/usage/report-daily?date=YYYY-MM-DD
   ============================================================ */
app.get('/api/admin/usage/report-daily', requireAdminAuth, async (req, res) => {
  try {
    const dateKey = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
      ? req.query.date
      : istDateKey();

    const docs = await DailyUsage.find({ date: dateKey }).lean();

    const totalSeconds  = docs.reduce((s, d) => s + (d.totalSeconds || 0), 0);
    const totalStudents = docs.length;
    const activeStudents = docs.filter(d => (d.totalSeconds || 0) > 60).length;

    /* Top courses */
    const courseTotals = {};
    docs.forEach(d => {
      const cs = d.courses || {};
      for (const cid of Object.keys(cs)) {
        courseTotals[cid] = (courseTotals[cid] || 0) + (cs[cid] || 0);
      }
    });
    const topCourseIds = Object.entries(courseTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(e => e[0]);

    const courseMap = {};
    if (topCourseIds.length > 0) {
      const courses = await Course.find({ _id: { $in: topCourseIds } })
        .select('name code')
        .lean();
      courses.forEach(c => {
        courseMap[String(c._id)] = { name: c.name, code: c.code || '' };
      });
    }
    const topCourses = topCourseIds.map(cid => ({
      courseId: cid,
      name: courseMap[cid]?.name || '(removed)',
      code: courseMap[cid]?.code || '',
      seconds: courseTotals[cid]
    }));

    const topStudents = docs
      .sort((a, b) => (b.totalSeconds || 0) - (a.totalSeconds || 0))
      .slice(0, 30)
      .map(d => ({
        userId:             d.userId,
        username:           d.username,
        fullName:           d.fullName,
        seconds:            d.totalSeconds || 0,
        coursesCount:       Object.keys(d.courses   || {}).length,
        materialsCount:     Object.keys(d.materials || {}).length,
        views:              d.views || 0,
        quizzesTaken:       d.quizzesTaken || 0,
        materialsCompleted: d.materialsCompleted || 0,
        firstSeenAt:        d.firstSeenAt,
        lastSeenAt:         d.lastSeenAt
      }));

    res.json({
      success: true,
      date: dateKey,
      summary: {
        totalSeconds,
        totalStudents,
        activeStudents,
        avgSecondsPerStudent: totalStudents > 0
          ? Math.round(totalSeconds / totalStudents) : 0
      },
      topCourses,
      topStudents
    });
  } catch (e) {
    console.error('[usage/report-daily]', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ============================================================
   GET /api/admin/usage/student/:userId?days=7
   ============================================================ */
app.get('/api/admin/usage/student/:userId', requireAdminAuth, async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const days   = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 30);

    const dateKeys = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dateKeys.push(istDateKey(d));
    }

    const docs = await DailyUsage.find({ userId, date: { $in: dateKeys } })
      .sort({ date: -1 })
      .lean();

    const allCourseIds   = new Set();
    const allMaterialIds = new Set();
    docs.forEach(d => {
      Object.keys(d.courses   || {}).forEach(k => allCourseIds.add(k));
      Object.keys(d.materials || {}).forEach(k => allMaterialIds.add(k));
    });

    const courseNames   = {};
    const materialNames = {};

    if (allCourseIds.size > 0 || allMaterialIds.size > 0) {
      const or = [];
      if (allCourseIds.size)   or.push({ _id: { $in: Array.from(allCourseIds) } });
      if (allMaterialIds.size) or.push({ 'materials._id': { $in: Array.from(allMaterialIds) } });
      const courses = await Course.find({ $or: or })
        .select('name code materials._id materials.title')
        .lean();
      courses.forEach(c => {
        courseNames[String(c._id)] = { name: c.name, code: c.code || '' };
        (c.materials || []).forEach(m => {
          materialNames[String(m._id)] = m.title;
        });
      });
    }

    const dayRows = docs.map(d => ({
      date:               d.date,
      totalSeconds:       d.totalSeconds || 0,
      sessionCount:       d.sessionCount || 0,
      firstSeenAt:        d.firstSeenAt,
      lastSeenAt:         d.lastSeenAt,
      views:              d.views || 0,
      quizzesTaken:       d.quizzesTaken || 0,
      materialsCompleted: d.materialsCompleted || 0,
      courses: Object.entries(d.courses || {}).map(([cid, sec]) => ({
        courseId: cid,
        name:     courseNames[cid]?.name || '(removed)',
        code:     courseNames[cid]?.code || '',
        seconds:  sec
      })).sort((a, b) => b.seconds - a.seconds),
      materials: Object.entries(d.materials || {}).map(([mid, sec]) => ({
        materialId: mid,
        title:      materialNames[mid] || '(removed)',
        seconds:    sec
      })).sort((a, b) => b.seconds - a.seconds)
    }));

    res.json({
      success: true,
      userId,
      days: dayRows,
      totals: {
        totalSeconds:     docs.reduce((s, d) => s + (d.totalSeconds || 0), 0),
        daysWithActivity: docs.filter(d => (d.totalSeconds || 0) > 60).length
      }
    });
  } catch (e) {
    console.error('[usage/student]', e);
    res.status(500).json({ success: false, message: e.message });
  }
});
/* ============================================================
   ADMIN — Publish exam results + notify students
   ------------------------------------------------------------
   POST /api/admin/quiz/:courseId/:materialId/publish
   Body: { adminId, studentIds?: string[] }

   Marks each submission as manuallyEvaluated = true and emails
   every affected student with their final combined score. If
   studentIds is omitted, ALL pending submissions for that
   material are published.
   ============================================================ */
/* ============================================================
   POST /api/admin/quiz/:courseId/:materialId/publish
   ------------------------------------------------------------
   Publishes results *immediately* for one quiz. Behaviour is
   identical to the previous version, but the heavy lifting is
   delegated to the shared publishQuizResults() helper so the
   background sweeper uses the exact same code path.

   Body (all optional):
     { studentIds?: string[] }
   ============================================================ */
app.post('/api/admin/quiz/:courseId/:materialId/publish',
  requireAdminAuth,
  async (req, res) => {
    try {
      const { studentIds } = req.body || {};
      const result = await publishQuizResults({
        courseId:  req.params.courseId,
        materialId:req.params.materialId,
        studentIds,
        reason: 'admin-publish'
      });
      if (result.error) {
        return res.status(404).json({ success: false, message: result.error });
      }
      res.json({
        success: true,
        message: `Published results for ${result.published} student` +
                 `${result.published === 1 ? '' : 's'}. ` +
                 `${result.emailed} email(s) and ${result.notifiedInApp} in-app alert(s) queued.`,
        published: result.published,
        emailed: result.emailed,
        notifiedInApp: result.notifiedInApp
      });
    } catch (e) {
      console.error('[quiz/publish]', e);
      res.status(500).json({ success: false, message: 'Server error: ' + e.message });
    }
  }
);

/* ============================================================
   POST /api/admin/quiz/:courseId/:materialId/publish-now
   ------------------------------------------------------------
   Explicit admin override. Same effect as /publish, but the
   response is idempotent-safe and the frontend "Publish Now"
   button calls it. Also flips resultPublishMode → 'immediate'
   so subsequent submissions are visible without any delay.
   ============================================================ */
app.post('/api/admin/quiz/:courseId/:materialId/publish-now',
  requireAdminAuth,
  async (req, res) => {
    try {
      /* 1. Flip the mode so any later submission is immediate too */
      await Course.updateOne(
        { _id: req.params.courseId, 'materials._id': req.params.materialId },
        {
          $set: {
            'materials.$.examConfig.resultPublishMode':   'immediate',
            'materials.$.examConfig.resultPublishAt':     null,
            'materials.$.examConfig.resultPublishDelayHours': 0
          }
        }
      );
      cacheClear('courses:');

      /* 2. Publish everything that is already in the DB */
      const result = await publishQuizResults({
        courseId:  req.params.courseId,
        materialId:req.params.materialId,
        reason: 'admin-publish-now'
      });

      if (result.error) {
        return res.status(404).json({ success: false, message: result.error });
      }
      res.json({
        success: true,
        message: `Results released. ${result.published} student` +
                 `${result.published === 1 ? '' : 's'} notified.`,
        published: result.published,
        emailed: result.emailed,
        notifiedInApp: result.notifiedInApp
      });
    } catch (e) {
      console.error('[quiz/publish-now]', e);
      res.status(500).json({ success: false, message: 'Server error: ' + e.message });
    }
  }
);

/* ============================================================
   PUT /api/admin/quiz/:courseId/:materialId/schedule
   ------------------------------------------------------------
   Configures the future publication schedule for one quiz.
   Can be called any time before or after the exam; a change
   after publication is ignored (the flag is already true).

   Body:
     {
       mode:              'immediate' | 'scheduled' | 'manual',
       publishAt?:        ISO date string  (absolute time),
       delayHours?:       number           (per-student delay)
     }
   ============================================================ */
app.put('/api/admin/quiz/:courseId/:materialId/schedule',
  requireAdminAuth,
  async (req, res) => {
    try {
      const { mode, publishAt, delayHours } = req.body || {};
      const cleanMode = ['immediate', 'scheduled', 'manual'].includes(mode)
        ? mode
        : 'immediate';

      let parsedAt = null;
      if (cleanMode === 'scheduled' && publishAt) {
        const d = new Date(publishAt);
        if (!isNaN(d.getTime())) parsedAt = d;
      }
      const cleanDelay = cleanMode === 'scheduled'
        ? Math.max(0, Math.min(8760, parseInt(delayHours, 10) || 0))   // 0–365 days
        : 0;

      const update = {
        'materials.$.examConfig.resultPublishMode':       cleanMode,
        'materials.$.examConfig.resultPublishAt':         parsedAt,
        'materials.$.examConfig.resultPublishDelayHours': cleanDelay
      };

      /* A schedule change resets the "already published" flag ONLY
         if the quiz has not already been released. Otherwise we
         would hide a score students have already seen. */
      const course = await Course.findById(req.params.courseId)
        .select('materials').lean();
      const mat = (course && course.materials || []).find(
        m => String(m._id) === String(req.params.materialId)
      );
      if (mat && !(mat.examConfig && mat.examConfig.resultsPublished)) {
        update['materials.$.examConfig.resultsPublished']   = false;
        update['materials.$.examConfig.resultsPublishedAt'] = null;
      }

      const r = await Course.updateOne(
        { _id: req.params.courseId, 'materials._id': req.params.materialId },
        { $set: update }
      );
      if (r.matchedCount === 0) {
        return res.status(404).json({ success: false, message: 'Material not found.' });
      }

      cacheClear('courses:');
      res.json({
        success: true,
        message:
          cleanMode === 'immediate' ? 'Results will be visible immediately.' :
          cleanMode === 'manual'    ? 'Results will stay hidden until you click “Publish Now”.' :
          parsedAt                  ? `Results will publish on ${parsedAt.toISOString()}.` :
          cleanDelay > 0            ? `Results will publish ${cleanDelay} hour(s) after each student submits.` :
                                      'Scheduled mode set, but no publish time configured yet.',
        schedule: {
          mode:       cleanMode,
          publishAt:  parsedAt ? parsedAt.toISOString() : null,
          delayHours: cleanDelay
        }
      });
    } catch (e) {
      console.error('[quiz/schedule]', e);
      res.status(500).json({ success: false, message: 'Server error: ' + e.message });
    }
  }
);

/* ============================================================
   LISTEN — start the HTTP server
   ------------------------------------------------------------
   Without this call, `app` never binds to a port and the
   process exits silently. Nginx then returns 502 to clients.
   ============================================================ */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
/* ============================================================
   ⭐ QUIZ RESULT PUBLICATION SWEEPER
   ------------------------------------------------------------
   Runs every 60 seconds. Scans for quizzes whose
   resultPublishMode === 'scheduled' AND whose publish deadline
   has just passed AND which are still marked unpublished.

   No external cron package is required — setInterval is enough
   for a task that runs at one-minute granularity. If the process
   is restarted the sweeper picks up exactly where it left off
   because the state lives in MongoDB, not in memory.
   ============================================================ */
const QUIZ_PUBLISH_SWEEP_MS = 60 * 1000;
let _quizSweepRunning = false;

async function runQuizPublishSweep() {
  if (_quizSweepRunning) return;
  _quizSweepRunning = true;

  try {
    const now = new Date();

    /* Broad query — everything scheduled, then filter in JS so we
       can handle both absolute dates AND per-student delays in a
       single pass. The result set is tiny (only courses with a
       quiz currently in scheduled mode). */
    const courses = await Course.find({
      'materials.examConfig.resultPublishMode': 'scheduled'
    }).select('materials').lean();

    let totalPublished = 0;

    for (const course of courses) {
      for (const mat of (course.materials || [])) {
        const cfg = mat.examConfig || {};
        if (cfg.resultPublishMode !== 'scheduled')  continue;
        if (cfg.resultsPublished === true)          continue;

        const absolute = cfg.resultPublishAt
          ? new Date(cfg.resultPublishAt).getTime()
          : null;
        const delayMs = Math.max(0, Number(cfg.resultPublishDelayHours) || 0)
                      * 3600 * 1000;

        /* Absolute-only schedule → single global deadline. */
        if (absolute && now.getTime() >= absolute) {
          const r = await publishQuizResults({
            courseId:   String(course._id),
            materialId: String(mat._id),
            reason:     'sweep-absolute'
          });
          totalPublished += r.published || 0;
          continue;
        }

        /* Per-student delay → find every student whose attempt is
           old enough and publish just for them. */
        if (!absolute && delayMs > 0) {
          const matIdStr = String(mat._id);
          const students = await User.find({
            [`quizResults.${matIdStr}`]: { $exists: true }
          })
            .select('quizResults')
            .lean();

          const due = [];
          for (const s of students) {
            const r = s.quizResults[matIdStr];
            if (!r || r.publishedAt) continue;
            const last = r.lastAttemptAt ? new Date(r.lastAttemptAt).getTime() : null;
            if (last && now.getTime() >= last + delayMs) {
              due.push(String(s._id));
            }
          }

          if (due.length > 0) {
            const r = await publishQuizResults({
              courseId:   String(course._id),
              materialId: matIdStr,
              studentIds: due,
              reason:     'sweep-per-student-delay'
            });
            totalPublished += r.published || 0;
          }
        }
      }
    }

    if (totalPublished > 0) {
      console.log(
        `[quiz-sweep] ✅ published ${totalPublished} result(s) in this cycle`
      );
    }
  } catch (e) {
    console.warn('[quiz-sweep] non-fatal error:', e.message);
  } finally {
    _quizSweepRunning = false;
  }
}

/* Kick it off once at boot (30 s in), then every minute. */
setTimeout(runQuizPublishSweep, 30 * 1000);
setInterval(runQuizPublishSweep, QUIZ_PUBLISH_SWEEP_MS);
console.log('[quiz-sweep] scheduler armed — every 60 s');
