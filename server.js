// Zaroori packages import kar rahe hain
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
const nodemailer = require('nodemailer');
const Razorpay = require('razorpay');
const crypto = require('crypto'); // Ye security/verification ke liye hai
// App initialize karna
const app = express();

// Middlewares
app.use(cors()); // Frontend ko access dene ke liye
// Middlewares (Ab hum 50MB tak ki files allow kar rahe hain)
app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Database (MongoDB) se connect karna
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('🚀 MongoDB Database Successfully Connected!'))
  .catch((err) => console.log('Database Connection Error:', err));
  const bcrypt = require('bcrypt');
const User = require('./models/User'); 

// Pehla admin banane ka temporary rasta
app.get('/setup-admin', async (req, res) => {
  try {
    const adminExists = await User.findOne({ role: 'admin' });
    if (adminExists) {
      return res.send('Admin already exists in database!');
    }

    // Password ko mathematically secure (hash) kar rahe hain
    const hashedPassword = await bcrypt.hash('AeroAdmin123', 10); 

    // Naya admin bana rahe hain
    const newAdmin = new User({
      username: 'admin',
      password: hashedPassword,
      role: 'admin',
      fullName: 'Aerospace Admin' 
    });

    await newAdmin.save(); // Data MongoDB mein save ho jayega
    res.send('✅ Admin user successfully created! Username: admin | Password: AeroAdmin123');
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});

// Ek chhota sa test route
app.get('/', (req, res) => {
  res.send('Aerospace EdTech Backend is Running!');
});
const jwt = require('jsonwebtoken'); // Secure login session ke liye

// API: User Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // 1. Check karte hain ki user database mein hai ya nahi
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid username or password.' });
    }

    // 2. Password match karte hain (Bcrypt ke zariye)
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Invalid username or password.' });
    }

    // 3. Agar sab sahi hai, toh ek secure Token (Ticket) banate hain
    const token = jwt.sign(
      { id: user._id, role: user.role }, 
      'SuperSecretAeroKey', // Real project mein isey .env mein rakhte hain
      { expiresIn: '1d' }
    );

    // 4. Frontend ko token aur user data bhejte hain
    res.json({ 
      success: true, 
      message: 'Login successful!',
      token: token,
      user: { username: user.username, role: user.role, fullName: user.fullName } 
    });

  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error: ' + error.message });
  }
});
// API: Student Registration
// =========================================================
// OTP VERIFICATION SETUP
// =========================================================
const otpStore = {}; // Temporary memory jahan hum OTP yaad rakhenge

// Email bhejne ka setup (Apna Email aur App Password yahan dalein)
// Email bhejne ka setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER, // Ab password yahan nahi dikhega!
    pass: process.env.EMAIL_PASS
  }
});

// API 1: Email par OTP bhejna
app.post('/api/send-otp', async (req, res) => {
  try {
    const { email, username } = req.body;

    // Check karein ki user pehle se toh nahi hai
    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Username or Email already exists!' });
    }

    // 6-digit ka random OTP generate karna
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[email] = otp; // OTP ko email ke naam se memory mein save kiya

    // Student ko Email bhejna
    const mailOptions = {
   from: process.env.EMAIL_USER,
  to: email,
      subject: 'Aerospace Portal - Registration OTP',
      text: `Welcome to Aerospace Dept!\n\nYour OTP for registration is: ${otp}\n\nPlease do not share this code with anyone.`
    };

    await transporter.sendMail(mailOptions);
    res.json({ success: true, message: 'OTP sent successfully to your email!' });

  } catch (error) {
    res.status(500).json({ success: false, message: 'Error sending email. Check credentials.' });
  }
});

// API 2: OTP Verify karke User ko Save karna
app.post('/api/register', async (req, res) => {
  try {
    const { fullName, username, email, password, otp } = req.body;

    // OTP Check karna
    if (!otpStore[email] || otpStore[email] !== otp) {
      return res.status(400).json({ success: false, message: 'Invalid or Expired OTP. Please try again.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newStudent = new User({
      fullName,
      username,
      email,
      password: hashedPassword,
      role: 'student'
    });

    await newStudent.save();
    
    delete otpStore[email]; // Kaam hone ke baad OTP ko memory se delete kar diya

    res.json({ success: true, message: 'Verification successful! You can now log in.' });

  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error: ' + error.message });
  }
});
const Course = require('./models/Course'); // Course model ko import kiya

// API: Saare courses mangwane ke liye (Get Courses)
app.get('/api/courses', async (req, res) => {
  try {
    const courses = await Course.find(); // Database se saare courses fetch karega
    res.json(courses);
  } catch (error) {
    res.status(500).json({ message: 'Server error: ' + error.message });
  }
});

// API: Naya course banane ke liye (Add Course - Admin only)
app.post('/api/courses', async (req, res) => {
  try {
    const newCourse = new Course(req.body);
    await newCourse.save(); // Database mein naya course save karega
    res.json({ success: true, message: 'Course created successfully!', course: newCourse });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error: ' + error.message });
  }
});
// API: Course ke andar naya Material (PDF/Video) add karna
app.post('/api/courses/:courseId/materials', async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ message: 'Course not found' });

    // Naya material course ke materials list mein daal rahe hain
    course.materials.push(req.body);
    await course.save();
    
    res.json({ success: true, message: 'Material added successfully!', course });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error: ' + error.message });
  }
});
// API: Course ko database se Delete karna
app.delete('/api/courses/:id', async (req, res) => {
  try {
    // Database mein ID dhoondh kar delete karna
    await Course.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Course deleted successfully!' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error: ' + error.message });
  }
});
// =========================================================
// EDIT APIs (COURSES & MATERIALS)
// =========================================================

// 1. Course Edit karne ki API
// 1. Course Edit karne ki API
app.put('/api/courses/:id', async (req, res) => {
  try {
    const { name, description, price, isPremium } = req.body;
    
    // $set use karna zaroori hai taaki exactly yehi fields database mein force update hon
    await Course.findByIdAndUpdate(req.params.id, { 
      $set: { name, description, price, isPremium } 
    });
    
    res.json({ success: true, message: 'Course updated successfully!' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating course.' });
  }
});

// 2. Material Edit karne ki API (Course ke andar)
app.put('/api/courses/:courseId/materials/:materialId', async (req, res) => {
  try {
    // Ab hum isPremium aur price dono frontend se le rahe hain
    const { title, description, isPremium, price } = req.body;
    
    await Course.updateOne(
      { _id: req.params.courseId, "materials._id": req.params.materialId },
      { $set: { 
          "materials.$.title": title, 
          "materials.$.description": description,
          "materials.$.isPremium": isPremium, // Backend mein update
          "materials.$.price": price          // Amount update
        } 
      }
    );
    res.json({ success: true, message: 'Material updated successfully!' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error updating material.' });
  }
});
// =========================================================
// RAZORPAY PAYMENT APIs
// =========================================================

// 1. Razorpay Setup (Passwords .env se aayenge)
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// 2. Naya Order Banane ki API
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount } = req.body; 
    const options = {
      amount: amount * 100, // Razorpay paise mein amount leta hai (100 paise = 1 INR)
      currency: "INR",
      receipt: "aero_receipt_" + Math.random().toString(36).substring(7),
    };
    const order = await razorpay.orders.create(options);
    res.json({ success: true, order });
  } catch (error) {
    console.error("Order Error:", error);
    res.status(500).json({ success: false, message: 'Server error creating order' });
  }
});

// 3. Payment Verify karne ki API
// 3. Payment Verify & Database mein Save karne ki API
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, courseId, userId } = req.body;
    
    // Security check
    const sign = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSign = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
                               .update(sign.toString())
                               .digest("hex");

    if (razorpay_signature === expectedSign) {
      // Payment Asli hai! Ab course ko MongoDB mein student ke account mein save karein
      await User.findByIdAndUpdate(userId, { 
        $addToSet: { purchases: courseId } 
      });

      res.json({ success: true, message: "Payment verified & Course saved to DB!" });
    } else {
      res.status(400).json({ success: false, message: "Invalid payment signature!" });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Verification error' });
  }
});

// API: Admin ke liye saare Registered Students mangwana
app.get('/api/students', async (req, res) => {
  try {
    // Database se sirf un users ko nikalna jinka role 'student' hai (password hide kar denge)
    const students = await User.find({ role: 'student' }).select('-password');
    res.json({ success: true, students });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error: ' + error.message });
  }
});
// =========================================================
// DOUBT & Q&A APIs
// =========================================================

// 1. Student ka naya doubt save karna (Extra details ke sath)
app.post('/api/courses/:id/doubts', async (req, res) => {
  try {
    const { studentName, studentUsername, studentEmail, question } = req.body;
    await Course.findByIdAndUpdate(req.params.id, {
      $push: { 
        doubts: { 
          studentName, 
          studentUsername, 
          studentEmail, 
          question,
          date: new Date() // Date save karne ke liye
        } 
      }
    });
    res.json({ success: true, message: 'Doubt submitted successfully!' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error submitting doubt' });
  }
});

// 2. Admin ka jawaab save karna
app.put('/api/courses/:courseId/doubts/:doubtId', async (req, res) => {
  try {
    const { answer } = req.body;
    await Course.updateOne(
      { _id: req.params.courseId, "doubts._id": req.params.doubtId },
      { $set: { "doubts.$.answer": answer } }
    );
    res.json({ success: true, message: 'Answer posted!' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error posting answer' });
  }
});
// API: Ek specific course ko id se mangwana (View Course Fix)
app.get('/api/courses/:id', async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }
    res.json({ success: true, course });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error: ' + error.message });
  }
});
// API: Course ke andar se specific Material delete karna
app.delete('/api/courses/:courseId/materials/:materialId', async (req, res) => {
  try {
    // $pull operator use karke array se material remove karenge
    await Course.findByIdAndUpdate(
      req.params.courseId,
      { $pull: { materials: { _id: req.params.materialId } } }
    );
    res.json({ success: true, message: 'Material deleted successfully!' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error deleting material.' });
  }
});
// Server ko start karna
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});