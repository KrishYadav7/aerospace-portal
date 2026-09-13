const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');   // Render free tier has NO IPv6 egress

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
require('dotenv').config();
const nodemailer = require('nodemailer');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const Course = require('./models/Course');
const Professor = require('./models/Professor');
const Settings = require('./models/Settings');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const app = express();
// 👇 ADD THIS LINE
app.set('trust proxy', 1); 


app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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
if (USE_SMTP && !USE_BREVO) {
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
// ---- Boot diagnostic ----
(async () => {
  console.log('[email] Default SMTP from:  ', USE_SMTP ? smtpFrom() : '(n/a)');
  console.log('[email] Default Resend from:', USE_RESEND ? resendFrom() : '(n/a)');
  try {
    await transporter.verify();
    console.log('✅ Email transporter ready.');
  } catch (err) {
    console.error('❌ Email transporter verification FAILED:', err.message);
  }
})();

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
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('🚀 MongoDB Database Successfully Connected!'))
  .catch((err) => console.log('Database Connection Error:', err));
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
    isSubscribed: userHasActiveSubscription(user)
  };
}

function extractYouTubeId(url) {
  if (!url) return null;
  const m = String(url).match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
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
const adminLoginStore = {}; // pendingToken → { userId, otp, expiresAt, attempts, resends, email }

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

app.get('/', (req, res) => res.send('Aerospace EdTech Backend is Running!'));

/* ============================================================
   AUTH
   ============================================================ */
/* ============================================================
   AUTH
   ============================================================ */
app.post('/api/login', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password are required.' });
    }
    const cleanUsername = String(username).trim().toLowerCase();
    const user = await User.findOne({
      $or: [
        { username: cleanUsername },
        { username: String(username).trim() }
      ]
    });
    if (!user) {
      console.log('[login] No user found for:', cleanUsername);
      return res.status(400).json({ success: false, message: 'Invalid username or password.' });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      console.log('[login] Password mismatch for user:', user.username);
      return res.status(400).json({ success: false, message: 'Invalid username or password.' });
    }

    if (role && user.role !== role) {
      console.log(`[login] ⛔ Role mismatch: User is ${user.role} but tried to log in as ${role}`);
      return res.status(403).json({ 
        success: false, 
        message: `Access denied. You are not registered as an ${role}.` 
      });
    }

    /* ============================================================
       ADMIN 2FA — step 1 of 2 (STATELESS)
       ============================================================ */
    if (user.role === 'admin') {
      const otpDestination = (user.email || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
      if (!otpDestination) {
        return res.status(400).json({
          success: false,
          message: 'Admin has no email configured. Contact support.'
        });
      }

      if (!user.email && process.env.ADMIN_EMAIL) {
        user.email = otpDestination;
        await user.save();
        console.log('[login] Attached ADMIN_EMAIL to legacy admin');
      }

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      
      // Create a stateless pendingToken using JWT
      const pendingToken = jwt.sign(
        { userId: user._id.toString(), otp }, 
        JWT_SECRET, 
        { expiresIn: '10m' }
      );

      try {
        await withTimeout(
          transporter.sendMail({
            to: otpDestination,
            subject: 'Aerospace Portal — Admin Login OTP',
            text: `Hi ${user.fullName || user.username},\n\nYour admin login OTP is: ${otp}\n\nValid for 10 minutes. Do not share.\n\nIf this wasn't you, ignore this email — no one can log in without this code.`
          }),
          30000,
          'Admin 2FA OTP send'
        );
      } catch (emailErr) {
        console.error('[login-2fa] Failed to send OTP:', emailErr.message);
        return res.status(500).json({ success: false, message: 'Could not send 2FA OTP. Please try again.' });
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

    /* ============================================================
       STUDENT — direct login (unchanged)
       ============================================================ */
    if (user.role === 'student') { bumpStreak(user); await user.save(); }
    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '1d' });
    console.log('[login] ✅ Success:', user.username, '(' + user.role + ')');
    res.json({ success: true, message: 'Login successful!', token, user: serializeUser(user) });
  } catch (e) {
    console.error('[login] Error:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
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

    // 1. Verify the stateless JWT
    let decoded;
    try {
      decoded = jwt.verify(pendingToken, JWT_SECRET);
    } catch (err) {
      return res.status(400).json({ success: false, message: 'Session expired or invalid. Please log in again.' });
    }

    // 2. Check the OTP
    if (String(otp).trim() !== decoded.otp) {
      return res.status(400).json({
        success: false,
        message: 'Incorrect OTP. Please check your email and try again.'
      });
    }

    // 3. Fetch the user
    const user = await User.findById(decoded.userId);
    if (!user || user.role !== 'admin') {
      return res.status(401).json({ success: false, message: 'Admin account not found.' });
    }

    // 4. Issue the real login token
    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '1d' });
    console.log('[login-2fa] ✅ Admin login success:', user.username);
    res.json({ success: true, message: 'Login successful!', token, user: serializeUser(user) });
  } catch (e) {
    console.error('[login-2fa/verify] Error:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

/* ============================================================
   ADMIN 2FA — resend OTP (STATELESS)
   ============================================================ */
app.post('/api/admin/login/resend-otp', async (req, res) => {
  try {
    const { pendingToken } = req.body || {};
    if (!pendingToken) return res.status(400).json({ success: false, message: 'Missing token.' });

    // 1. Verify the old token to get the user ID
    let decoded;
    try {
      decoded = jwt.verify(pendingToken, JWT_SECRET);
    } catch (err) {
      return res.status(400).json({ success: false, message: 'Session expired. Please log in again.' });
    }

    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Admin account not found.' });
    }

    // 2. Generate a new OTP and a new stateless token
    const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const newPendingToken = jwt.sign(
      { userId: user._id.toString(), otp: newOtp }, 
      JWT_SECRET, 
      { expiresIn: '10m' }
    );

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
app.put('/api/admin/update-credentials', async (req, res) => {
  try {
    const { adminId, currentPassword, newUsername, newPassword } = req.body || {};

    if (!adminId) return res.status(400).json({ success: false, message: 'adminId required.' });
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
    const { fullName, username, email, phone, password, otp } = req.body || {};
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
    await new User({
      fullName: String(fullName).trim(),
      username: cleanUsername,
      email:    cleanEmail,
      phone:    cleanPhone,
      password: hashedPassword,
      role: 'student'
    }).save();

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
app.post('/api/admin/create-student', async (req, res) => {
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

app.post('/api/admin/reset-password/:userId', async (req, res) => {
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

app.delete('/api/admin/students/:userId', async (req, res) => {
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
app.get('/api/admin/email-status', async (req, res) => {
  try {
    if (!EMAIL_USER || !EMAIL_PASS) {
      return res.json({
        success: true,
        ready: false,
        message: 'EMAIL_USER or EMAIL_PASS missing in server .env'
      });
    }
    try {
      await withTimeout(transporter.verify(), 10000, 'verify');
      res.json({ success: true, ready: true, from: EMAIL_USER, message: 'Email is configured and reachable.' });
    } catch (err) {
      res.json({ success: true, ready: false, from: EMAIL_USER, message: 'Verification failed: ' + err.message });
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

app.post('/api/admin/send-email', async (req, res) => {
  const startedAt = Date.now();
  try {
    const { adminId, recipientIds, subject, body } = req.body || {};

    // ---- Admin verification ----
    if (!adminId) {
      return res.status(400).json({ success: false, message: 'Admin identity required.' });
    }
    const admin = await User.findById(adminId).select('role fullName username');
    if (!admin || admin.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins can send bulk emails.' });
    }

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
    const professors = await Professor.find().sort({ createdAt: 1 });
    res.json({ success: true, professors });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/professors', async (req, res) => {
  try {
    const newProf = new Professor(req.body);
    await newProf.save();
    res.json({ success: true, message: 'Professor added successfully!', professor: newProf });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Error adding professor: ' + e.message });
  }
});

app.delete('/api/professors/:id', async (req, res) => {
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
app.get('/api/courses', async (req, res) => {
  try { res.json(await Course.find()); }
  catch (e) { res.status(500).json({ message: 'Server error: ' + e.message }); }
});

app.get('/api/courses/:id', async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });
    res.json({ success: true, course });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/courses', async (req, res) => {
  try {
    const newCourse = new Course(req.body);
    await newCourse.save();
    res.json({ success: true, message: 'Course created successfully!', course: newCourse });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.put('/api/courses/:id', async (req, res) => {
  try {
    const allowed = ['name','code','semester','instructor','description','category','difficulty','duration','learningOutcomes','thumbnail','status','featured','isPremium','price'];
    const update = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) update[f] = req.body[f]; });
    const updated = await Course.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!updated) return res.status(404).json({ success: false, message: 'Course not found' });
    res.json({ success: true, message: 'Course updated successfully!', course: updated });
  } catch (e) { res.status(500).json({ success: false, message: 'Error updating course: ' + e.message }); }
});

app.delete('/api/courses/:id', async (req, res) => {
  try {
    await Course.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Course deleted successfully!' });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

/* ============================================================
   MATERIALS
   ============================================================ */
app.post('/api/courses/:courseId/materials', async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ message: 'Course not found' });
    course.materials.push(req.body);
    await course.save();
    res.json({ success: true, message: 'Material added successfully!', course });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.put('/api/courses/:courseId/materials/:materialId', async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });
    const mat = course.materials.id(req.params.materialId);
    if (!mat) return res.status(404).json({ success: false, message: 'Material not found' });
    const fields = ['title', 'type', 'description', 'url', 'isPremium', 'price', 'fileData', 'fileName'];
    fields.forEach(f => { if (req.body[f] !== undefined) mat[f] = req.body[f]; });
    await course.save();
    res.json({ success: true, message: 'Material updated successfully!' });
  } catch (e) { res.status(500).json({ success: false, message: 'Error updating material: ' + e.message }); }
});

app.delete('/api/courses/:courseId/materials/:materialId', async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });
    course.materials = course.materials.filter(m => m._id.toString() !== req.params.materialId);
    (course.playlists || []).forEach(pl => {
      pl.materialIds = pl.materialIds.filter(id => id !== req.params.materialId);
    });
    await course.save();
    res.json({ success: true, message: 'Material deleted successfully!' });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error deleting material.' }); }
});

/* ============================================================
   ANNOUNCEMENTS
   ============================================================ */
app.post('/api/courses/:courseId/announcements', async (req, res) => {
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
    res.json({ success: true, message: 'Announcement posted!', announcement: ann });
  } catch (e) { res.status(500).json({ success: false, message: 'Error posting announcement: ' + e.message }); }
});

app.delete('/api/courses/:courseId/announcements/:annId', async (req, res) => {
  try {
    await Course.findByIdAndUpdate(req.params.courseId, { $pull: { announcements: { id: req.params.annId } } });
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
    res.json({ success: true, message: 'Answer accepted!' });
  } catch (e) { res.status(500).json({ success: false, message: 'Error: ' + e.message }); }
});

/* ============================================================
   QUIZ
   ============================================================ */
app.post('/api/courses/:courseId/materials/:materialId/quiz', async (req, res) => {
  try {
    const { quiz } = req.body;
    if (!Array.isArray(quiz)) return res.status(400).json({ success: false, message: 'quiz must be an array' });
    await Course.updateOne(
      { _id: req.params.courseId, "materials._id": req.params.materialId },
      { $set: { "materials.$.quiz": quiz } }
    );
    res.json({ success: true, message: 'Quiz saved successfully!' });
  } catch (e) { res.status(500).json({ success: false, message: 'Error saving quiz: ' + e.message }); }
});

app.post('/api/user/quiz/:courseId/:materialId', async (req, res) => {
  try {
    const { userId, answers } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'userId required' });
    if (!Array.isArray(answers)) return res.status(400).json({ success: false, message: 'answers must be an array' });
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });
    const mat = course.materials.id(req.params.materialId);
    if (!mat) return res.status(404).json({ success: false, message: 'Material not found' });
    const quiz = mat.quiz || [];
    if (quiz.length === 0) return res.status(400).json({ success: false, message: 'This material has no quiz' });

    let score = 0;
    const results = quiz.map((q, i) => {
      const chosen = answers[i];
      const isCorrect = chosen === q.correctIndex;
      if (isCorrect) score++;
      return { correct: isCorrect, chosen, correctIndex: q.correctIndex, explanation: q.explanation || '' };
    });
    const total = quiz.length;
    const pct = Math.round((score / total) * 100);

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!user.quizResults) user.quizResults = new Map();
    const prev = user.quizResults.get(req.params.materialId) || { attempts: 0 };
    user.quizResults.set(req.params.materialId, { score, total, attempts: (prev.attempts || 0) + 1, lastAttemptAt: new Date() });

    logActivity(user, {
      type: 'quiz',
      courseId: req.params.courseId,
      materialId: req.params.materialId,
      score,
      total
    });

    await user.save();
    res.json({ success: true, score, total, percent: pct, results, attempts: (prev.attempts || 0) + 1 });
  } catch (e) { res.status(500).json({ success: false, message: 'Error grading quiz: ' + e.message }); }
});

app.get('/api/user/quiz-results/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('quizResults');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, results: Object.fromEntries(user.quizResults || new Map()) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ============================================================
   ANALYTICS
   ============================================================ */
app.get('/api/user/analytics/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const log = user.activityLog || [];
    const progressMap = user.progress ? Object.fromEntries(user.progress) : {};
    const quizResults = user.quizResults ? Object.fromEntries(user.quizResults) : {};

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
        .select('name code materials');
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
    const s = await getGlobalSettings();
    res.json({
      success: true,
      settings: {
        enabled:     s.subscriptionEnabled,
        amount:      s.subscriptionAmount,
        title:       s.subscriptionTitle,
        description: s.subscriptionDesc
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ---- Admin: update plan info ---- */
app.put('/api/admin/settings/subscription', async (req, res) => {
  try {
    const { adminId, amount, title, description, enabled } = req.body || {};
    if (!adminId) return res.status(400).json({ success: false, message: 'Admin identity required.' });
    const admin = await User.findById(adminId).select('role');
    if (!admin || admin.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin only.' });
    }

    const s = await getGlobalSettings();
    if (typeof amount === 'number' && amount >= 0) s.subscriptionAmount = amount;
    if (typeof title === 'string') s.subscriptionTitle = title.trim() || s.subscriptionTitle;
    if (typeof description === 'string') s.subscriptionDesc = description.trim() || s.subscriptionDesc;
    if (typeof enabled === 'boolean') s.subscriptionEnabled = enabled;
    s.updatedAt = new Date();
    await s.save();

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
app.post('/api/subscribe/create', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ success: false, message: 'userId required.' });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const s = await getGlobalSettings();
    if (!s.subscriptionEnabled) {
      return res.status(400).json({ success: false, message: 'Subscription is not enabled by admin yet.' });
    }
    if (!s.subscriptionAmount || s.subscriptionAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Subscription amount not configured.' });
    }

    const planId = await ensureRazorpayPlan(s);

    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      customer_notify: 1,
      quantity: 1,
      total_count: 120,                       // 10 years of monthly cycles
      notes: { userId: String(user._id), purpose: 'aero-all-access' }
    });

    if (!user.subscription) user.subscription = {};
    user.subscription.subscriptionId = subscription.id;
    user.subscription.planId = planId;
    user.subscription.amount = s.subscriptionAmount;
    user.subscription.status = 'pending';
    user.subscription.autoRenew = true;
    await user.save();

    res.json({
      success: true,
      subscriptionId: subscription.id,
      key_id: process.env.RAZORPAY_KEY_ID,
      amount: s.subscriptionAmount,
      title: s.subscriptionTitle,
      description: s.subscriptionDesc
    });
  } catch (e) {
    console.error('[subscribe/create]', e);
    res.status(500).json({ success: false, message: 'Could not start subscription: ' + e.message });
  }
});

/* ---- Student: verify subscription checkout ---- */
app.post('/api/subscribe/verify', async (req, res) => {
  try {
    const { userId, razorpay_subscription_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!userId || !razorpay_subscription_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Missing verification fields.' });
    }

    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_payment_id + '|' + razorpay_subscription_id)
      .digest('hex');

    if (razorpay_signature !== expected) {
      return res.status(400).json({ success: false, message: 'Invalid subscription signature.' });
    }

    let sub = null;
    try { sub = await razorpay.subscriptions.fetch(razorpay_subscription_id); } catch (e) {}

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const s = await getGlobalSettings();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    if (!user.subscription) user.subscription = {};
    user.subscription.active = true;
    user.subscription.status = 'active';
    user.subscription.subscriptionId = razorpay_subscription_id;
    user.subscription.planId = (sub && sub.plan_id) || user.subscription.planId;
    user.subscription.startedAt = user.subscription.startedAt || now;
    user.subscription.expiresAt = expiresAt;
    user.subscription.amount = s.subscriptionAmount;
    user.subscription.autoRenew = true;
    user.subscription.lastPaymentId = razorpay_payment_id;
    user.subscription.history = user.subscription.history || [];
    user.subscription.history.push({
      paymentId: razorpay_payment_id,
      amount: s.subscriptionAmount,
      status: 'charged',
      note: 'Subscription activated',
      date: now
    });
    await user.save();

    res.json({ success: true, message: 'Subscription activated!', user: serializeUser(user) });
  } catch (e) {
    console.error('[subscribe/verify]', e);
    res.status(500).json({ success: false, message: 'Verify failed: ' + e.message });
  }
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
app.get('/api/admin/subscriptions', async (req, res) => {
  try {
    const { adminId } = req.query;
    if (!adminId) return res.status(400).json({ success: false, message: 'adminId required.' });
    const admin = await User.findById(adminId).select('role');
    if (!admin || admin.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin only.' });
    }

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
app.post('/api/admin/subscription/:userId/grant', async (req, res) => {
  try {
    const { adminId, days, note } = req.body || {};
    if (!adminId) return res.status(400).json({ success: false, message: 'adminId required.' });
    const admin = await User.findById(adminId).select('role');
    if (!admin || admin.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only.' });

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
app.post('/api/admin/subscription/:userId/revoke', async (req, res) => {
  try {
    const { adminId, note } = req.body || {};
    if (!adminId) return res.status(400).json({ success: false, message: 'adminId required.' });
    const admin = await User.findById(adminId).select('role');
    if (!admin || admin.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only.' });

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
app.post('/api/admin/subscription/:userId/extend', async (req, res) => {
  try {
    const { adminId, days } = req.body || {};
    if (!adminId) return res.status(400).json({ success: false, message: 'adminId required.' });
    const admin = await User.findById(adminId).select('role');
    if (!admin || admin.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only.' });

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
app.post('/api/razorpay-webhook', express.json(), async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];

    // 1. Verify the webhook signature to ensure it's from Razorpay
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (signature !== expectedSignature) {
      console.error('[Webhook] Invalid signature');
      return res.status(400).send('Invalid signature');
    }

    // 2. Handle the payment.captured event (one-time course purchase)
    const event = req.body.event;
    const payload = req.body.payload || {};

    if (event === 'payment.captured') {
      const payment = payload.payment && payload.payment.entity;
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
      }
    }

    /* ---- SUBSCRIPTION EVENTS ---- */
    if (event === 'subscription.charged' || event === 'subscription.authenticated') {
      const subEntity = (payload.subscription && payload.subscription.entity) || {};
      const payEntity = (payload.payment && payload.payment.entity) || {};
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
      const subEntity = (payload.subscription && payload.subscription.entity) || {};
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
    const user = await User.findById(req.params.userId).select('notifications');
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
app.get('/api/students', async (req, res) => {
  try {
    const students = await User.find({ role: 'student' }).select('-password').sort({ createdAt: -1 });
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
app.post('/api/courses/:courseId/playlists', async (req, res) => {
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
    res.json({ success: true, message: 'Playlist created.', playlist });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error: ' + e.message }); }
});

app.post('/api/courses/:courseId/playlists/auto-videos', async (req, res) => {
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
    res.json({
      success: true,
      message: 'Auto playlist created with ' + videoIds.length + ' video' + (videoIds.length === 1 ? '' : 's') + '.',
      playlist
    });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error: ' + e.message }); }
});

app.put('/api/courses/:courseId/playlists/:playlistId', async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found.' });
    const pl = (course.playlists || []).find(p => p.id === req.params.playlistId);
    if (!pl) return res.status(404).json({ success: false, message: 'Playlist not found.' });
    if (req.body.title !== undefined) pl.title = String(req.body.title).trim();
    if (req.body.description !== undefined) pl.description = String(req.body.description || '').trim();
    if (Array.isArray(req.body.materialIds)) pl.materialIds = req.body.materialIds;
    await course.save();
    res.json({ success: true, message: 'Playlist updated.', playlist: pl });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error: ' + e.message }); }
});

app.delete('/api/courses/:courseId/playlists/:playlistId', async (req, res) => {
  try {
    await Course.findByIdAndUpdate(
      req.params.courseId,
      { $pull: { playlists: { id: req.params.playlistId } } }
    );
    res.json({ success: true, message: 'Playlist deleted.' });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error: ' + e.message }); }
});

app.post('/api/courses/:courseId/playlists/:playlistId/materials', async (req, res) => {
  try {
    const { materialId } = req.body || {};
    if (!materialId) return res.status(400).json({ success: false, message: 'materialId required.' });
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found.' });
    const pl = (course.playlists || []).find(p => p.id === req.params.playlistId);
    if (!pl) return res.status(404).json({ success: false, message: 'Playlist not found.' });
    if (!pl.materialIds.includes(materialId)) pl.materialIds.push(materialId);
    await course.save();
    res.json({ success: true, message: 'Added to playlist.', playlist: pl });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error: ' + e.message }); }
});

app.delete('/api/courses/:courseId/playlists/:playlistId/materials/:materialId', async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found.' });
    const pl = (course.playlists || []).find(p => p.id === req.params.playlistId);
    if (!pl) return res.status(404).json({ success: false, message: 'Playlist not found.' });
    pl.materialIds = pl.materialIds.filter(id => id !== req.params.materialId);
    await course.save();
    res.json({ success: true, message: 'Removed from playlist.', playlist: pl });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error: ' + e.message }); }
});
/* ============================================================
   EMAIL REPLY FETCHER (IMAP)
   ============================================================ */
const fetchEmailReplies = async () => {
  if (!EMAIL_USER || !EMAIL_PASS) return;
  
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

// Run every 3 minutes
setInterval(fetchEmailReplies, 3 * 60 * 1000);

// API Endpoint for admin dashboard
app.get('/api/admin/email-replies', async (req, res) => {
  try {
    const replies = await EmailReply.find().sort({ date: -1 }).limit(50);
    res.json({ success: true, replies });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});
/* ============================================================
   EMAIL SELF-TEST (open in browser to verify sending works)
   ============================================================ */
app.get('/api/admin/test-email', async (req, res) => {
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
   LISTEN
   ============================================================ */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server is running on port ${PORT}`));