const mongoose = require('mongoose');

const materialSchema = new mongoose.Schema({
  title: { type: String, required: true },
  type: { type: String, required: true },
  description: String,
  url: String,
  fileData: String,
  fileName: String,
  isPremium: { type: Boolean, default: false },
  price: { type: Number, default: 0 },

  // Sprint 4 — quiz
  quiz: [{
    question:     { type: String, required: true },
    options:      { type: [String], default: [] },
    correctIndex: { type: Number, default: 0 },
    explanation:  { type: String, default: '' }
  }]
});

// Sprint 4 — peer Q&A replies
const replySchema = new mongoose.Schema({
  authorName:     String,
  authorUsername: String,
  authorRole:     { type: String, default: 'student' },
  text:           { type: String, required: true },
  date:           { type: Date, default: Date.now },
  isAccepted:     { type: Boolean, default: false }
});

const doubtSchema = new mongoose.Schema({
  studentName: String,
  studentUsername: String,
  studentEmail: String,
  question: String,
  answer: String,
  date: { type: Date, default: Date.now },
  replies: [replySchema]
});

const courseSchema = new mongoose.Schema({
  name: { type: String, required: true },
  code: { type: String, required: true },
  semester: String,
  instructor: String,
  description: String,
  isPremium: { type: Boolean, default: false },
  price: { type: Number, default: 0 },
  materials: [materialSchema],
  doubts: [doubtSchema]
}, { timestamps: true });

module.exports = mongoose.model('Course', courseSchema);