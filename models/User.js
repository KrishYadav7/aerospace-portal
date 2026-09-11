const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role:     { type: String, default: 'student' },
  fullName: String,
  email:    String,

  // Existing
  purchases: { type: [String], default: [] },

  // Sprint 2 additions
  bookmarks: { type: [String], default: [] },
  progress:  { type: Map, of: [String], default: {} },
  lastActivity: {
    courseId:   { type: String, default: null },
    materialId: { type: String, default: null },
    timestamp:  { type: Date,   default: null }
  }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);