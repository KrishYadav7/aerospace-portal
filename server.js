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

const app = express();

/* ============================================================
   SECURITY & PERFORMANCE MIDDLEWARE
   ============================================================ */
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
  windowMs: 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again in a minute.' }
});
app.use('/api/', apiLimiter);
app.use('/api/login', authLimiter);
app.use('/api/send-otp', authLimiter);
app.use('/api/register', authLimiter);

/* ============================================================
   JWT SECRET
   ============================================================ */
const JWT_SECRET = process.env.JWT_SECRET || 'SuperSecretAeroKey';
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  WARNING: JWT_SECRET not set. Using insecure fallback.');
}

/* ============================================================
   DB
   ============================================================ */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('🚀 MongoDB Database Successfully Connected!'))
  .catch((err) => console.log('Database Connection Error:', err));

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
    quizResults: Object.fromEntries(user.quizResults || new Map())
  };
}

function extractYouTubeId(url) {
  if (!url) return null;
  const m = String(url).match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

/* ============================================================
   ACTIVITY LOG HELPERS
   ============================================================ */
const ACTIVITY_LOG_MAX = 3000;

/**
 * Append a study event to user.activityLog.
 * Deduped per (date, courseId, materialId, type) so repeated opens
 * on the same day don't bloat the log.
 */
function logActivity(user, { type, courseId, materialId, score, total }) {
  if (!user) return;
  if (!user.activityLog) user.activityLog = [];
  const date = todayStr();
  const exists = user.activityLog.some(a =>
    a.date === date &&
    a.type === type &&
    (a.courseId || null) === (courseId || null) &&
    (a.materialId || null) === (materialId || null)
  );
  if (exists) return;

  user.activityLog.push({
    date,
    timestamp: new Date(),
    type: type || 'view',
    courseId: courseId || null,
    materialId: materialId || null,
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
    const hashedPassword = await bcrypt.hash('AeroAdmin123', 10);
    await new User({ username: 'admin', password: hashedPassword, role: 'admin', fullName: 'Aerospace Admin' }).save();
    res.send('✅ Admin created! Username: admin | Password: AeroAdmin123');
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

app.get('/', (req, res) => res.send('Aerospace EdTech Backend is Running!'));

/* ============================================================
   AUTH
   ============================================================ */
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ success: false, message: 'Invalid username or password.' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ success: false, message: 'Invalid username or password.' });

    if (user.role === 'student') { bumpStreak(user); await user.save(); }

    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '1d' });
    res.json({ success: true, message: 'Login successful!', token, user: serializeUser(user) });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error: ' + e.message }); }
});

/* ============================================================
   REGISTRATION — Self-service (OTP)
   ============================================================ */
const otpStore = {};
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

app.post('/api/send-otp', async (req, res) => {
  try {
    const { email, username } = req.body;
    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
    if (existingUser) return res.status(400).json({ success: false, message: 'Username or Email already exists!' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[email] = otp;
    await transporter.sendMail({
      from: process.env.EMAIL_USER, to: email,
      subject: 'Aerospace Portal - Registration OTP',
      text: `Welcome!\n\nYour OTP: ${otp}\n\nDo not share this.`
    });
    res.json({ success: true, message: 'OTP sent!' });
  } catch (e) { res.status(500).json({ success: false, message: 'Error sending email.' }); }
});

app.post('/api/register', async (req, res) => {
  try {
    const { fullName, username, email, password, otp } = req.body;
    if (!otpStore[email] || otpStore[email] !== otp) return res.status(400).json({ success: false, message: 'Invalid or Expired OTP.' });
    const hashedPassword = await bcrypt.hash(password, 10);
    await new User({ fullName, username, email, password: hashedPassword, role: 'student' }).save();
    delete otpStore[email];
    res.json({ success: true, message: 'Verification successful! You can now log in.' });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error: ' + e.message }); }
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
    if (username.length < 3) return res.status(400).json({ success: false, message: 'Username must be at least 3 characters.' });
    if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });

    const existingUsername = await User.findOne({ username });
    if (existingUsername) return res.status(400).json({ success: false, message: 'Username is already taken.' });

    if (email) {
      const existingEmail = await User.findOne({ email });
      if (existingEmail) return res.status(400).json({ success: false, message: 'Email is already registered.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newStudent = new User({
      fullName: fullName.trim(),
      username: username.trim().toLowerCase(),
      email: email ? email.trim() : '',
      password: hashedPassword,
      role: 'student'
    });
    await newStudent.save();

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

    // Log analytics
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

    /* ---- Summary ---- */
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

    /* ---- Heatmap — last 365 days ---- */
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

    /* ---- Weekly activity — last 12 weeks ---- */
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

    /* ---- Quiz trend — last 20 attempts ---- */
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

    /* ---- Course progress ---- */
    const allCourses = await Course.find().select('name code materials');
    const courseProgress = [];
    allCourses.forEach(c => {
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

    res.json({
      success: true,
      analytics: {
        summary,
        heatmap,
        weekly,
        quizTrend,
        courseProgress
      }
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
    const { amount } = req.body;
    const order = await razorpay.orders.create({
      amount: amount * 100, currency: 'INR',
      receipt: 'aero_receipt_' + Math.random().toString(36).substring(7)
    });
    res.json({ success: true, order });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error creating order' }); }
});

app.post('/api/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, courseId, userId } = req.body;
    const sign = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSign = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(sign.toString()).digest('hex');
    if (razorpay_signature === expectedSign) {
      await User.findByIdAndUpdate(userId, { $addToSet: { purchases: courseId } });
      res.json({ success: true, message: 'Payment verified & Course saved!' });
    } else {
      res.status(400).json({ success: false, message: 'Invalid payment signature!' });
    }
  } catch (e) { res.status(500).json({ success: false, message: 'Verification error' }); }
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
      // Log analytics event
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
      if (!owns && user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Purchase required.' });
      }
    }

    const url = String(mat.url).trim();
    const ytId = extractYouTubeId(url);

    if (ytId) {
      return res.json({
        success: true,
        kind: 'youtube',
        videoId: ytId,
        title: mat.title,
        expiresAt: Date.now() + (2 * 60 * 60 * 1000)
      });
    }

    if (!/^https?:\/\//i.test(url) && !/^blob:/i.test(url)) {
      return res.status(400).json({ success: false, message: 'Unsupported video URL.' });
    }

    res.json({
      success: true,
      kind: 'direct',
      directUrl: url,
      title: mat.title,
      expiresAt: Date.now() + (2 * 60 * 60 * 1000)
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
   LISTEN
   ============================================================ */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server is running on port ${PORT}`));