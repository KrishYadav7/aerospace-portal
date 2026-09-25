const mongoose = require('mongoose');

/* ---------- Organization profile (Owner / Head Owner) ---------- */
const ownerProfileSchema = new mongoose.Schema({
  name:  { type: String, default: 'Krish Yadav' },
  title: { type: String, default: 'Founder & Course Director' },
  role:  { type: String, default: 'Founder' },
  bio:   { type: String, default: '' },
  email: { type: String, default: '' },
  phone: { type: String, default: '' },
  photo: { type: String, default: '' },
  visible: { type: Boolean, default: true },   // ⭐ admin can hide founder section
  updatedAt: { type: Date, default: Date.now }
}, { _id: false });

/* ---------- Subscription Plan (multi-tier) ---------- */
const planSchema = new mongoose.Schema({
  id:             { type: String, required: true },   // e.g. 'plan_6m', 'plan_custom_xyz'
  title:          { type: String, required: true },
  description:    { type: String, default: '' },
  durationDays:   { type: Number, required: true, min: 1 },
  amount:         { type: Number, required: true, min: 0 },
  badge:          { type: String, default: '' },      // 'Popular' | 'Best Value' | ''
  featured:       { type: Boolean, default: false },
  enabled:        { type: Boolean, default: true },
  razorpayPlanId: { type: String, default: null },    // cached, created on demand
  createdAt:      { type: Date, default: Date.now }
}, { _id: false });

const DEFAULT_PLANS = [
  {
    id: 'plan_1m',
    title: '1-Month Premium',
    description: 'Full access to every course, quiz, and premium material for 30 days.',
    durationDays: 30,
    amount: 499,
    badge: '',
    featured: false,
    enabled: true,
    razorpayPlanId: null
  },
  {
    id: 'plan_6m',
    title: '6-Month Premium',
    description: 'Six months of unlimited all-access. Save over the monthly plan.',
    durationDays: 180,
    amount: 2499,
    badge: 'Popular',
    featured: true,
    enabled: true,
    razorpayPlanId: null
  },
  {
    id: 'plan_12m',
    title: '12-Month Premium',
    description: 'A full year of every course — best value for serious learners.',
    durationDays: 365,
    amount: 4499,
    badge: 'Best Value',
    featured: false,
    enabled: true,
    razorpayPlanId: null
  }
];

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'global' },

  /* ---------- Legacy fields (kept for backward compat) ---------- */
  subscriptionEnabled: { type: Boolean, default: false },
  subscriptionAmount:  { type: Number,  default: 499 },
  subscriptionTitle:   { type: String,  default: 'All-Access Premium' },
  subscriptionDesc:    { type: String,  default: 'Unlock every course and all premium materials on the platform.' },
  razorpayPlanId:      { type: String,  default: null },

  /* ---------- NEW: Multi-tier subscription plans ---------- */
  subscriptionPlans: {
    type: [planSchema],
    default: () => DEFAULT_PLANS.map(p => ({ ...p }))
  },

  /* ---------- NEW: Referral program ---------- */
  referralEnabled:      { type: Boolean, default: false },
  referralThreshold:    { type: Number,  default: 3, min: 1 },
  referralRewardDays:   { type: Number,  default: 30, min: 1 },
  referralRewardTitle:  { type: String,  default: '1 Month Free Premium' },
  referralRewardDesc:   { type: String,  default: 'Reward every time your referrals hit the required threshold.' },

  /* Organization owner profile */
  ownerProfile: {
    type: ownerProfileSchema,
    default: () => ({
      name:  'Krish Yadav',
      title: 'Founder & Course Director',
      role:  'Founder',
      bio:   'Academic achiever and experienced educator currently pursuing Aerospace Engineering at IIT Kharagpur. Passionate about translating complex mathematical and engineering principles into accessible concepts. Proven track record in mentoring 2,000+ students and producing structured academic content across core engineering subjects and competitive mathematics.',
      email: '',
      phone: '',
      photo: '',
      visible: true
    })
  },

  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

const Settings = mongoose.model('Settings', settingsSchema);
module.exports = Settings;
module.exports.DEFAULT_PLANS = DEFAULT_PLANS;