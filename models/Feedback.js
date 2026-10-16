const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema({
  studentName:     { type: String, default: '' },
  studentUsername: { type: String, default: '' },
  /* ⭐ 2026-10-16 — the signed-in author's User _id, when known */
  studentId:       { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  studentEmail:    { type: String, default: '' },

  courseId:        { type: String, default: null },
  courseName:      { type: String, default: '' },

  rating:          { type: Number, min: 1, max: 5, default: 5 },
  title:           { type: String, default: '', trim: true },
  message:         { type: String, required: true, trim: true },

  // Moderation — feedback is INVISIBLE until admin approves
  status:          { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  approvedAt:      { type: Date, default: null },
  approvedBy:      { type: String, default: null },

  submittedAt:     { type: Date, default: Date.now }
}, { timestamps: true });

feedbackSchema.index({ status: 1, approvedAt: -1 });
feedbackSchema.index({ submittedAt: -1 });
feedbackSchema.index({ studentUsername: 1 });

module.exports = mongoose.model('Feedback', feedbackSchema);