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
const crypto = require('crypto');
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
const path = require('path');
const fs = require('fs');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
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

function fileFilter(req, file, cb) {
  if (ALLOWED_MIMES.has(file.mimetype)) return cb(null, true);
  cb(new Error('File type not allowed: ' + file.mimetype));
}

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter
});
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  immutable: true,
  etag: true
}));

/* Upload endpoint — accepts one file, returns its public URL */
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

    console.log('[upload] 📤 Cloudinary:', req.file.originalname,
                '(' + Math.round(req.file.size / 1024 / 1024) + ' MB)');

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'auto',
          folder: 'aerogyan/uploads',
          timeout: 600000
        },
        (err, result) => err ? reject(err) : resolve(result)
      );
      stream.end(req.file.buffer);
    });

    console.log('[upload] ✅ Cloudinary URL:', result.secure_url);
    res.json({
      success: true,
      url: result.secure_url,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      publicId: result.public_id
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

    // ---- 2) Upload merged file to Cloudinary ----
    console.log('[chunked] 📤 Cloudinary upload:', session.fileName,
                '(' + Math.round(session.fileSize / 1024 / 1024) + ' MB)');

    const result = await cloudinary.uploader.upload(tempPath, {
      resource_type: 'auto',
      folder: 'aerogyan/uploads',
      timeout: 600000
    });

    // ---- 3) Cleanup temp file + chunk directory ----
    try { fs.unlinkSync(tempPath); } catch (_) {}
    try { fs.rmSync(session.sessionDir, { recursive: true, force: true }); } catch (_) {}
    uploadSessions.delete(uploadId);

    console.log('[chunked] ✅ Cloudinary URL:', result.secure_url);
    res.json({
      success: true,
      url: result.secure_url,
      fileName: session.fileName,
      fileSize: session.fileSize,
      publicId: result.public_id
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
  if (err) {
    console.error('[error-handler]', err);
    return res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
  next();
});

/* ⚠️ SECURITY: Do NOT use express.static(__dirname) — it exposes .env, server.js, package.json, etc.
   Serve ONLY specific frontend files. Uploads are served from /uploads below. */
/* ---- HTML: no cache (so updates deploy instantly) ---- */
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/index.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ---- Static assets: 5-min browser cache (speeds up repeat visits) ---- */
function sendCached(res, file, maxAge = 300) {
  res.setHeader('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=86400`);
  res.sendFile(path.join(__dirname, file));
}
// ⚡ App code — NEVER HTTP-cache. The SW fetches these URLs and MUST
// always get the latest version. Version query (v=30) on the client
// handles long-term cache busting; here we just want always-fresh.
app.get('/app.js',          (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'app.js'));
});
app.get('/styles.css',      (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'styles.css'));
});
app.get('/media-viewer.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'media-viewer.js'));
});
app.get('/passport.jpg',    (req, res) => sendCached(res, 'passport.jpg', 604800));
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
    if (!auth.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
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
   ============================================================ */
const otpStore = {};

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
    otpStore[cleanEmail] = {
      otp,
      phone: cleanPhone,
      expiresAt: Date.now() + 10 * 60 * 1000,
      attempts: 0
    };

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

    const record = otpStore[cleanEmail];
    if (!record) {
      return res.status(400).json({ success: false, message: 'No OTP was requested for this email.' });
    }
    if (Date.now() > record.expiresAt) {
      delete otpStore[cleanEmail];
      return res.status(400).json({ success: false, message: 'OTP expired. Please request a new one.' });
    }
    if (record.attempts >= 5) {
      delete otpStore[cleanEmail];
      return res.status(400).json({ success: false, message: 'Too many incorrect attempts. Request a new OTP.' });
    }
    if (String(otp || '').trim() !== record.otp) {
      record.attempts = (record.attempts || 0) + 1;
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

    delete otpStore[cleanEmail];
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
    const limit = Math.min(500, parseInt(req.query.limit) || 500);
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
app.get('/api/courses/:courseId/materials/:materialId/full-quiz', async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId)
      .select('materials')
      .lean();
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

    const mat = (course.materials || []).find(
      m => String(m._id) === String(req.params.materialId)
    );
    if (!mat) return res.status(404).json({ success: false, message: 'Material not found' });

    res.json({
      success: true,
      quiz: mat.quiz || [],
      examConfig: mat.examConfig || {}
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

/* ---- On-demand file fetch (PDF base64) ---- */
app.get('/api/courses/:courseId/materials/:materialId/file', async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId)
      .select('materials._id materials.fileData materials.fileName')
      .lean();
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

    const mat = (course.materials || []).find(m => String(m._id) === String(req.params.materialId));
    if (!mat) return res.status(404).json({ success: false, message: 'Material not found' });
    if (!mat.fileData) return res.status(404).json({ success: false, message: 'No file attached.' });

    res.json({ success: true, fileData: mat.fileData, fileName: mat.fileName || '' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

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

    let score = 0;
    let totalMarksPossible = 0;
    let marksEarned = 0;

    const results = quiz.map((q, i) => {
      const ans = answers[i];
      const qType = q.type || 'single';
      const qMarks = typeof q.marks === 'number' ? q.marks : 4;
      const qNeg   = typeof q.negativeMarks === 'number' ? q.negativeMarks : -1;
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
        const attempted = qType === 'integer'
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
        matrixRows: q.matrixRows || [],
        explanation: q.explanation || '',
        marks: qMarks,
        negativeMarks: qNeg
      };
    });

    const total = quiz.length;
    const pct = Math.round((score / total) * 100);
    const normalizedMarks = totalMarksPossible > 0
      ? Math.max(0, Math.round(marksEarned * 100) / 100)
      : 0;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!user.quizResults) user.quizResults = new Map();
    const prev = user.quizResults.get(req.params.materialId) || { attempts: 0 };
    user.quizResults.set(req.params.materialId, {
      score, total, percent: pct,
      marksEarned: normalizedMarks,
      marksPossible: totalMarksPossible,
      attempts: (prev.attempts || 0) + 1,
      lastAttemptAt: new Date()
    });

    logActivity(user, {
      type: 'quiz',
      courseId: req.params.courseId,
      materialId: req.params.materialId,
      score, total
    });

    await user.save();
    res.json({
      success: true,
      score, total, percent: pct,
      marksEarned: normalizedMarks,
      marksPossible: totalMarksPossible,
      results,
      attempts: (prev.attempts || 0) + 1
    });
  } catch (e) {
    console.error('[quiz/grade]', e);
    res.status(500).json({ success: false, message: 'Error grading quiz: ' + e.message });
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
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

app.post('/api/create-order', async (req, res) => {
  try {
    const { amount, userId, itemId } = req.body; // Accept userId and itemId
    const order = await razorpay.orders.create({
      amount: amount * 100, currency: 'INR',
      receipt: 'aero_receipt_' + Math.random().toString(36).substring(7),
      notes: { userId, itemId } // Add notes for the webhook to read
    });
    
    // Send the public Key ID to the frontend securely
    res.json({ 
      success: true, 
      order,
      key_id: process.env.RAZORPAY_KEY_ID 
    });
  } catch (e) { 
    res.status(500).json({ success: false, message: 'Server error creating order' }); 
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
    if (razorpay_signature !== expected) {
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
    if (razorpay_signature !== expected) {
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
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { 
      razorpay_order_id, 
      razorpay_payment_id, 
      razorpay_signature, 
      courseId, 
      userId 
    } = req.body;

    // 1. Verify the signature to ensure payment is genuine
    const sign = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSign = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(sign.toString())
      .digest("hex");

    if (razorpay_signature !== expectedSign) {
      return res.status(400).json({ success: false, message: 'Invalid payment signature!' });
    }

    // 2. Update the user's purchases array in the database
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.purchases) user.purchases = [];
    if (!user.purchases.includes(courseId)) {
      user.purchases.push(courseId);
      await user.save();
    }

    res.json({ success: true, message: 'Payment verified successfully!' });
  } catch (error) {
    console.error('[verify-payment] Error:', error);
    res.status(500).json({ success: false, message: 'Server error verifying payment.' });
  }
});
/* ============================================================
   RAZORPAY WEBHOOK — Auto-capture payments (ADD THIS BLOCK)
   ============================================================ */
app.post('/api/razorpay-webhook', async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];

    // req.body is a raw Buffer here (thanks to express.raw above)
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.error('[Webhook] Invalid signature');
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
          const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
          if (!user.subscription) user.subscription = {};
          user.subscription.active = true;
          user.subscription.status = 'active';
          user.subscription.subscriptionId = subEntity.id || user.subscription.subscriptionId;
          user.subscription.planId = subEntity.plan_id || user.subscription.planId;
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
            date: now
          });
          await user.save();
          console.log(`[Webhook] Subscription ${event} → user ${userId} active until ${expiresAt.toISOString()}`);
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
   VIDEO SESSION
   ============================================================ */
app.post('/api/materials/:courseId/:materialId/video-session', async (req, res) => {
  try {
    const { userId } = req.body || {};
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

    const mat = course.materials.id(req.params.materialId);
    if (!mat) return res.status(404).json({ success: false, message: 'Material not found' });
    if (!mat.url) return res.status(400).json({ success: false, message: 'No video URL on this material.' });

    const isPremiumMat = mat.isPremium === true || mat.isPremium === 'true';
    if (isPremiumMat && userId) {
      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
      const owns =
        (user.purchases || []).includes(course._id.toString()) ||
        (user.purchases || []).includes(mat._id.toString());
      const subscribed = userHasActiveSubscription(user);
      if (!owns && !subscribed && user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Purchase or subscription required.' });
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
      return res.status(400).json({ success: false, message: 'Invalid YouTube link. Please provide a direct video URL, not a playlist or channel link.' });
    }

    if (!/^https?:\/\//i.test(url) && !/^blob:/i.test(url)) {
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

/* Admin: download a contribution file (proxied via Cloudinary signed URL) */
app.get('/api/admin/contributions/:id/download', requireAdminAuth, async (req, res) => {
  try {
    const doc = await Contribution.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Not found.' });

    console.log('[contribution/download] ─────────────────────────────');
    console.log('[contribution/download] id       :', doc._id);
    console.log('[contribution/download] fileName :', doc.fileName);
    console.log('[contribution/download] publicId :', doc.cloudinaryPublicId);
    console.log('[contribution/download] fileUrl  :', doc.fileUrl);

    // ---- Build a list of candidate URLs to try ----
    const candidates = [];

    // 1) Try the signed private_download_url — always works even when
    //    Cloudinary blocks direct PDF delivery for security reasons.
    if (doc.cloudinaryPublicId) {
      try {
        // Determine the resource_type from the stored URL, if possible
        let rt = 'image';
        const url = doc.fileUrl || '';
        if (/\/video\/upload\//.test(url)) rt = 'video';
        else if (/\/raw\/upload\//.test(url)) rt = 'raw';
        else if (/\.(mp4|webm|mov|avi|mkv|mp3|wav|ogg)$/i.test(doc.fileName || '')) rt = 'video';
        else if (/\.(pdf|docx?|pptx?|xlsx?|txt|csv|zip|ppt|doc|xls)$/i.test(doc.fileName || '')) rt = 'raw';

        const format = (doc.fileName || '').split('.').pop() || '';
        const signedUrl = cloudinary.utils.private_download_url(
          doc.cloudinaryPublicId,
          format,
          {
            resource_type: rt,
            type: 'upload',
            expires_at: Math.floor(Date.now() / 1000) + 300,  // 5 min
            attachment: true
          }
        );
        candidates.push({ name: 'signed', url: signedUrl });
        console.log('[contribution/download] signed URL built:', signedUrl);
      } catch (signErr) {
        console.warn('[contribution/download] signed URL build failed:', signErr.message);
      }
    }

    // 2) Fall back to the stored URL
    if (doc.fileUrl) {
      candidates.push({ name: 'stored', url: doc.fileUrl });
    }

    // ---- Try each candidate until one works ----
    let response = null;
    let usedUrl = '';
    let usedName = '';
    let lastErrMsg = '';

    for (const c of candidates) {
      try {
        console.log(`[contribution/download] trying ${c.name}:`, c.url);
        const r = await fetch(c.url, { redirect: 'follow' });
        if (r.ok) {
          response = r;
          usedUrl = c.url;
          usedName = c.name;
          console.log(`[contribution/download] ✅ success via ${c.name} (HTTP ${r.status})`);
          break;
        } else {
          lastErrMsg = `HTTP ${r.status}`;
          console.warn(`[contribution/download] ❌ ${c.name} → HTTP ${r.status}`);
        }
      } catch (e) {
        lastErrMsg = e.message;
        console.warn(`[contribution/download] ❌ ${c.name} → ${e.message}`);
      }
    }

    if (!response) {
      console.error('[contribution/download] all candidates failed:', lastErrMsg);
      return res.status(502).json({
        success: false,
        message: `Could not fetch file from storage (${lastErrMsg}). The file may have been removed.`
      });
    }

    // Mark as downloaded (fire-and-forget)
    Contribution.findByIdAndUpdate(doc._id, {
      status: 'downloaded',
      downloadedAt: new Date()
    }).catch(e => console.warn('[contribution/download] status update failed:', e.message));

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const contentLength = response.headers.get('content-length');
    const filename = (doc.fileName || 'contribution').replace(/"/g, '');

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const arrBuf = await response.arrayBuffer();
    res.send(Buffer.from(arrBuf));
    console.log(`[contribution/download] ✅ sent ${arrBuf.byteLength} bytes to client (via ${usedName})`);
  } catch (e) {
    console.error('[admin/contributions/download] fatal:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
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