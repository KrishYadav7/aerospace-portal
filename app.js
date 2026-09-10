// ================================================================
// DATA LAYER (Local Storage for Professors & Payments temporarily)
// ================================================================

const STORAGE_KEY = 'aerospace_data';
const UPI_CONFIG = {
  upiId: 'example@upi',
  merchantName: 'Aerospace Dept',
  currency: 'INR'
};

function getDefaultData() {
  return {
    users: [], 
    courses: [], 
    professors: [
      { id: 'p1', name: 'Prof. S. K. Mehta', title: 'Aerodynamics & Fluid Mechanics', description: 'Ph.D. from MIT, author of 3 textbooks.', photo: '' },
      { id: 'p2', name: 'Prof. R. N. Sharma', title: 'Propulsion & Combustion', description: 'Former ISRO scientist.', photo: '' },
      { id: 'p3', name: 'Prof. P. K. Gupta', title: 'Avionics & Control Systems', description: 'Expert in UAV navigation.', photo: '' },
      { id: 'p4', name: 'Prof. M. S. Rao', title: 'Spacecraft Design & Orbital Mechanics', description: 'Over 30 years in satellite design.', photo: '' }
    ]
  };
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultData();
    const data = JSON.parse(raw);
    if (!data.professors || !Array.isArray(data.professors)) data.professors = getDefaultData().professors;
    return data;
  } catch {
    return getDefaultData();
  }
}

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function getProfessors() { return loadData().professors; }
function findProfessor(id) { return getProfessors().find(p => p.id === id) || null; }
function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ================================================================
// LIVE MONGODB DATA LAYER
// ================================================================

let liveCourses = [];
function getCourses() { return liveCourses; }
function findCourse(id) { return getCourses().find(c => c.id === id) || null; }

async function fetchCoursesFromDB() {
  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/courses');
    const data = await response.json();
    liveCourses = data.map(course => {
      const fixedMaterials = (course.materials || []).map(m => ({ ...m, id: m._id }));
      return { ...course, id: course._id, materials: fixedMaterials };
    });
    renderApp(); 
  } catch(error) {
    console.error('Error fetching courses:', error);
    renderApp();
  }
}

// ================================================================
// APP STATE
// ================================================================

let currentUser = null;
let currentCourseId = null;
let currentMaterialFilter = 'all';
let loginRole = 'student';
let studentNav = 'home';
let adminTab = 'courses';

// DOM refs
const $ = id => document.getElementById(id);
const loginView = $('loginView');
const adminView = $('adminView');
const studentHomeView = $('studentHomeView');
const studentCoursesView = $('studentCoursesView');
const courseDetailView = $('courseDetailView');
const appHeader = $('appHeader');
const appFooter = $('appFooter');
const mainNav = $('mainNav');
const userDisplay = $('userDisplay');
const roleBadge = $('roleBadge');
const adminCourseList = $('adminCourseList');
const studentCourseList = $('studentCourseList');
const courseDetailContent = $('courseDetailContent');
const adminProfessorList = $('adminProfessorList');
const adminStudentList = $('adminStudentList');
const professorsGrid = $('professorsGrid');

// ================================================================
// LOGIN & REGISTRATION (MongoDB Connected)
// ================================================================

function setLoginRole(role) {
  loginRole = role;
  document.querySelectorAll('.login-role-toggle button').forEach(b => {
    b.classList.toggle('active', b.dataset.role === role);
  });
}

async function handleLogin(e) {
  e.preventDefault();
  const username = $('loginUsername').value.trim();
  const password = $('loginPassword').value.trim();
  
  if (!username || !password) {
    showToast('Please enter both username and password.', 'error');
    return;
  }

  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await response.json();

    if (data.success) {
      if (loginRole === 'admin' && data.user.role !== 'admin') {
        showToast('This account is not an admin.', 'error');
        return;
      }
      if (loginRole === 'student' && data.user.role !== 'student') {
        showToast('This account is not a student.', 'error');
        return;
      }

      currentUser = data.user;
      localStorage.setItem('aero_token', data.token); 
      localStorage.setItem('aero_user', JSON.stringify(data.user));
      
      studentNav = 'home';
      adminTab = 'courses';
      showToast(data.message, 'success');
      renderApp();
    } else {
      showToast(data.message, 'error');
    }
  } catch (error) {
    showToast('Server is not running or network error.', 'error');
  }
}

function logout() {
  currentUser = null;
  currentCourseId = null;
  studentNav = 'home';
  localStorage.removeItem('aero_token');
  localStorage.removeItem('aero_user');
  renderApp();
  showToast('Logged out.', 'info');
}

function showRegisterModal() {
  $('regFullName').value = '';
  $('regUsername').value = '';
  $('regEmail').value = '';
  $('regPassword').value = '';
  openModal('registerModal');
}

// ================================================================
// REGISTRATION WITH OTP VERIFICATION
// ================================================================

let tempRegisterData = null; // Registration data yahan save rakhenge jab tak OTP na aa jaye

async function registerStudent(e) {
  e.preventDefault();
  
  const fullName = $('regFullName').value.trim();
  const username = $('regUsername').value.trim();
  const email = $('regEmail').value.trim();
  const password = $('regPassword').value.trim();

  if (!fullName || !username || !password || !email) {
    showToast('Please fill all fields including Email.', 'error');
    return;
  }

  showToast('Sending OTP to your email... Please wait.', 'info');

  try {
    // 1. Backend ko OTP bhejne ka order dena
    const response = await fetch('https://aerospace-portal.onrender.com/api/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username })
    });
    const data = await response.json();

    if (data.success) {
      // 2. Agar email chala gaya, toh data save karo aur box band karo
      tempRegisterData = { fullName, username, email, password };
      closeModal('registerModal');
      
      // 3. Student se OTP maango (Browser ka inbuilt popup)
      const enteredOtp = prompt(`An OTP has been sent to ${email}.\n\nPlease enter your 6-digit OTP below:`);
      
      if (enteredOtp) {
        verifyAndCompleteRegistration(enteredOtp);
      } else {
        showToast('Registration cancelled by user.', 'info');
      }
    } else {
      showToast(data.message, 'error');
    }
  } catch (error) {
    showToast('Server is not running or network error.', 'error');
  }
}

// 4. OTP aur form data ek sath Backend ko bhejna verify karne ke liye
async function verifyAndCompleteRegistration(otp) {
  try {
    const finalData = { ...tempRegisterData, otp: otp };
    
    const response = await fetch('https://aerospace-portal.onrender.com/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(finalData)
    });
    
    const data = await response.json();

    if (data.success) {
      showToast('🎉 ' + data.message, 'success');
      tempRegisterData = null; // Memory clean
    } else {
      showToast(data.message, 'error');
    }
  } catch (error) {
    showToast('Error verifying OTP.', 'error');
  }
}

// ================================================================
// NAVIGATION & RENDER ENGINE
// ================================================================

function navigateStudent(dest) {
  if (dest === 'home') studentNav = 'home';
  else if (dest === 'courses') studentNav = 'courses';
  if (currentCourseId) {
    currentCourseId = null;
    renderApp();
    setTimeout(() => { studentNav = dest; renderApp(); }, 50);
    return;
  }
  renderApp();
}

function renderApp() {
  loginView.classList.remove('active');
  adminView.classList.remove('active');
  studentHomeView.classList.remove('active');
  studentCoursesView.classList.remove('active');
  courseDetailView.classList.remove('active');
  appHeader.style.display = 'none';
  appFooter.style.display = 'none';

  if (!currentUser) {
    loginView.classList.add('active');
    return;
  }

  appHeader.style.display = 'flex';
  appFooter.style.display = 'block';
  userDisplay.textContent = currentUser.username;
  roleBadge.textContent = currentUser.role === 'admin' ? 'Admin' : 'Student';
  roleBadge.className = 'role-badge ' + currentUser.role;

  buildNav();

  if (currentCourseId) {
    courseDetailView.classList.add('active');
    renderCourseDetail(currentCourseId);
    return;
  }

  if (currentUser.role === 'admin') {
    adminView.classList.add('active');
    renderAdminDashboard();
    return;
  }

  if (studentNav === 'home') {
    studentHomeView.classList.add('active');
    renderStudentHome(); 
  } else {
    studentCoursesView.classList.add('active');
    renderStudentCourses();
  }
}

function buildNav() {
  if (currentUser.role === 'admin') {
    mainNav.innerHTML = `<a href="#" class="active" onclick="event.preventDefault();">Dashboard</a>`;
    return;
  }
  const homeActive = (studentNav === 'home' && !currentCourseId) ? 'active' : '';
  const coursesActive = (studentNav === 'courses' && !currentCourseId) ? 'active' : '';
  mainNav.innerHTML = `
    <a href="#" class="${homeActive}" onclick="event.preventDefault();navigateStudent('home')"><i class="fas fa-home"></i> Home</a>
    <a href="#" class="${coursesActive}" onclick="event.preventDefault();navigateStudent('courses')"><i class="fas fa-book"></i> Courses</a>
  `;
}

// ================================================================
// ADMIN DASHBOARD
// ================================================================

function switchAdminTab(tab) {
  adminTab = tab;
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.admin-tab[data-tab="${tab}"]`).classList.add('active');
  document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
  $(`adminTab${tab.charAt(0).toUpperCase() + tab.slice(1)}`).classList.add('active');
  renderAdminDashboard();
}

function renderAdminDashboard() {
  if (adminTab === 'courses') renderAdminCourses();
  else if (adminTab === 'professors') renderAdminProfessors();
  else if (adminTab === 'students') renderAdminStudents();
}

function renderAdminCourses() {
  const courses = getCourses();
  const searchTerm = ($('adminCourseSearch').value || '').toLowerCase().trim();
  const filtered = courses.filter(c => c.name.toLowerCase().includes(searchTerm) || (c.code && c.code.toLowerCase().includes(searchTerm)));

  const totalMaterials = courses.reduce((sum, c) => sum + (c.materials ? c.materials.length : 0), 0);
  $('statCourses').textContent = courses.length;
  $('statMaterials').textContent = totalMaterials;
  $('statStudents').textContent = 0; 

  if (filtered.length === 0) {
    adminCourseList.innerHTML = `<div class="empty-state"><i class="fas fa-search"></i><p>No courses found.</p></div>`;
    return;
  }

  let html = `<div class="course-grid">`;
  filtered.forEach(c => {
    const matCount = c.materials ? c.materials.length : 0;
    const premiumLabel = c.isPremium ? `<span class="premium-badge"><i class="fas fa-crown"></i> Premium</span>` : '';
    html += `
      <div class="course-card">
        <button class="delete-course-btn" onclick="deleteCourse('${c.id}')" title="Delete course"><i class="fas fa-trash-alt"></i></button>
        <div class="course-code">${c.code || 'N/A'} ${premiumLabel}</div>
        <h3>${c.name}</h3>
        <div class="course-meta">
          <span><i class="fas fa-user"></i> ${c.instructor || '—'}</span>
          <span><i class="fas fa-calendar-alt"></i> ${c.semester || '—'}</span>
          ${c.isPremium ? `<span><i class="fas fa-rupee-sign"></i> ${c.price || 0}</span>` : ''}
        </div>
        <div class="material-count"><i class="fas fa-file-alt"></i> ${matCount} materials</div>
        <div class="card-actions">
          <button class="btn btn-warning btn-sm" style="background-color: #f59e0b; color: white;" onclick="editCourse('${c.id}', '${c.name}', '${c.description || ''}', '${c.price || 0}')"><i class="fas fa-edit"></i> Edit</button>
          <button class="btn btn-primary btn-sm" onclick="viewCourseDetail('${c.id}')"><i class="fas fa-eye"></i> View</button>
          <button class="btn btn-success btn-sm" onclick="openAddMaterialModal('${c.id}')"><i class="fas fa-plus"></i> Add Material</button>
        </div>
      </div>
    `;
  });
  html += `</div>`;
  adminCourseList.innerHTML = html;
}

function renderAdminProfessors() {
  const professors = getProfessors();
  if (professors.length === 0) {
    adminProfessorList.innerHTML = `<div class="empty-state"><i class="fas fa-chalkboard-teacher"></i><p>No professors added yet.</p></div>`;
    return;
  }
  let html = '';
  professors.forEach(p => {
    const photoHtml = p.photo ? `<img src="${p.photo}" alt="${p.name}">` : `<div style="width:60px;height:60px;border-radius:50%;background:#dce1e8;display:flex;align-items:center;justify-content:center;font-size:24px;color:#6b7a8f;"><i class="fas fa-user"></i></div>`;
    html += `
      <div class="admin-professor-item">
        ${photoHtml}
        <div class="info"><h4>${p.name}</h4><div class="title">${p.title}</div><div style="font-size:13px;color:#6b7a8f;margin-top:2px;">${p.description || ''}</div></div>
        <div class="actions">
          <button class="btn btn-danger btn-sm" onclick="deleteProfessor('${p.id}')"><i class="fas fa-trash"></i></button>
        </div>
      </div>
    `;
  });
  adminProfessorList.innerHTML = html;
}

// ================================================================
// ADMIN STUDENTS LIST (MongoDB Connected)
// ================================================================

// ================================================================
// ADMIN COURSES WALA DASHBOARD (Fixed Student Count)
// ================================================================
async function renderAdminCourses() {
  const courses = getCourses();
  const searchTerm = ($('adminCourseSearch').value || '').toLowerCase().trim();
  const filtered = courses.filter(c => c.name.toLowerCase().includes(searchTerm) || (c.code && c.code.toLowerCase().includes(searchTerm)));

  const totalMaterials = courses.reduce((sum, c) => sum + (c.materials ? c.materials.length : 0), 0);
  $('statCourses').textContent = courses.length;
  $('statMaterials').textContent = totalMaterials;
  $('statStudents').textContent = '...'; 

  try {
    const res = await fetch('https://aerospace-portal.onrender.com/api/students');
    const data = await res.json();
    if (data.success) $('statStudents').textContent = data.students.length;
  } catch (e) { $('statStudents').textContent = 'Error'; }

  if (filtered.length === 0) {
    adminCourseList.innerHTML = `<div class="empty-state"><i class="fas fa-search"></i><p>No courses found.</p></div>`;
    return;
  }

  let html = `<div class="course-grid">`;
  filtered.forEach(c => {
    const matCount = c.materials ? c.materials.length : 0;
    const premiumLabel = c.isPremium ? `<span class="premium-badge"><i class="fas fa-crown"></i> Premium</span>` : '';
    html += `
      <div class="course-card">
        <button class="delete-course-btn" onclick="deleteCourse('${c.id}')" title="Delete course"><i class="fas fa-trash-alt"></i></button>
        <div class="course-code">${c.code || 'N/A'} ${premiumLabel}</div>
        <h3>${c.name}</h3>
        <div class="course-meta">
          <span><i class="fas fa-user"></i> ${c.instructor || '—'}</span>
          <span><i class="fas fa-calendar-alt"></i> ${c.semester || '—'}</span>
          ${c.isPremium ? `<span><i class="fas fa-rupee-sign"></i> ${c.price || 0}</span>` : ''}
        </div>
        <div class="material-count"><i class="fas fa-file-alt"></i> ${matCount} materials</div>
        <div class="card-actions">
          <!-- YE RAHA NAYA SAFE EDIT BUTTON -->
          <button class="btn btn-warning btn-sm" style="background-color: #f59e0b; color: white;" onclick="editCourse('${c.id}')"><i class="fas fa-edit"></i> Edit</button>
          <button class="btn btn-primary btn-sm" onclick="viewCourseDetail('${c.id}')"><i class="fas fa-eye"></i> View</button>
          <button class="btn btn-success btn-sm" onclick="openAddMaterialModal('${c.id}')"><i class="fas fa-plus"></i> Add Material</button>
        </div>
      </div>
    `;
  });
  html += `</div>`;
  adminCourseList.innerHTML = html;
}

// ================================================================
// ADMIN STUDENTS LIST WALA TAB (Fixed Live Database)
// ================================================================
async function renderAdminStudents() {
  const container = $('adminStudentList');
  if(!container) return; // Safety check
  
  container.innerHTML = `<div class="empty-state"><p>Loading students from database...</p></div>`;
  
  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/students');
    const data = await response.json();
    
    if (data.success) {
      const students = data.students;

      if (students.length === 0) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-users"></i><p>No students registered yet.</p></div>`;
        return;
      }

      let html = '';
      students.forEach(s => {
        html += `
          <div class="student-list-item" style="background: #fff; padding: 15px; margin-bottom: 10px; border-radius: 8px; border: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center;">
            <div class="student-info">
              <h4 style="margin: 0 0 5px 0; color: #1e293b;">${s.fullName || s.username}</h4>
              <div style="font-size: 13px; color: #64748b;">
                <strong>Username:</strong> @${s.username} <br>
                ${s.email ? `<strong>Email:</strong> ${s.email}` : '<span style="color:#ef4444">No email provided</span>'}
              </div>
            </div>
            <div class="student-purchases" style="background: #f1f5f9; padding: 8px 12px; border-radius: 20px; font-size: 13px; color: #3b82f6; font-weight: bold;">
              <i class="fas fa-check-circle"></i> Registered
            </div>
          </div>
        `;
      });
      container.innerHTML = html;
    }
  } catch (error) {
    container.innerHTML = `<div class="empty-state"><p style="color:red;">Error fetching student list. Is server running?</p></div>`;
    console.error('Error:', error);
  }
}

// ================================================================
// STUDENT VIEWS
// ================================================================

function renderStudentHome() {
  const professors = getProfessors();
  if (professors.length === 0) {
    professorsGrid.innerHTML = `<p style="color:#94a3b8;">No professors added yet.</p>`;
  } else {
    let html = '';
    professors.forEach(p => {
      const photoHtml = p.photo ? `<img src="${p.photo}" alt="${p.name}" class="professor-avatar">` : `<div class="professor-avatar" style="background:#dce1e8;display:flex;align-items:center;justify-content:center;font-size:40px;color:#6b7a8f;width:100px;height:100px;border-radius:50%;margin:0 auto 10px;"><i class="fas fa-user"></i></div>`;
      html += `<div class="professor-card">${photoHtml}<h3>${p.name}</h3><div class="prof-title">${p.title}</div><p>${p.description || ''}</p></div>`;
    });
    professorsGrid.innerHTML = html;
  }
}

function renderStudentCourses() {
  const courses = getCourses();
  const searchTerm = ($('studentCourseSearch').value || '').toLowerCase().trim();
  const filtered = courses.filter(c => c.name.toLowerCase().includes(searchTerm) || (c.code && c.code.toLowerCase().includes(searchTerm)));

  if (filtered.length === 0) {
    studentCourseList.innerHTML = `<div class="empty-state"><i class="fas fa-book-open"></i><p>No courses available.</p></div>`;
    return;
  }

  let html = `<div class="course-grid">`;
  filtered.forEach(c => {
    const isPurchased = currentUser.purchases && currentUser.purchases.includes(c.id);
    let badge = '';
    if (c.isPremium) {
      badge = `<span class="premium-badge"><i class="fas fa-crown"></i> Premium</span>`;
      if (!isPurchased) badge += ` <span class="premium-badge" style="background:#94a3b8;color:#fff;"><i class="fas fa-lock"></i> Locked</span>`;
    }
    html += `
      <div class="course-card" onclick="viewCourseDetail('${c.id}')">
        <div class="course-code">${c.code || 'N/A'} ${badge}</div>
        <h3>${c.name}</h3>
        <div class="course-meta">
          <span><i class="fas fa-user"></i> ${c.instructor || '—'}</span>
          <span><i class="fas fa-calendar-alt"></i> ${c.semester || '—'}</span>
          ${c.isPremium ? `<span><i class="fas fa-rupee-sign"></i> ${c.price || 0}</span>` : ''}
        </div>
        <p style="margin-top:8px;font-size:13px;color:#6b7a8f;">${c.description || ''}</p>
        ${c.isPremium && !isPurchased ? `<div style="margin-top:10px;"><button class="btn btn-primary btn-sm" onclick="event.stopPropagation();showPaymentModal('${c.id}')"><i class="fas fa-shopping-cart"></i> Buy Now</button></div>` : ''}
      </div>
    `;
  });
  html += `</div>`;
  studentCourseList.innerHTML = html;
}

function viewCourseDetail(courseId) { currentCourseId = courseId; renderApp(); }
function goBackFromDetail() { currentCourseId = null; renderApp(); }
function setMaterialFilter(type) { currentMaterialFilter = type; if (currentCourseId) renderCourseDetail(currentCourseId); }

function renderCourseDetail(courseId) {
  const course = findCourse(courseId);
  if (!course) { courseDetailContent.innerHTML = `<div class="empty-state"><p>Course not found.</p></div>`; return; }

  const isPremium = course.isPremium || false;
  const isPurchased = currentUser && currentUser.purchases && currentUser.purchases.includes(course.id);
  
  let html = `
    <div class="course-detail-header">
      <h2>${course.name} ${isPremium ? '<span class="premium-badge"><i class="fas fa-crown"></i> Premium</span>' : ''}</h2>
      <div class="meta">
        <span><i class="fas fa-code"></i> ${course.code || 'N/A'}</span>
        <span><i class="fas fa-user"></i> ${course.instructor || '—'}</span>
        ${isPremium ? `<span><i class="fas fa-rupee-sign"></i> ${course.price || 0}</span>` : ''}
      </div>
      <p style="margin-top:6px;color:#475569;">${course.description || ''}</p>
    </div>
  `;

  if (isPremium && currentUser.role === 'student' && !isPurchased) {
    html += `
      <div class="payment-overlay">
        <i class="fas fa-lock"></i><h3>This course is premium</h3><p>Please purchase it to access all materials.</p>
        <button class="btn btn-primary" onclick="showPaymentModal('${course.id}')"><i class="fas fa-shopping-cart"></i> Buy Now – ₹${course.price || 0}</button>
      </div>`;
    courseDetailContent.innerHTML = html;
    return;
  }

  const materials = course.materials || [];
  const filtered = currentMaterialFilter === 'all' ? materials : materials.filter(m => m.type === currentMaterialFilter);
  // Purani line dhoondhiye aur usko is se replace kijiye:
  const types = ['all', 'video', 'pyq', 'tutorial', 'slides', 'qa', 'other'];
  const typeLabels = { all: 'All', video: '🎬 Video', pyq: '📄 PYQ', tutorial: '📝 Tutorial', slides: '📊 Slides', qa: '❓ Q&A', other: '📁 Other' };
  
  html += `<div class="material-tabs">`;
  types.forEach(t => {
    const count = t === 'all' ? materials.length : materials.filter(m => m.type === t).length;
    html += `<button class="${currentMaterialFilter === t ? 'active' : ''}" onclick="setMaterialFilter('${t}')">${typeLabels[t]} (${count})</button>`;
  });
  html += `</div>`;
// =========================================================
  // Q&A SECTION LOGIC
  // =========================================================
  if (currentMaterialFilter === 'qa') {
    const doubts = course.doubts || [];
    html += `<div class="qa-section" style="padding: 15px; background: #f8fafc; border-radius: 8px;">
               <div style="margin-bottom: 20px;">
                 <textarea id="newDoubtText" placeholder="Eg: Sir, specific impulse ka formula samajh nahi aaya..." style="width:100%; padding:10px; border-radius:5px; border:1px solid #cbd5e1;"></textarea>
                 <button class="btn btn-primary btn-sm" style="margin-top:10px;" onclick="askDoubt('${course.id}')"><i class="fas fa-paper-plane"></i> Ask Doubt</button>
               </div>`;
               
    if (doubts.length === 0) {
      html += `<p style="color:#64748b;">No doubts asked yet. Be the first to ask!</p>`;
    } else {
      doubts.forEach(d => {
        html += `<div style="background:#fff; padding:15px; margin-bottom:10px; border-left: 4px solid #3b82f6; border-radius:5px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                   <strong><i class="fas fa-user-graduate"></i> ${d.studentName}</strong> 
                   <p style="margin:8px 0; color:#333;">Q: ${d.question}</p>
                   
                   ${d.answer 
                     ? `<div style="background:#f1f5f9; padding:10px; border-radius:5px; color:#0f172a;"><i class="fas fa-chalkboard-teacher"></i> <strong>Admin:</strong> ${d.answer}</div>` 
                     : currentUser.role === 'admin' 
                        ? `<button class="btn btn-success btn-sm" onclick="replyDoubt('${course.id}', '${d._id || d.id}')"><i class="fas fa-reply"></i> Reply</button>`
                        : `<span style="font-size:12px; color:#f59e0b;"><i class="fas fa-clock"></i> Waiting for reply...</span>`
                   }
                 </div>`;
      });
    }
    html += `</div>`;
    courseDetailContent.innerHTML = html;
    return; // Q&A dikhane ke baad material list render na ho isliye yahan se wapas bhej dein
  }
  if (filtered.length === 0) {
    html += `<div class="empty-state"><i class="fas fa-file-alt"></i><p>No materials found.</p></div>`;
  } else {
    html += `<div class="material-list">`;
    filtered.forEach(m => {
      // Fix: Code ko sahi jagah HTML string ke andar dala gaya hai
      const hasFile = m.fileData && m.fileData.length > 0;
      const hasUrl = m.url && m.url.length > 0;
      
      let fileActionHtml = '';
      if (hasFile) {
        if (currentUser.role === 'admin') {
          fileActionHtml = `<a href="${m.fileData}" download="${m.fileName || 'download'}" class="btn btn-primary btn-sm"><i class="fas fa-download"></i> Download</a>
                            <button class="btn btn-outline btn-sm" onclick="viewFileOnline('${course.id}', '${m.id}')"><i class="fas fa-eye"></i> View</button>`;
        } else {
          fileActionHtml = `<button class="btn btn-primary btn-sm" onclick="viewFileOnline('${course.id}', '${m.id}')"><i class="fas fa-eye"></i> View Online</button>`;
        }
      }

      html += `
        <div class="material-item">
          ${currentUser.role === 'admin' ? `
            <button class="delete-mat-btn" style="right: 45px; color: #f59e0b; background: none; border: none; font-size: 18px;" onclick="editMaterial('${course.id}', '${m.id}')" title="Edit"><i class="fas fa-edit"></i></button>
            <button class="delete-mat-btn" onclick="deleteMaterial('${course.id}','${m.id}')" title="Delete"><i class="fas fa-times-circle"></i></button>
          ` : ''}
          <div class="mat-type ${m.type}">${m.type.toUpperCase()}</div>
          <h4>${m.title}</h4>
          <div class="mat-desc">${m.description || ''}</div>
          <div class="mat-actions">
            ${fileActionHtml}
            ${hasUrl ? `<a href="${m.url}" target="_blank" class="btn btn-primary btn-sm"><i class="fas fa-external-link-alt"></i> Open Link</a>` : ''}
          </div>
        </div>
      `;
    });
    html += `</div>`;
  }
  courseDetailContent.innerHTML = html;
}

// ================================================================
// SECURE FILE VIEWER (Naya Function Jo File Dikhayega)
// ================================================================

async function viewFileOnline(courseId, materialId) {
  const course = findCourse(courseId);
  if (!course) return;
  const mat = course.materials.find(m => m.id === materialId);
  
  if (mat && mat.fileData) {
    try {
      const response = await fetch(mat.fileData);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, '_blank');
    } catch (error) {
      showToast('Error opening file online.', 'error');
      console.error(error);
    }
  } else {
    showToast('No file attached to this material.', 'info');
  }
}

// ================================================================
// COURSE CRUD (MongoDB Connected)
// ================================================================

function openAddCourseModal() {
  $('courseModalTitle').textContent = '📚 New Course';
  $('editCourseId').value = ''; $('courseName').value = ''; $('courseCode').value = '';
  $('courseSemester').value = ''; $('courseInstructor').value = ''; $('courseDescription').value = '';
  $('courseIsPremium').checked = false; $('coursePrice').value = ''; $('priceGroup').style.display = 'none';
  openModal('courseModal');
}

function togglePriceInput() { $('priceGroup').style.display = $('courseIsPremium').checked ? 'block' : 'none'; }

async function saveCourse(e) {
  e.preventDefault();
  const id = $('editCourseId').value;
  const courseData = {
    name: $('courseName').value.trim(), code: $('courseCode').value.trim(),
    semester: $('courseSemester').value.trim(), instructor: $('courseInstructor').value.trim(),
    description: $('courseDescription').value.trim(), isPremium: $('courseIsPremium').checked,
    price: parseFloat($('coursePrice').value) || 0
  };

  if (!courseData.name || !courseData.code) return showToast('Name and code required.', 'error');

  try {
    if (id) {
      showToast('Edit feature coming soon!', 'info');
      closeModal('courseModal');
    } else {
      const response = await fetch('https://aerospace-portal.onrender.com/api/courses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(courseData)
      });
      const data = await response.json();
      if (data.success) {
        showToast('🎉 Course created safely in Database!', 'success');
        closeModal('courseModal');
        fetchCoursesFromDB();
      }
    }
  } catch (error) { showToast('Server error.', 'error'); }
}

async function deleteCourse(courseId) {
  if (!confirm('Are you sure you want to delete this course and all its materials?')) return;
  try {
    const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}`, { method: 'DELETE' });
    const data = await response.json();
    if (data.success) {
      if (currentCourseId === courseId) currentCourseId = null;
      showToast('🗑️ Course safely deleted from Database.', 'info');
      fetchCoursesFromDB();
    } else {
      showToast(data.message, 'error');
    }
  } catch (error) { showToast('Server error.', 'error'); }
}

// ================================================================
// MATERIAL CRUD (MongoDB Connected)
// ================================================================

function openAddMaterialModal(courseId) {
  $('materialModalTitle').textContent = '📎 Add Material';
  $('editMaterialId').value = ''; $('materialCourseId').value = courseId;
  $('materialTitle').value = ''; $('materialType').value = 'video';
  $('materialDescription').value = ''; $('materialUrl').value = ''; $('materialFile').value = '';
  openModal('materialModal');
}

async function saveMaterial(e) {
  e.preventDefault();
  const courseId = $('materialCourseId').value;
  const materialId = $('editMaterialId').value;
  const file = $('materialFile').files ? $('materialFile').files[0] : null;

  const processSave = async (fileData, fileName) => {
    const materialData = {
      title: $('materialTitle').value.trim(), type: $('materialType').value,
      description: $('materialDescription').value.trim(), url: $('materialUrl').value.trim(),
      fileData, fileName
    };

    if (materialId) {
      showToast('Edit feature coming soon!', 'info'); closeModal('materialModal');
    } else {
      try {
        const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/materials`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(materialData)
        });
        const data = await response.json();
        if (data.success) {
          showToast('📎 Material safely added to database!', 'success');
          closeModal('materialModal');
          fetchCoursesFromDB();
        }
      } catch (error) { showToast('Server error.', 'error'); }
    }
  };

  if (file) {
    const reader = new FileReader();
    reader.onload = ev => processSave(ev.target.result, file.name);
    reader.readAsDataURL(file);
  } else { processSave('', ''); }
}

async function deleteMaterial(courseId, materialId) {
  if (!confirm('Are you sure you want to delete this material?')) return;
  try {
    const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/materials/${materialId}`, { method: 'DELETE' });
    const data = await response.json();
    if (data.success) { showToast('Material deleted.', 'info'); fetchCoursesFromDB(); }
  } catch (error) { showToast('Server error.', 'error'); }
}

// ================================================================
// PROFESSOR CRUD (Local Storage Temp)
// ================================================================

function openAddProfessorModal() {
  $('editProfessorId').value = ''; $('professorName').value = '';
  $('professorTitle').value = ''; $('professorDescription').value = ''; $('professorPhoto').value = '';
  openModal('professorModal');
}

function saveProfessor(e) {
  e.preventDefault();
  const data = loadData();
  const name = $('professorName').value.trim();
  const processSave = (photoData) => {
    data.professors.push({
      id: generateId(), name, title: $('professorTitle').value.trim(),
      description: $('professorDescription').value.trim(), photo: photoData || ''
    });
    saveData(data); showToast('Professor added!', 'success');
    closeModal('professorModal'); renderApp();
  };
  const photoFile = $('professorPhoto').files ? $('professorPhoto').files[0] : null;
  if (photoFile) {
    const reader = new FileReader(); reader.onload = ev => processSave(ev.target.result); reader.readAsDataURL(photoFile);
  } else { processSave(null); }
}

function deleteProfessor(professorId) {
  if (!confirm('Delete this professor?')) return;
  const data = loadData();
  data.professors = data.professors.filter(p => p.id !== professorId);
  saveData(data); showToast('Professor deleted.', 'info'); renderApp();
}

// ================================================================
// PAYMENT (Dummy Verification - Prep for Razorpay)
// ================================================================

// ================================================================
// ASLI RAZORPAY PAYMENT INTEGRATION
// ================================================================

async function showPaymentModal(courseId) {
  const course = findCourse(courseId);
  if (!course) return;

  showToast('Initiating secure payment...', 'info');

  try {
    // 1. Backend se Order create karwana
    const response = await fetch('https://aerospace-portal.onrender.com/api/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: course.price })
    });
    const data = await response.json();

    if (!data.success) {
      showToast('Error creating order. Is server running?', 'error');
      return;
    }

    // 2. Razorpay Popup ki Settings
    const options = {
      "key": rzp_test_TaPfJOdu1PgUed, // ⚠️ Apna Test Key ID yahan paste karein
      "amount": data.order.amount,
      "currency": "INR",
      "name": "Aerospace EdTech",
      "description": `Purchase: ${course.name}`,
      "order_id": data.order.id,
      "handler": async function (response) {
        // 3. Payment hone ke baad Backend se Verify karna
        showToast('Verifying payment...', 'info');
        
        const verifyRes = await fetch('https://aerospace-portal.onrender.com/api/verify-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
            courseId: courseId,
            userId: currentUser._id // <--- Humne ye nayi line jodi hai
          })
        });
        
        const verifyData = await verifyRes.json();
        
        if (verifyData.success) {
          // Payment Success! Course ko user ki list mein add karna
          if (!currentUser.purchases) currentUser.purchases = [];
          if (!currentUser.purchases.includes(courseId)) currentUser.purchases.push(courseId);
          localStorage.setItem('aero_user', JSON.stringify(currentUser));
          
          showToast('🎉 Payment Successful! Course Unlocked.', 'success');
          renderApp(); // Screen refresh karke lock hata dega
        } else {
          showToast('Payment verification failed!', 'error');
        }
      },
      "prefill": {
        "name": currentUser.username,
        "email": currentUser.email || "student@aerospace.com",
        "contact": "9999999999" // Test mode mein koi bhi number chalta hai
      },
      "theme": {
        "color": "#2563eb" // Aapke portal ka blue color
      }
    };

    // 4. Razorpay Popup Open Karna
    const rzp1 = new Razorpay(options);
    rzp1.open();

  } catch (error) {
    showToast('Server error during payment initialization.', 'error');
  }
}

function confirmPayment() {
  const courseId = $('paymentModal').dataset.courseId;
  $('paymentQrContainer').style.display = 'none'; $('paymentActions').style.display = 'none'; $('paymentVerification').style.display = 'block';
  
  setTimeout(() => {
    // Note: Temporary dummy logic before Razorpay integration
    if (!currentUser.purchases) currentUser.purchases = [];
    if (!currentUser.purchases.includes(courseId)) currentUser.purchases.push(courseId);
    localStorage.setItem('aero_user', JSON.stringify(currentUser));
    showToast('🎉 Dummy Payment verified! Course unlocked.', 'success');
    closeModal('paymentModal'); renderApp();
  }, 2000); 
}

// ================================================================
// MODAL HELPERS & TOAST
// ================================================================

function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', function(e) { if (e.target === this) this.classList.remove('active'); });
});

function showToast(message, type = 'info') {
  const container = $('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<i class="fas fa-info-circle"></i> ${message}`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(30px)'; setTimeout(() => toast.remove(), 350); }, 3500);
}

// ================================================================
// INIT (App Start & Database Load)
// ================================================================

async function initApp() {
  const savedUser = localStorage.getItem('aero_user');
  if (savedUser) {
    currentUser = JSON.parse(savedUser);
    if(currentUser.role === 'admin') adminTab = 'courses';
  }
  renderApp(); 
  await fetchCoursesFromDB();
}

initApp();
// =========================================================
// EDIT COURSE & MATERIAL FUNCTIONS (ADMIN)
// =========================================================

// =========================================================
// SAFE EDIT FUNCTIONS
// =========================================================

async function editCourse(courseId) {
  const course = findCourse(courseId);
  if (!course) return;

  const newTitle = prompt("Update Course Name:", course.name);
  if (newTitle === null) return;
  const newDesc = prompt("Update Course Description:", course.description || '');
  if (newDesc === null) return;
  const newPrice = prompt("Update Course Price (₹):", course.price || 0);
  if (newPrice === null) return;

  try {
    const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newTitle, description: newDesc, price: newPrice })
    });
    const data = await response.json();
    if (data.success) {
      showToast('✏️ ' + data.message, 'success');
      fetchCoursesFromDB();
    } else showToast(data.message, 'error');
  } catch (error) { showToast('Error connecting to server.', 'error'); }
}

async function editMaterial(courseId, materialId) {
  const course = findCourse(courseId);
  if (!course) return;
  const mat = course.materials.find(m => m.id === materialId);
  if (!mat) return;

  const newTitle = prompt("Update Material Title:", mat.title);
  if (newTitle === null) return;
  const newDesc = prompt("Update Material Description:", mat.description || '');
  if (newDesc === null) return;

  try {
    const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/materials/${materialId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle, description: newDesc })
    });
    const data = await response.json();
    if (data.success) {
      showToast('✏️ ' + data.message, 'success');
      fetchCoursesFromDB();
    } else showToast(data.message, 'error');
  } catch (error) { showToast('Error connecting to server.', 'error'); }
}