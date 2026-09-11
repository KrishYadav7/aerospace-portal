const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role:     { type: String, default: 'student' },
  fullName: String,
  email:    String,

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

  quizResults: { type: Map, of: Object, default: {} }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);