/* ============================================================
   BOOT ORDER — .env MUST load before anything touches process.env
   ============================================================ */
const dns = require('dns');
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
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const multer = require('multer');
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


app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

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

app.use(compression());
app.use(cors());
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
    if (duration > 1000) {
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
  limits: { fileSize: 12 * 1024 * 1024 },
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
   HYBRID STATIC FILE SERVING — PREMIUM GATED + NO-CACHE
   ------------------------------------------------------------
   1. Premium check FIRST (403 if locked)
   2. Disk fast path (if exists)
   3. Cloudinary restore on miss
   Cache is disabled on ALL responses so a file that was free
   yesterday cannot stay in the browser cache after the admin
   flips it to Premium.
   ============================================================ */
app.get('/uploads/:filename', attachUserFromToken, async (req, res, next) => {
  const filename = path.basename(req.params.filename);   // sanitize
  if (!filename || filename.includes('..')) {
    return res.status(400).send('Invalid filename');
  }

  /* ---- ⭐ PREMIUM ACCESS CHECK — reject before serving any bytes ---- */
  try {
    const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const owner = await Course.findOne({
      'materials.url': { $regex: '/uploads/' + escaped + '$' }
    }).select('isPremium price materials').lean();

    if (owner) {
      const mat = (owner.materials || []).find(m =>
        m.url && m.url.endsWith('/' + filename)
      );
      if (mat) {
        const access = checkMaterialAccess(req.authUser, owner, mat);
        if (!access.allowed) {
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
  } catch (e) {
    console.warn('[uploads] premium check failed:', e.message);
    // ⚠️ Fail-CLOSED — never serve premium content on a DB hiccup
    return res.status(503).send('Access check temporarily unavailable. Please retry.');
  }

  /* ---- NO-CACHE headers for every successful response ---- */
  const noStore = {
    'Cache-Control': 'private, no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  };

  const diskPath = path.join(UPLOAD_DIR, filename);

  /* ---- Fast path: file exists on disk ---- */
  if (fs.existsSync(diskPath)) {
    res.set(noStore);
    return res.sendFile(diskPath);
  }

  /* ---- Slow path: try to restore from Cloudinary ---- */
  console.log('[uploads] 💾 Disk miss for', filename, '— attempting Cloudinary restore…');

  let cloudUrl = readCloudSidecar(filename);

  // Sidecar also missing (fresh deploy) → look up in DB
  if (!cloudUrl) {
    try {
      const course = await Course.findOne({
        $or: [
          { 'materials.url':      new RegExp('/uploads/' + filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') },
          { 'materials.diskName': filename }
        ]
      })
      .select('materials.url materials.cloudUrl materials.cloudinaryPublicId')
      .lean();

      if (course) {
        const mat = (course.materials || []).find(m =>
          (m.url && m.url.endsWith('/' + filename)) || m.diskName === filename
        );
        if (mat) {
          cloudUrl = mat.cloudUrl;
          if (!cloudUrl && mat.cloudinaryPublicId) {
            cloudUrl = cloudinary.url(mat.cloudinaryPublicId, { secure: true, resource_type: 'auto' });
          }
        }
      }
    } catch (e) {
      console.warn('[uploads] DB lookup failed:', e.message);
    }
  }

  if (!cloudUrl) {
    console.warn('[uploads] ❌ No Cloudinary URL for', filename);
    return res.status(404).send('File not found and no cloud backup available.');
  }

  /* ---- Download from Cloudinary, cache to disk, then serve ---- */
  try {
    const response = await fetch(cloudUrl, { redirect: 'follow' });
    if (!response.ok) throw new Error('Cloudinary HTTP ' + response.status);

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(diskPath, buffer);
    writeCloudSidecar(filename, cloudUrl);
    console.log('[uploads] ✅ Restored from Cloudinary:', filename,
                '(' + Math.round(buffer.length / 1024 / 1024) + ' MB)');

    res.set(noStore);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
    res.send(buffer);
  } catch (e) {
    console.error('[uploads] ❌ Restore failed:', e.message);
    res.status(502).send('Could not restore file from backup.');
  }
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
    const chunkSize = 6 * 1024 * 1024;               // 6 MB per chunk (safely under 10 MB)
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
app.get('/app.js',          (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(__dirname, 'app.js'));
});
app.get('/styles.css',      (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(__dirname, 'styles.css'));
});
app.get('/media-viewer.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(__dirname, 'media-viewer.js'));
});
app.get('/passport.jpg',    (req, res) => sendCached(res, 'passport.jpg', 604800));
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
    if (!u || u.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access only.' });
    }
    req.adminUser = u;
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }
}
/* ============================================================
   AUTH — optional token attach
   ------------------------------------------------------------
   Attaches req.authUser if a valid Bearer token OR ?auth= query
   token is present. Used by read endpoints (uploads, file fetch,
   video session, quiz submit) that must enforce premium access.
   Never blocks; guests proceed with req.authUser === undefined.
   ============================================================ */
async function attachUserFromToken(req, res, next) {
  try {
    let token = null;
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) token = auth.slice(7);
    else if (req.query && req.query.auth) token = String(req.query.auth);

    if (token) {
      const decoded = jwt.verify(token, JWT_SECRET);
      const u = await User.findById(decoded.id)
        .select('role purchases subscription')
        .lean();
      if (u) req.authUser = u;
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
function checkMaterialAccess(user, course, material) {
  if (!user) {
    const cp = course    && (course.isPremium   === true || course.isPremium   === 'true');
    const mp = material  && (material.isPremium === true || material.isPremium === 'true');
    if (cp || mp) return { allowed: false, reason: 'login-required' };
    return { allowed: true };
  }
  if (user.role === 'admin') return { allowed: true };

  const purchases = Array.isArray(user.purchases) ? user.purchases : [];
  const ownsCourse   = course   && purchases.includes(String(course._id));
  const ownsMaterial = material && purchases.includes(String(material._id));
  const subscribed   = userHasActiveSubscription(user);

  if (subscribed || ownsCourse) return { allowed: true };

  const cp = course   && (course.isPremium   === true || course.isPremium   === 'true');
  if (cp && !ownsCourse) return { allowed: false, reason: 'course-premium' };

  const mp = material && (material.isPremium === true || material.isPremium === 'true');
  if (mp && !ownsMaterial) return { allowed: false, reason: 'material-premium' };

  return { allowed: true };
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
  maxPoolSize: 50,
  minPoolSize: 5,
  maxIdleTimeMS: 30000,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 10000,
  family: 4,
  compressors: ['zlib'],
  retryWrites: true,
  retryReads: true
})
  .then(() => console.log('🚀 MongoDB Connected — pool ready'))
  .catch((err) => console.error('❌ MongoDB Error:', err.message));

mongoose.connection.on('connected', () => console.log('[mongo] connected'));
mongoose.connection.on('error', (e) => console.error('[mongo] error:', e.message));
mongoose.connection.on('disconnected', () => console.warn('[mongo] disconnected'));
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
   PERSISTENT OTP STORE
   ------------------------------------------------------------
   Replaces in-memory Maps that lose all pending OTPs when the
   Render free tier spins down after 15 min inactivity.
   MongoDB TTL index auto-deletes expired docs.
   ============================================================ */
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

/* ---- Subscription helpers ---- */
async function getGlobalSettings() {
  let s = await Settings.findOne({ key: 'global' });
  if (!s) s = await Settings.create({ key: 'global' });
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
    if (user.role === 'admin') {
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

    // ---------- SINGLE-DEVICE SESSION ----------
    // Generate a fresh sessionId. This instantly invalidates any
    // previous device/browser session for this account.
    let sessionId;
    try {
      sessionId = crypto.randomBytes(24).toString('hex');
      user.activeSession = {
        sessionId,
        deviceInfo: String(req.headers['user-agent'] || 'Unknown device').slice(0, 200),
        loginAt: new Date(),
        lastSeenAt: new Date()
      };
      await user.save(); // persists both streak + new session
    } catch (sessErr) {
      console.error('[login] could not persist activeSession:', sessErr);
      return res.status(500).json({
        success: false,
        message: 'Login succeeded but session could not be established. Please try again.'
      });
    }

    // ---------- Issue token (with sessionId embedded) ----------
    const token = jwt.sign(
      { id: user._id, role: user.role, sessionId },
      JWT_SECRET,
      { expiresIn: '1d' }
    );

    // ---------- Serialize (defensive) ----------
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
    if (!user || user.role !== 'admin') {
      return res.status(401).json({ success: false, message: 'Admin account not found.' });
    }

    // Single-device session
    let sessionId;
    try {
      sessionId = crypto.randomBytes(24).toString('hex');
      user.activeSession = {
        sessionId,
        deviceInfo: String(req.headers['user-agent'] || 'Unknown device').slice(0, 200),
        loginAt: new Date(),
        lastSeenAt: new Date()
      };
      await user.save();
    } catch (sessErr) {
      console.error('[login-2fa/verify] session save failed:', sessErr);
      return res.status(500).json({ success: false, message: 'Could not establish session.' });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role, sessionId },
      JWT_SECRET,
      { expiresIn: '1d' }
    );
    console.log('[login-2fa] ✅ Admin login success:', user.username);
    res.json({ success: true, message: 'Login successful!', token, user: serializeUser(user) });
  } catch (e) {
    console.error('[login-2fa/verify] Error:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
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
      return res.status(401).json({
        success: false,
        code: 'NO_ACTIVE_SESSION',
        message: 'You have been signed out. Please log in again.'
      });
    }

    if (currentSessionId !== decoded.sessionId) {
      console.log(`[session-check] ⚠️ Session replaced for ${user.username}`);
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
    if (!user || user.role !== 'admin') {
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
    if (user.role === 'admin') return res.status(400).json({ success: false, message: 'Cannot delete admin accounts.' });
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
    const cached = cacheGet('professors:all');
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.json(cached);
    }
    const professors = await Professor.find()
      .select('-__v')
      .sort({ createdAt: 1 })
      .lean();
    const payload = { success: true, professors };
    cacheSet('professors:all', payload, 5 * 60 * 1000);
    res.setHeader('Cache-Control', 'public, max-age=300');
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
                  price: '$$m.price', estimatedTime: '$$m.estimatedTime',
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
      if (!mat.fileData) return res.status(404).json({ success: false, message: 'No file attached.' });

      // ⭐ PREMIUM ACCESS CHECK
      const access = checkMaterialAccess(req.authUser, course, mat);
      if (!access.allowed) {
        return res.status(403).json({
          success: false,
          code: access.reason,
          message: 'This file is part of premium content. Purchase it or subscribe to unlock.'
        });
      }

      res.json({ success: true, fileData: mat.fileData, fileName: mat.fileName || '' });
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

      // ⭐ PREMIUM ACCESS CHECK
      const access = checkMaterialAccess(req.authUser, course, mat);
      if (!access.allowed) {
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
                _id: '$$m._id',
                title: '$$m.title',
                type: '$$m.type',
                description: '$$m.description',
                url: '$$m.url',
                fileName: '$$m.fileName',
                isPremium: '$$m.isPremium',
                price: '$$m.price',
                estimatedTime: '$$m.estimatedTime',
                tags: '$$m.tags',
                examConfig: '$$m.examConfig',
                quizCount: { $size: { $ifNull: ['$$m.quiz', []] } }
              }
            }
          }
        }
      }
    ]);
    if (!courses || courses.length === 0) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }
    res.json({ success: true, course: courses[0] });
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
    const fields = ['title', 'type', 'description', 'url', 'isPremium', 'price', 'fileData', 'fileName'];
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
      update['materials.$.examConfig'] = {
        subject:    String(examConfig.subject    || '').slice(0, 200),
        paperCode:  String(examConfig.paperCode  || '').slice(0, 100),
        totalTime:  String(examConfig.totalTime  || '').slice(0, 60),
        totalMarks: Number(examConfig.totalMarks) || 0
      };
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
   QUIZ — Grade submission (student)
   Supports: single, multiple, integer, matrix
   ============================================================ */
app.post('/api/user/quiz/:courseId/:materialId', async (req, res) => {
  try {
    const { userId, answers } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'userId required' });
    if (!Array.isArray(answers)) {
      return res.status(400).json({ success: false, message: 'answers must be an array' });
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
            if (Number(chosen[ri]) === Number(row.correctIndex)) hits++;
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

    await user.save();
    res.json({
      success: true,
      score,
      total: autoGradedCount,
      percent: pct,
      marksEarned: normalizedMarks,
      marksPossible: totalMarksPossible,
      results,
      attempts: (prev.attempts || 0) + 1,

      // ⭐ NEW: signals to frontend that admin review is pending
      subjectiveCount,
      subjectiveMaxTotal,
      pendingEvaluation: subjectiveCount > 0
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
    const cached = cacheGet('settings:owner');
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Cache-Control', 'public, max-age=120');
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
        name:  op.name  || 'Krish Yadav',
        title: op.title || 'Founder & Course Director',
        role:  op.role  || 'Founder',
        bio:   op.bio   || '',
        email: op.email || '',
        phone: op.phone || '',
        photo: op.photo || ''
      }
    };
    cacheSet('settings:owner', payload, 5 * 60 * 1000);
    res.setHeader('Cache-Control', 'public, max-age=120');
    res.json(payload);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.put('/api/admin/settings/owner', requireAdminAuth, async (req, res) => {
  try {
    const { name, title, role, bio, email, phone, photo } = req.body || {};

    const s = await getGlobalSettings();
    if (!s.ownerProfile) s.ownerProfile = {};

    if (typeof name  === 'string') s.ownerProfile.name  = name.trim().slice(0, 80);
    if (typeof title === 'string') s.ownerProfile.title = title.trim().slice(0, 120);
    if (typeof role  === 'string') s.ownerProfile.role  = role.trim().slice(0, 60);
    if (typeof bio   === 'string') s.ownerProfile.bio   = bio.trim().slice(0, 2000);
    if (typeof email === 'string') s.ownerProfile.email = email.trim().slice(0, 200);
    if (typeof phone === 'string') s.ownerProfile.phone = phone.trim().slice(0, 40);
    if (typeof photo === 'string') s.ownerProfile.photo = photo; // base64 or ''
    s.ownerProfile.updatedAt = new Date();
    s.updatedAt = new Date();

    await s.save();
    cacheClear('settings:');

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

    /* Invalidate cached Razorpay plan id if amount changed */
    if (amount !== undefined) plan.razorpayPlanId = null;

    s.updatedAt = new Date();
    await s.save();
    cacheClear('settings:');
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
async function ensureRazorpayPlanForThisPlan(plan) {
  if (plan.razorpayPlanId) {
    try {
      const fetched = await razorpay.plans.fetch(plan.razorpayPlanId);
      const fetchedAmt = fetched && fetched.item ? Number(fetched.item.amount) : null;
      const wanted = Math.round(Number(plan.amount) * 100);
      if (fetchedAmt === wanted) return plan.razorpayPlanId;
    } catch (e) {
      console.warn('[plan] cached razorpayPlanId invalid:', e.message);
    }
  }
  // Create a new Razorpay plan (monthly interval = 1) — Razorpay uses
  // interval/period; we approximate any duration with monthly cycles.
  const months = Math.max(1, Math.round(plan.durationDays / 30));
  const created = await razorpay.plans.create({
    period: 'monthly',
    interval: months,
    item: {
      name: plan.title,
      amount: Math.round(plan.amount * 100),
      currency: 'INR',
      description: plan.description || ''
    },
    notes: { internalPlanId: plan.id }
  });
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
      total_count: 120,
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
      .select('fullName username email subscription').lean();

    const now = new Date();
    const subscriptions = users.map(u => {
      const s = u.subscription || {};
      const isActive = !!(s.active && s.status === 'active' &&
        (!s.expiresAt || new Date(s.expiresAt) > now));
      const daysLeft = s.expiresAt
        ? Math.ceil((new Date(s.expiresAt) - now) / 86400000)
        : null;
      return {
        _id: u._id,
        fullName: u.fullName,
        username: u.username,
        email: u.email,
        subscription: s,
        isActive,
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
    if (user.role === 'student') { bumpStreak(user); await user.save(); }
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
    if (viewed === false) arr = arr.filter(x => x !== mid);
    else if (!arr.includes(mid)) arr.push(mid);
    user.progress.set(cid, arr);

    if (viewed !== false) {
      user.lastActivity = { courseId: cid, materialId: mid, timestamp: new Date() };
      bumpStreak(user);
      logActivity(user, { type: 'view', courseId: cid, materialId: mid });
    }
    await user.save();
    res.json({
      success: true,
      progress: Object.fromEntries(user.progress),
      lastActivity: user.lastActivity,
      streakCount: user.streakCount,
      longestStreak: user.longestStreak,
      lastActiveDate: user.lastActiveDate
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
    const students = await User.find({ role: 'student' })
      .select('-password')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, students });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
/* ============================================================
   VIDEO SESSION — PREMIUM PROTECTED (checks COURSE + MATERIAL)
   ============================================================ */
app.post('/api/materials/:courseId/:materialId/video-session', async (req, res) => {
  try {
    const { userId } = req.body || {};

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
      if (!userId) {
        return res.status(403).json({
          success: false,
          message: 'Purchase or subscription required to watch this video.'
        });
      }
      const user = await User.findById(userId).select('role purchases subscription').lean();
      if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

      const ownsCourse   = (user.purchases || []).includes(String(course._id));
      const ownsMaterial = (user.purchases || []).includes(String(mat._id));
      const subscribed   = userHasActiveSubscription(user);

      if (!ownsCourse && !ownsMaterial && !subscribed && user.role !== 'admin') {
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
   EMAIL REPLY FETCHER (IMAP)
   ============================================================ */
const fetchEmailReplies = async () => {
  if (!EMAIL_USER || !EMAIL_PASS) return;
  if (!USE_SMTP) return;   // skip IMAP entirely if SMTP not configured
  
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    logger: false
  });

  try {
    await client.connect();
    let lock = await client.getMailboxLock('INBOX');
    try {
      // Fetch unseen emails
      for await (let message of client.fetch({ seen: false }, { envelope: true, source: true })) {
        const parsed = await simpleParser(message.source);
        
        // Save to database
        await EmailReply.create({
          from: parsed.from?.text || 'Unknown Sender',
          subject: parsed.subject || '(No Subject)',
          text: parsed.text || parsed.html || 'No content',
          date: parsed.date || new Date()
        });

        // Mark as seen so we don't fetch it again
        await client.messageFlagsAdd(message.uid, ['\\Seen']);
        console.log(`[IMAP] Saved reply from: ${parsed.from?.text}`);
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    console.error('[IMAP] Error fetching replies:', err.message);
  }
};

/* ============================================================
   IMAP Polling — OFF by default (saves CPU + network)
   Set ENABLE_IMAP_POLLING=true in .env to enable.
   Manual refresh still works via admin dashboard → "Refresh Replies".
   ============================================================ */
if (process.env.ENABLE_IMAP_POLLING === 'true') {
  console.log('[IMAP] Polling enabled — every 15 minutes');
  setInterval(() => {
    fetchEmailReplies().catch(err => {
      console.warn('[IMAP] fetchEmailReplies failed (non-fatal):', err.message);
    });
  }, 15 * 60 * 1000);
} else {
  console.log('[IMAP] Polling disabled. Set ENABLE_IMAP_POLLING=true to enable auto-polling.');
}

// API Endpoint for admin dashboard
app.get('/api/admin/email-replies', requireAdminAuth, async (req, res) => {
  try {
    // Live IMAP pull when the admin explicitly asks for a refresh
    if (req.query.refresh === '1' && USE_SMTP) {
      try {
        await withTimeout(fetchEmailReplies(), 10000, 'IMAP refresh');
      } catch (e) {
        console.warn('[IMAP] Live refresh failed (non-fatal):', e.message);
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
  if (!u || u.role !== 'admin') return null;
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

    const buf = Buffer.from(await response.arrayBuffer());

    // Cache to disk for future requests (best-effort)
    try {
      const cacheName = diskFilename || ('restored-' + Date.now() + (ext || ''));
      const cachePath = path.join(UPLOAD_DIR, cacheName);
      if (!fs.existsSync(cachePath)) {
        fs.writeFileSync(cachePath, buf);
        console.log('[contribution/download] cached to disk as:', cacheName);
      }
    } catch (e) {
      console.warn('[contribution/download] cache write failed:', e.message);
    }

    res.setHeader('Content-Type', response.headers.get('content-type') || contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');

    markDownloaded();
    res.send(buf);
    console.log(`[contribution/download] ✅ sent ${buf.length} bytes (via ${usedName})`);
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
   AI DOUBT SOLVER — Groq (Llama 3.3 70B)
   ------------------------------------------------------------
   Student doubt → AI answer in ~2 seconds
   FREE tier: 14,400 requests/day
   ============================================================ */

/* ============================================================
   AI DOUBT SOLVER — Groq
   Rate limiter — 10 requests per minute per IP (spam protection)
   ============================================================ */
const aiDoubtLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many AI requests. Please wait a minute.' }
});

app.post('/api/ai/solve-doubt', aiDoubtLimiter, async (req, res) => {
  try {
    const { question, courseId, materialId, userId } = req.body || {};

    // ---- Validation ----
    if (!question || !question.trim()) {
      return res.status(400).json({ success: false, message: 'Question is required.' });
    }
    if (question.length > 2000) {
      return res.status(400).json({ success: false, message: 'Question too long (max 2000 chars).' });
    }
    if (!process.env.GROQ_API_KEY) {
      console.error('[ai] ❌ GROQ_API_KEY is not set in environment');
      return res.status(500).json({
        success: false,
        message: 'AI is not configured. Please ask the admin to set GROQ_API_KEY.'
      });
    }

    // ---- Course context (RAG-lite) ----
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

    // ---- Prompt ----
    const systemPrompt =
      `You are an expert teaching assistant for the Aerospace Department at IIT Kharagpur. ` +
      `Answer questions in a clear, student-friendly way. Use simple language and real-world analogies. ` +
      `For math/physics, show the derivation step-by-step. ` +
      `If you don't know something, say so honestly. ` +
      `Keep answers focused (under 400 words unless a derivation needs more). ` +
      `Use markdown (bold, bullet lists, code blocks) and LaTeX with $...$ for inline math and $$...$$ for display math. ` +
      `Format your response in clean, readable Markdown.`;

    const userPrompt = contextBlock
      ? `${contextBlock}\nStudent's doubt: ${question}`
      : `Student's doubt: ${question}`;

    // ---- Model list (verified working on Groq as of September 2026) ----
    // llama-3.3-70b-versatile and llama-3.1-8b-instant were decommissioned
    // on 2026-08-16. New supported models below.
    const MODELS = [
      'openai/gpt-oss-120b',        // Primary: best quality, 120B MoE
      'qwen/qwen3.6-27b',           // Fallback: strong reasoning, 27B
      'meta-llama/llama-4-scout-17b-16e-instruct'  // Last resort: fast, smaller
    ];

    let groqData = null;
    let lastError = null;

    for (const model of MODELS) {
      try {
        console.log(`[ai] Trying model: ${model}`);
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user',   content: userPrompt }
            ],
            temperature: 0.5,
            max_tokens: 1200
          })
        });

        const rawBody = await groqRes.text();

        if (!groqRes.ok) {
          console.error(`[ai] ❌ Model "${model}" failed (HTTP ${groqRes.status}):`, rawBody.slice(0, 500));
          lastError = { status: groqRes.status, body: rawBody, model };
          continue; // try next model
        }

        try {
          groqData = JSON.parse(rawBody);
        } catch (parseErr) {
          console.error(`[ai] ❌ Model "${model}" returned invalid JSON:`, rawBody.slice(0, 200));
          lastError = { status: 0, body: 'Invalid JSON', model };
          continue;
        }

        console.log(`[ai] ✅ Model "${model}" succeeded.`);
        break;
      } catch (e) {
        console.error(`[ai] Model "${model}" threw:`, e.message);
        lastError = { status: 0, body: e.message, model };
      }
    }

    if (!groqData) {
      // Build a helpful error message for the frontend
      let friendly = 'AI is temporarily unavailable. Please try again in a moment.';
      if (lastError) {
        if (lastError.status === 401 || lastError.status === 403)
          friendly = 'AI authentication failed. Please ask the admin to verify GROQ_API_KEY.';
        else if (lastError.status === 429)
          friendly = 'AI rate limit reached. Please wait a minute and try again.';
        else if (lastError.status === 400)
          friendly = 'AI could not process that request. Try rephrasing your question.';
        else if (lastError.status === 404)
          friendly = 'AI model unavailable. Please contact admin to update the model.';
        else if (lastError.status === 0)
          friendly = 'Network error reaching the AI service. Check the server internet connection.';
      }
      return res.status(503).json({ success: false, message: friendly });
    }

    const answer = groqData.choices?.[0]?.message?.content || 'No answer generated.';

    console.log(`[ai/solve-doubt] ✅ Answered (${answer.length} chars, model: ${groqData.model})`);

    res.json({
      success: true,
      answer,
      model: groqData.model || 'unknown',
      tokensUsed: groqData.usage?.total_tokens || 0
    });

  } catch (e) {
    console.error('[ai/solve-doubt] Error:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});
/* ============================================================
   LISTEN
   ============================================================ */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server is running on port ${PORT}`));