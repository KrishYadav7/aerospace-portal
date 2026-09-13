const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'global' },

  subscriptionEnabled: { type: Boolean, default: false },
  subscriptionAmount:  { type: Number,  default: 499 },     // ₹ / month
  subscriptionTitle:   { type: String,  default: 'All-Access Monthly Pass' },
  subscriptionDesc:    { type: String,  default: 'Unlock every course and all premium materials on the platform. Renews automatically every month.' },

  razorpayPlanId:      { type: String,  default: null },
  updatedAt:           { type: Date,    default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('Settings', settingsSchema);