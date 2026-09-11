const mongoose = require('mongoose');

const materialSchema = new mongoose.Schema({
  title: { type: String, required: true },
  type: { type: String, required: true },
  description: String,
  url: String,
  fileData: String,
  fileName: String,
  isPremium: { type: Boolean, default: false },
  price: { type: Number, default: 0 }
});

// Naya: Student ki basic details save karne ke liye
const doubtSchema = new mongoose.Schema({
  studentName: String,
  studentUsername: String,
  studentEmail: String,
  question: String,
  answer: String,
  date: { type: Date, default: Date.now }
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