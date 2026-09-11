const mongoose = require('mongoose');

// Material ka structure (PDFs, Videos, etc.)
const materialSchema = new mongoose.Schema({
  title: { type: String, required: true },
  type: { type: String, required: true }, // video, pyq, tutorial, slides
  description: String,
  url: String,
  fileData: String,
  fileName: String,
  date: { type: Date, default: Date.now }
});

// Main Course ka structure
const courseSchema = new mongoose.Schema({
  name: { type: String, required: true },
  code: { type: String, required: true },
  semester: String,
  instructor: String,
  description: String,
  isPremium: { type: Boolean, default: false },
  price: { type: Number, default: 0 },
  materials: [materialSchema] // Course ke andar uske saare materials ki list
}, { timestamps: true });
// Purana materials array yahan hoga...
  doubts: [{
    studentName: String,
    question: String,
    answer: { type: String, default: "" }, // Admin ka jawaab
    date: { type: Date, default: Date.now }
  }]
materials: [{
  title: String,
  type: String,
  description: String,
  url: String,
  fileData: String,
  fileName: String,
  isPremium: { type: Boolean, default: false },
  price: { type: Number, default: 0 } // <-- Yeh line add karni hai
}]
module.exports = mongoose.model('Course', courseSchema);
