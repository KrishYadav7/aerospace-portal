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

  quiz: [{
    question:     { type: String, required: true },
    options:      { type: [String], default: [] },
    correctIndex: { type: Number, default: 0 },
    explanation:  { type: String, default: '' }
  }]
});

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

const announcementSchema = new mongoose.Schema({
  id:         String,
  title:      String,
  body:       String,
  authorName: String,
  date:       { type: Date, default: Date.now }
});

const playlistSchema = new mongoose.Schema({
  id:          { type: String, required: true },
  title:       { type: String, required: true },
  description: { type: String, default: '' },
  materialIds: { type: [String], default: [] },
  createdAt:   { type: Date, default: Date.now }
});

const courseSchema = new mongoose.Schema({
  name: { type: String, required: true },
  code: { type: String, required: true },
  semester: String,
  instructor: String,
  description: String,

  category:   { type: String, default: 'General' },
  difficulty: { type: String, default: 'Intermediate' },
  duration:   { type: String, default: '' },
  learningOutcomes: { type: [String], default: [] },
  thumbnail:  { type: String, default: '' },
  status:     { type: String, default: 'published' },
  featured:   { type: Boolean, default: false },

  isPremium: { type: Boolean, default: false },
  price:     { type: Number, default: 0 },

  materials: [materialSchema],
  doubts:    [doubtSchema],
  announcements: [announcementSchema],
  playlists: [playlistSchema]
}, { timestamps: true });

module.exports = mongoose.model('Course', courseSchema);