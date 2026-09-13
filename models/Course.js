const matrixRowSchema = new mongoose.Schema({
  text:         { type: String, default: '' },
  correctIndex: { type: Number, default: 0 }   // index into matrixRightItems
}, { _id: false });

const quizQuestionSchema = new mongoose.Schema({
  // 'single' | 'multiple' | 'integer' | 'matrix'
  type: { type: String, default: 'single' },

  question:    { type: String, default: '' },
  explanation: { type: String, default: '' },

  // Single + Multiple Correct
  options:        { type: [String], default: [] },
  correctIndexes: { type: [Number], default: [] },

  // Integer / Numerical
  integerAnswer:    { type: Number, default: null },
  integerTolerance: { type: Number, default: 0 },

  // Matrix Match (List-I ↔ List-II)
  matrixLeftItems:      { type: [String], default: [] },
  matrixRightItems:     { type: [String], default: [] },
  matrixRows:           { type: [matrixRowSchema], default: [] },

  // Per-question scoring
  marks:         { type: Number, default: 4 },
  negativeMarks: { type: Number, default: -1 }
}, { _id: true });

const materialSchema = new mongoose.Schema({
  title: { type: String, required: true },
  type:  { type: String, required: true },
  description: String,
  url: String,
  fileData: String,
  fileName: String,
  isPremium: { type: Boolean, default: false },
  price: { type: Number, default: 0 },
  estimatedTime: { type: String, default: '' },
  tags: { type: String, default: '' },

  // NEW — Paper/exam-level config (shown at top of quiz editor)
  examConfig: {
    subject:    { type: String, default: '' },
    paperCode:  { type: String, default: '' },
    totalTime:  { type: String, default: '' },   // e.g. "3 hours"
    totalMarks: { type: Number, default: 0 }
  },

  quiz: [quizQuestionSchema]
});