const mongoose = require('mongoose');

const materialSchema = new mongoose.Schema({
  title: { type: String, required: true },
  type: { type: String, required: true },
  description: String,
  url: String,
  fileData: String,
  fileName: String,
  isPremium: { type: Boolean, default: false }, // <-- Database ab isko save karega
  price: { type: Number, default: 0 }           // <-- Database ab amount save karega
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
  doubts: [{
    studentName: String,
    question: String,
    answer: String
  }]
}, { timestamps: true });

module.exports = mongoose.model('Course', courseSchema);