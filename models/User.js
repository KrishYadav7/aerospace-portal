const mongoose = require('mongoose');

// User ka blueprint (Schema) banate hain
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true }, // Ye password encrypt hokar save hoga
  role: { type: String, enum: ['student', 'admin'], default: 'student' },
  fullName: { type: String },
  email: { type: String },
  purchases: [{ type: String }] // Student ne jo premium courses kharide hain
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);