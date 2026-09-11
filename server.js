const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
const nodemailer = require('nodemailer');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const Course = require('./models/Course');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('🚀 MongoDB Database Successfully Connected!'))
  .catch((err) => console.log('Database Connection Error:', err));

/* ============================================================
   STREAK HELPER
   ============================================================ */
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function bumpStreak(user) {
  const today = todayStr();
  const yesterday = yesterdayStr();

  if (user.lastActiveDate === today) return;

  if (user.lastActiveDate === yesterday) {
    user.streakCount = (user.streakCount || 0) + 1;
  } else {
    user.streakCount = 1;
  }
  user.lastActiveDate = today;
  if ((user.streakCount || 0) > (user.longestStreak || 0)) {
    user.longestStreak = user.streakCount;
  }
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

/* ============================================================
   SETUP ADMIN
   ============================================================ */
app.get('/setup-admin', async (req, res) => {
  try {
    const adminExists = await User.findOne({ role: 'admin' });
    if (adminExists) return res.send('Admin already exists in database!');
    const hashedPassword = await bcrypt.hash('AeroAdmin123', 10);
    const newAdmin = new User({
      username: 'admin',
      password: hashedPassword,
      role: 'admin',
      fullName: 'Aerospace Admin'
    });
    await newAdmin.save();
    res.send('✅ Admin user successfully created! Username: admin | Password: AeroAdmin123');
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

app.get('/', (req, res) => res.send('Aerospace EdTech Backend is Running!'));

/* ============================================================
   AUTH — LOGIN (with streak bump)
   ============================================================ */
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ success: false, message: 'Invalid username or password.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ success: false, message: 'Invalid username or password.' });

    if (user.role === 'student') {
      bumpStreak(user);
      await user.save();
    }

    const token = jwt.sign(
      { id: user._id, role: user.role },
      'SuperSecretAeroKey',
      { expiresIn: '1d' }
    );

    res.json({
      success: true,
      message: 'Login successful!',
      token,
      user: serializeUser(user)
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error: ' + error.message });
  }
});

/* ============================================================
   REGISTRATION — OTP + VERIFY
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
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Aerospace Portal - Registration OTP',
      text: `Welcome to Aerospace Dept!\n\nYour OTP for registration is: ${otp}\n\nPlease do not share this code with anyone.`
    });

    res.json({ success: true, message: 'OTP sent successfully to your email!' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error sending email. Check credentials.' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { fullName, username, email, password, otp } = req.body;
    if (!otpStore[email] || otpStore[email] !== otp) {
      return res.status(400).json({ success: false, message: 'Invalid or Expired OTP. Please try again.' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const newStudent = new User({
      fullName, username, email,
      password: hashedPassword,
      role: 'student'
    });
    await newStudent.save();
    delete otpStore[email];
    res.json({ success: true, message: 'Verification successful! You can now log in.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error: ' + error.message });
  }
});

/* ============================================================
   COURSES — CRUD
   ============================================================ */
app.get('/api/courses', async (req, res) => {
  try { res.json(await Course.find()); }
  catch (error) { res.status(500).json({ message: 'Server error: ' + error.message }); }
});

app.get('/api/courses/:id', async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ success: false, message: 'Course not found' });
    res.json({ success: true, course });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/courses', async (req, res) => {
  try {
    const newCourse = new Course(req.body);
    await newCourse.save();
    res.json({ success: true, message: 'Course created successfully!', course: newCourse });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.put('/api/courses/:id', async (req, res) => {
  try {
    const { name, description, price, isPremium } = req.body;
    await Course.findByIdAndUpdate(req.params.id, {
      $set: { name, description, price, isPremium }
    });
    res.json({ success: true, message: 'Course updated successfully!' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating course.' });
  }
});

app.delete('/api/courses/:id', async (req, res) => {
  try {
    await Course.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Course deleted successfully!' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
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
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.put('/api/courses/:courseId/materials/:materialId', async (req, res) => {
  try {
    const { title, description, isPremium, price } = req.body;
    await Course.updateOne(
      { _id: req.params.courseId, "materials._id": req.params.materialId },
      { $set: {
        "materials.$.title": title,
        "materials.$.description": description,
        "materials.$.isPremium": isPremium,
        "materials.$.price": price
      } }
    );
    res.json({ success: true, message: 'Material updated successfully!' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating material.' });
  }
});

app.delete('/api/courses/:courseId/materials/:materialId', async (req, res) => {
  try {
    await Course.findByIdAndUpdate(
      req.params.courseId,
      { $pull: { materials: { _id: req.params.materialId } } }
    );
    res.json({ success: true, message: 'Material deleted successfully!' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error deleting material.' });
  }
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
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error submitting doubt' });
  }
});

// Legacy: admin reply via the older method — still supported
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
          type: 'doubt-reply',
          title: 'Your doubt was answered!',
          body: `"${answer.slice(0, 100)}${answer.length > 100 ? '…' : ''}"`,
          courseId: req.params.courseId,
          link: `#/course/${req.params.courseId}`,
          read: false,
          createdAt: new Date()
        });
        if (student.notifications.length > 50) {
          student.notifications = student.notifications.slice(-50);
        }
        await student.save();
      }
    }

    res.json({ success: true, message: 'Answer posted!' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error posting answer: ' + error.message });
  }
});

/* ============================================================
   PEER Q&A — replies (Sprint 4)
   ============================================================ */
app.post('/api/courses/:courseId/doubts/:doubtId/replies', async (req, res) => {
  try {
    const { authorName, authorUsername, authorRole, text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ success: false, message: 'Reply text required' });

    await Course.updateOne(
      { _id: req.params.courseId, "doubts._id": req.params.doubtId },
      { $push: { "doubts.$.replies": {
        authorName,
        authorUsername,
        authorRole: authorRole || 'student',
        text: text.trim(),
        date: new Date(),
        isAccepted: false
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
          type: 'doubt-reply',
          title: `${authorName || authorUsername} replied to your doubt`,
          body: `"${text.slice(0, 100)}${text.length > 100 ? '…' : ''}"`,
          courseId: req.params.courseId,
          link: `#/course/${req.params.courseId}`,
          read: false,
          createdAt: new Date()
        });
        if (asker.notifications.length > 50) {
          asker.notifications = asker.notifications.slice(-50);
        }
        await asker.save();
      }
    }

    res.json({ success: true, message: 'Reply posted!' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error posting reply: ' + error.message });
  }
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

    if (!isAsker && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Only the asker or an admin can accept' });
    }

    doubt.replies.forEach(r => { r.isAccepted = false; });
    const reply = doubt.replies.id(req.params.replyId);
    if (!reply) return res.status(404).json({ success: false, message: 'Reply not found' });
    reply.isAccepted = true;

    await course.save();
    res.json({ success: true, message: 'Answer accepted!' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error accepting reply: ' + error.message });
  }
});

/* ============================================================
   QUIZ (Sprint 4)
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
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error saving quiz: ' + error.message });
  }
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
      return {
        correct: isCorrect,
        chosen,
        correctIndex: q.correctIndex,
        explanation: q.explanation || ''
      };
    });

    const total = quiz.length;
    const pct = Math.round((score / total) * 100);

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!user.quizResults) user.quizResults = new Map();

    const prev = user.quizResults.get(req.params.materialId) || { attempts: 0 };
    user.quizResults.set(req.params.materialId, {
      score,
      total,
      attempts: (prev.attempts || 0) + 1,
      lastAttemptAt: new Date()
    });
    await user.save();

    res.json({
      success: true,
      score,
      total,
      percent: pct,
      results,
      attempts: (prev.attempts || 0) + 1
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error grading quiz: ' + error.message });
  }
});

app.get('/api/user/quiz-results/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('quizResults');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    res.json({ success: true, results: Object.fromEntries(user.quizResults || new Map()) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ============================================================
   PAYMENTS — RAZORPAY
   ============================================================ */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

app.post('/api/create-order', async (req, res) => {
  try {
    const { amount } = req.body;
    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: 'INR',
      receipt: 'aero_receipt_' + Math.random().toString(36).substring(7)
    });
    res.json({ success: true, order });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error creating order' });
  }
});

app.post('/api/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, courseId, userId } = req.body;
    const sign = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSign = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(sign.toString())
      .digest('hex');

    if (razorpay_signature === expectedSign) {
      await User.findByIdAndUpdate(userId, { $addToSet: { purchases: courseId } });
      res.json({ success: true, message: 'Payment verified & Course saved to DB!' });
    } else {
      res.status(400).json({ success: false, message: 'Invalid payment signature!' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: 'Verification error' });
  }
});

/* ============================================================
   USER DATA — bookmarks, progress, streaks, notifications
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
    if (idx >= 0) list.splice(idx, 1);
    else list.push(cid);

    user.bookmarks = list;
    await user.save();

    res.json({ success: true, bookmarks: list, bookmarked: idx < 0 });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/api/user/me/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (user.role === 'student') {
      bumpStreak(user);
      await user.save();
    }

    res.json({ success: true, user: serializeUser(user) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
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
    if (viewed === false) {
      arr = arr.filter(x => x !== mid);
    } else {
      if (!arr.includes(mid)) arr.push(mid);
    }
    user.progress.set(cid, arr);

    if (viewed !== false) {
      user.lastActivity = { courseId: cid, materialId: mid, timestamp: new Date() };
      bumpStreak(user);
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
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ============================================================
   NOTIFICATIONS
   ============================================================ */
app.get('/api/user/notifications/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('notifications');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const list = (user.notifications || [])
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 30);

    res.json({ success: true, notifications: list });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/user/notifications/:userId/mark-read', async (req, res) => {
  try {
    const { notifId, all } = req.body;
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (all) {
      user.notifications.forEach(n => { n.read = true; });
    } else if (notifId) {
      const n = user.notifications.find(x => x.id === notifId);
      if (n) n.read = true;
    }
    await user.save();

    res.json({ success: true, notifications: user.notifications });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ============================================================
   STUDENTS LIST (admin)
   ============================================================ */
app.get('/api/students', async (req, res) => {
  try {
    const students = await User.find({ role: 'student' }).select('-password');
    res.json({ success: true, students });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server is running on port ${PORT}`));