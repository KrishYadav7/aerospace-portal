const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role:     { type: String, default: 'student' },
  fullName: String,
  email:    String,
  phone:    { type: String, default: '' },

  purchases: { type: [String], default: [] },

  bookmarks: { type: [String], default: [] },
  progress:  { type: Map, of: [String], default: {} },
  lastActivity: {
    courseId:   { type: String, default: null },
    materialId: { type: String, default: null },
    timestamp:  { type: Date,   default: null }
  },

  streakCount:    { type: Number, default: 0 },
  longestStreak:  { type: Number, default: 0 },
  lastActiveDate: { type: String, default: null },

  notifications: [{
    id:        { type: String },
    type:      { type: String, default: 'info' },
    title:     { type: String },
    body:      { type: String },
    courseId:  { type: String, default: null },
    link:      { type: String, default: null },
    read:      { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
  }],

  quizResults: { type: Map, of: Object, default: {} },

  /* ============================================================
     SUBSCRIPTION / AUTO-PAY
     ============================================================ */
  subscription: {
    active:         { type: Boolean, default: false },
    status:         { type: String,  default: 'none' },     // none | pending | active | expired | cancelled | halted
    planId:         { type: String,  default: null },       // Razorpay plan_id
    subscriptionId: { type: String,  default: null },       // Razorpay subscription_id
    startedAt:      { type: Date,    default: null },
    expiresAt:      { type: Date,    default: null },
    amount:         { type: Number,  default: 0 },          // ₹ / month
    autoRenew:      { type: Boolean, default: false },
    lastPaymentId:  { type: String,  default: null },
    history: [{
      paymentId: String,
      amount:    Number,
      status:    String,                                     // charged | granted | revoked | failed | refunded
      note:      String,
      date:      { type: Date, default: Date.now }
    }]
  },

  /* ============================================================
     ANALYTICS — rolling log of study events
     Kept small by deduping per (date, courseId, materialId, type)
     Capped at 3000 entries (drop oldest on overflow).
     ============================================================ */
  activityLog: [{
    date:       { type: String },                          // 'YYYY-MM-DD'
    timestamp:  { type: Date, default: Date.now },
    type:       { type: String, default: 'view' },         // 'view' | 'quiz'
    courseId:   { type: String, default: null },
    materialId: { type: String, default: null },
    score:      { type: Number, default: null },           // for quiz events
    total:      { type: Number, default: null }            // for quiz events
  }]
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);