const mongoose = require('mongoose');

/* ---------- Matrix Match row (one row of List-I with its correct List-II answer) ---------- */
const matrixRowSchema = new mongoose.Schema({
  text:         { type: String, default: '' },
  correctIndex: { type: Number, default: 0 }
}, { _id: false });

/* ---------- Quiz Question (supports 6 types) ---------- */
const quizQuestionSchema = new mongoose.Schema({
  type: { type: String, default: 'single' },
  // single | multiple | integer | numerical | matrix | subjective

  question:    { type: String, default: '' },
  explanation: { type: String, default: '' },

  options:        { type: [String], default: [] },
  correctIndexes: { type: [Number], default: [] },

  /* Integer — exact match with optional ±tolerance */
  integerAnswer:    { type: Number, default: null },
  integerTolerance: { type: Number, default: 0 },

  /* Numerical Range — answer accepted if rangeMin ≤ answer ≤ rangeMax */
  rangeMin: { type: Number, default: null },
  rangeMax: { type: Number, default: null },

  /* Subjective — file uploads, admin manually evaluates */
  subjectiveMaxMarks: { type: Number, default: 10 },
  subjectiveInstructions: { type: String, default: '' },

  matrixLeftItems:  { type: [String], default: [] },
  matrixRightItems: { type: [String], default: [] },
  matrixRows:       { type: [matrixRowSchema], default: [] },

  marks:         { type: Number, default: 4 },
  negativeMarks: { type: Number, default: -1 }
}, { _id: true });

/* ---------- Material ---------- */
const materialSchema = new mongoose.Schema({
  title: { type: String, required: true },
  type:  { type: String, required: true },
  description: String,

  url:      String,   // primary URL — usually '/uploads/xxx.pdf' (disk, fast)
  cloudUrl: String,   // Cloudinary backup — used to restore disk after deploy
  fileData: String,   // legacy base64 (do not use for new uploads)
  fileName: String,

  cloudinaryPublicId: { type: String, default: '' },  // for deletion on Cloudinary

  isPremium: { type: Boolean, default: false },
  price: { type: Number, default: 0 },
  estimatedTime: { type: String, default: '' },
  tags: { type: String, default: '' },

  examConfig: {
    subject:    { type: String, default: '' },
    paperCode:  { type: String, default: '' },
    totalTime:  { type: String, default: '' },
    totalMarks: { type: Number, default: 0 }
  },

  quiz: [quizQuestionSchema]
});

/* ---------- Q&A ---------- */
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

/* ---------- Announcements ---------- */
const announcementSchema = new mongoose.Schema({
  id:         String,
  title:      String,
  body:       String,
  authorName: String,
  date:       { type: Date, default: Date.now }
});

/* ---------- Playlists ---------- */
const playlistSchema = new mongoose.Schema({
  id:          { type: String, required: true },
  title:       { type: String, required: true },
  description: { type: String, default: '' },
  materialIds: { type: [String], default: [] },
  createdAt:   { type: Date, default: Date.now }
});

/* ---------- Course ---------- */
const courseSchema = new mongoose.Schema({
  name: { type: String, required: true },
  code: { type: String, required: true },
  semester: String,
  instructor: String,
  description: String,

  category:   { type: String, default: 'General' },
  difficulty: { type: String, default: 'Intermediate' },
  duration:   { type: String, default: '' },
  credits:    { type: Number, default: 0 },
  language:   { type: String, default: '' },
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

courseSchema.index({ status: 1, createdAt: -1 });
courseSchema.index({ code: 1 });
courseSchema.index({ featured: -1, createdAt: -1 });
courseSchema.index({ createdAt: -1 });
courseSchema.index({ status: 1, featured: -1 });
courseSchema.index({ name: 'text', code: 'text', description: 'text' });
// Fast lookup by filename for the disk-miss → Cloudinary fallback path
courseSchema.index({ 'materials.url': 1 });
courseSchema.index({ 'materials.cloudinaryPublicId': 1 });

module.exports = mongoose.model('Course', courseSchema);