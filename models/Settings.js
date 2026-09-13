const mongoose = require('mongoose');

/* ---------- Organization profile (Owner / Head Owner) ---------- */
const ownerProfileSchema = new mongoose.Schema({
  name:  { type: String, default: 'Krish Yadav' },
  title: { type: String, default: 'Founder & Course Director' },
  role:  { type: String, default: 'Founder' },       // e.g. Founder, Head Owner, Director
  bio:   { type: String, default: '' },
  email: { type: String, default: '' },
  phone: { type: String, default: '' },
  photo: { type: String, default: '' },              // base64 data URL
  updatedAt: { type: Date, default: Date.now }
}, { _id: false });

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'global' },

  subscriptionEnabled: { type: Boolean, default: false },
  subscriptionAmount:  { type: Number,  default: 499 },
  subscriptionTitle:   { type: String,  default: 'All-Access Monthly Pass' },
  subscriptionDesc:    { type: String,  default: 'Unlock every course and all premium materials on the platform. Renews automatically every month.' },

  razorpayPlanId:      { type: String,  default: null },

  /* Organization owner profile — editable from admin dashboard */
  ownerProfile: {
    type: ownerProfileSchema,
    default: () => ({
      name:  'Krish Yadav',
      title: 'Founder & Course Director',
      role:  'Founder',
      bio:   'Academic achiever and experienced educator currently pursuing Aerospace Engineering at IIT Kharagpur. Passionate about translating complex mathematical and engineering principles into accessible concepts. Proven track record in mentoring 2,000+ students and producing structured academic content across core engineering subjects and competitive mathematics.',
      email: '',
      phone: '',
      photo: ''
    })
  },

  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('Settings', settingsSchema);