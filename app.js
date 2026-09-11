const STORAGE_KEY = 'aerospace_data';
function getDefaultData() {
  return { professors: [
      { id: 'p1', name: 'Prof. S. K. Mehta', title: 'Aerodynamics', description: 'Ph.D. from MIT', photo: '' },
      { id: 'p2', name: 'Prof. R. N. Sharma', title: 'Propulsion', description: 'Former ISRO scientist.', photo: '' }
    ]
  };
}

function loadData() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || getDefaultData(); } 
  catch { return getDefaultData(); }
}

function saveData(data) { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
function getProfessors() { return loadData().professors; }
function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

let liveCourses = [];
function getCourses() { return liveCourses; }
function findCourse(id) { return getCourses().find(c => c.id === id) || null; }

async function fetchCoursesFromDB() {
  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/courses?t=' + new Date().getTime());
    const data = await response.json();
    liveCourses = data.map(course => {
      const fixedMaterials = (course.materials || []).map(m => ({ ...m, id: m._id }));
      return { ...course, id: course._id, materials: fixedMaterials };
    });
    renderApp(); 
  } catch(error) { console.error('Error fetching courses:', error); renderApp(); }
}

let currentUser = null;
let currentCourseId = null;
let currentMaterialFilter = 'all';
let loginRole = 'student';
let studentNav = 'home';
let adminTab = 'courses';

const $ = id => document.getElementById(id);
/* ============================================================
   COURSE ACCENT SYSTEM
   Each course code hashes to one of 8 curated gradient palettes.
   CSS vars --accent-1, --accent-2, --accent-solid, --accent-soft,
   --accent-glow are set inline on the card so all descendant
   styling adapts automatically.
   ============================================================ */
const COURSE_ACCENTS = [
  { from: '#6366f1', to: '#8b5cf6', solid: '#6366f1', soft: 'rgba(99,102,241,0.12)', glow: 'rgba(99,102,241,0.28)' },   // indigo → violet
  { from: '#06b6d4', to: '#3b82f6', solid: '#0891b2', soft: 'rgba(6,182,212,0.12)',  glow: 'rgba(6,182,212,0.28)' },    // cyan → blue
  { from: '#10b981', to: '#14b8a6', solid: '#059669', soft: 'rgba(16,185,129,0.12)', glow: 'rgba(16,185,129,0.28)' },   // emerald → teal
  { from: '#f59e0b', to: '#f97316', solid: '#d97706', soft: 'rgba(245,158,11,0.14)', glow: 'rgba(245,158,11,0.30)' },   // amber → orange
  { from: '#ec4899', to: '#f43f5e', solid: '#db2777', soft: 'rgba(236,72,153,0.12)', glow: 'rgba(236,72,153,0.28)' },   // pink → rose
  { from: '#8b5cf6', to: '#d946ef', solid: '#7c3aed', soft: 'rgba(139,92,246,0.14)', glow: 'rgba(139,92,246,0.28)' },   // violet → fuchsia
  { from: '#0ea5e9', to: '#6366f1', solid: '#0284c7', soft: 'rgba(14,165,233,0.12)', glow: 'rgba(14,165,233,0.28)' },   // sky → indigo
  { from: '#22c55e', to: '#84cc16', solid: '#16a34a', soft: 'rgba(34,197,94,0.12)',  glow: 'rgba(34,197,94,0.28)' },    // green → lime
];

function hashString(str) {
  const s = String(str || 'COURSE');
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash |= 0; // force 32-bit
  }
  return Math.abs(hash);
}

function getCourseAccent(codeOrName) {
  return COURSE_ACCENTS[hashString(codeOrName) % COURSE_ACCENTS.length];
}

/** Returns an inline-style string with the accent CSS vars. */
function accentStyle(codeOrName) {
  const a = getCourseAccent(codeOrName);
  return `--accent-1:${a.from};--accent-2:${a.to};--accent-solid:${a.solid};--accent-soft:${a.soft};--accent-glow:${a.glow};`;
}

/* ============================================================
   THEME + MOBILE NAV
   ============================================================ */
(function initTheme() {
  const saved = localStorage.getItem('aero_theme');
  const prefers = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefers ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
})();

function updateThemeIcon() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  btn.innerHTML = isDark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
}

document.addEventListener('click', (e) => {
  // Theme toggle
  if (e.target.closest('#themeToggle')) {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('aero_theme', next);
    updateThemeIcon();
    return;
  }
  // Mobile nav toggle
  if (e.target.closest('#navToggle')) {
    document.getElementById('mainNav')?.classList.toggle('open');
    return;
  }
  // Auto-close mobile nav on link click
  if (e.target.closest('.main-nav a')) {
    document.getElementById('mainNav')?.classList.remove('open');
  }
});

document.addEventListener('DOMContentLoaded', updateThemeIcon);
// Mobile nav toggle
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#navToggle');
  if (toggle) {
    document.getElementById('mainNav')?.classList.toggle('open');
    return;
  }
  // Close nav when a nav link is clicked
  if (e.target.closest('.main-nav a')) {
    document.getElementById('mainNav')?.classList.remove('open');
  }
});

function setLoginRole(role) {
  loginRole = role;
  document.querySelectorAll('.login-role-toggle button').forEach(b => b.classList.toggle('active', b.dataset.role === role));
}

async function handleLogin(e) {
  e.preventDefault();
  const username = $('loginUsername').value.trim();
  const password = $('loginPassword').value.trim();
  if (!username || !password) return showToast('Please enter both username and password.', 'error');
  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const data = await response.json();
    if (data.success) {
      if (loginRole === 'admin' && data.user.role !== 'admin') return showToast('Not an admin account.', 'error');
      if (loginRole === 'student' && data.user.role !== 'student') return showToast('Not a student account.', 'error');
      currentUser = data.user;
      localStorage.setItem('aero_token', data.token); 
      localStorage.setItem('aero_user', JSON.stringify(data.user));
      studentNav = 'home'; adminTab = 'courses';
      showToast(data.message, 'success');
      renderApp();
    } else { showToast(data.message, 'error'); }
  } catch (error) { showToast('Server network error.', 'error'); }
}

function logout() {
  currentUser = null; currentCourseId = null; studentNav = 'home';
  localStorage.removeItem('aero_token'); localStorage.removeItem('aero_user');
  renderApp(); showToast('Logged out.', 'info');
}

function showRegisterModal() {
  $('regFullName').value = ''; $('regUsername').value = ''; $('regEmail').value = ''; $('regPassword').value = '';
  openModal('registerModal');
}

let tempRegisterData = null;

async function registerStudent(e) {
  e.preventDefault();
  const fullName = $('regFullName').value.trim(), username = $('regUsername').value.trim(), email = $('regEmail').value.trim(), password = $('regPassword').value.trim();
  if (!fullName || !username || !password || !email) return showToast('Fill all fields.', 'error');
  showToast('Sending OTP to your email... Please wait.', 'info');
  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/send-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, username }) });
    const data = await response.json();
    if (data.success) {
      tempRegisterData = { fullName, username, email, password };
      closeModal('registerModal');
      const enteredOtp = prompt(`An OTP has been sent to ${email}.\n\nPlease enter your 6-digit OTP below:`);
      if (enteredOtp) verifyAndCompleteRegistration(enteredOtp);
    } else { showToast(data.message, 'error'); }
  } catch (error) { showToast('Server network error.', 'error'); }
}

async function verifyAndCompleteRegistration(otp) {
  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...tempRegisterData, otp: otp }) });
    const data = await response.json();
    if (data.success) { showToast('🎉 ' + data.message, 'success'); tempRegisterData = null; } 
    else { showToast(data.message, 'error'); }
  } catch (error) { showToast('Error verifying OTP.', 'error'); }
}

function navigateStudent(dest) {
  currentCourseId = null;
  window.currentSelectedCourseId = null;
  studentNav = dest;
  renderApp();
}

function renderApp() {
  $('loginView').classList.remove('active'); $('adminView').classList.remove('active');
  $('studentHomeView').classList.remove('active'); $('studentCoursesView').classList.remove('active');
  $('courseDetailView').classList.remove('active');
  $('appHeader').style.display = 'none'; $('appFooter').style.display = 'none';

  if (!currentUser) { $('loginView').classList.add('active'); return; }

  $('appHeader').style.display = 'flex'; $('appFooter').style.display = 'block';
  $('userDisplay').textContent = currentUser.username;
  $('roleBadge').textContent = currentUser.role === 'admin' ? 'Admin' : 'Student';
  $('roleBadge').className = 'role-badge ' + currentUser.role;
  buildNav();

  if (currentCourseId) { $('courseDetailView').classList.add('active'); renderCourseDetail(currentCourseId); return; }
  if (currentUser.role === 'admin') { $('adminView').classList.add('active'); renderAdminDashboard(); return; }
  if (studentNav === 'home') { $('studentHomeView').classList.add('active'); renderStudentHome(); } 
  else { $('studentCoursesView').classList.add('active'); renderStudentCourses(); }
}

function buildNav() {
  if (currentUser.role === 'admin') { $('mainNav').innerHTML = `<a href="#" class="active" onclick="event.preventDefault();">Dashboard</a>`; return; }
  const homeActive = (studentNav === 'home' && !currentCourseId) ? 'active' : '';
  const coursesActive = (studentNav === 'courses' && !currentCourseId) ? 'active' : '';
  $('mainNav').innerHTML = `<a href="#" class="${homeActive}" onclick="event.preventDefault();navigateStudent('home')"><i class="fas fa-home"></i> Home</a><a href="#" class="${coursesActive}" onclick="event.preventDefault();navigateStudent('courses')"><i class="fas fa-book"></i> Courses</a>`;
}

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

async function renderAdminCourses() {
  const courses = getCourses();
  const searchTerm = ($('adminCourseSearch').value || '').toLowerCase().trim();
  const filtered = courses.filter(c => c.name.toLowerCase().includes(searchTerm) || (c.code && c.code.toLowerCase().includes(searchTerm)));

  $('statCourses').textContent = courses.length;
  $('statMaterials').textContent = courses.reduce((sum, c) => sum + (c.materials ? c.materials.length : 0), 0);
  $('statStudents').textContent = '...'; 

  try {
    const res = await fetch('https://aerospace-portal.onrender.com/api/students');
    const data = await res.json();
    if (data.success) $('statStudents').textContent = data.students.length;
  } catch (e) { $('statStudents').textContent = 'Error'; }

  if (filtered.length === 0) {
    $('adminCourseList').innerHTML = `<div class="empty-state"><i class="fas fa-search"></i><p>No courses found.</p></div>`; return;
  }

  let html = `<div class="course-grid">`;
  filtered.forEach(c => {
    const matCount = c.materials ? c.materials.length : 0;
    const premiumLabel = c.isPremium ? `<span class="premium-badge"><i class="fas fa-crown"></i> Premium</span>` : '';
    
    // NAYA: Admin Alert popup for Pending Doubts
    const pendingDoubts = (c.doubts || []).filter(d => !d.answer).length;
    const alertHtml = pendingDoubts > 0 ? `
      <div style="background:#fef2f2; border:1px solid #fecaca; color:#b91c1c; padding:8px 12px; border-radius:8px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:13px; font-weight:600;"><i class="fas fa-bell"></i> ${pendingDoubts} Pending Doubt(s)</span>
        <button onclick="event.stopPropagation(); currentMaterialFilter='qa'; viewCourseDetail('${c.id}');" style="background:#ef4444; color:#fff; border:none; padding:4px 10px; border-radius:6px; font-size:12px; cursor:pointer; font-weight:bold;">Reply Now <i class="fas fa-arrow-right"></i></button>
      </div>` : '';

    html += `
        <div class="course-card" style="${accentStyle(c.code || c.name)}">
        <button class="delete-course-btn" onclick="deleteCourse('${c.id}')" title="Delete course"><i class="fas fa-trash-alt"></i></button>
        <div class="course-code">${c.code || 'N/A'} ${premiumLabel}</div>
        <h3>${c.name}</h3>
        ${alertHtml}
        <div class="course-meta">
          <span><i class="fas fa-user"></i> ${c.instructor || '—'}</span>
          <span><i class="fas fa-calendar-alt"></i> ${c.semester || '—'}</span>
          ${c.isPremium ? `<span><i class="fas fa-rupee-sign"></i> ${c.price || 0}</span>` : ''}
        </div>
        <div class="material-count"><i class="fas fa-file-alt"></i> ${matCount} materials</div>
        <div class="card-actions">
          <button class="btn btn-warning btn-sm" style="background-color: #f59e0b; color: white;" onclick="editCourse('${c.id}')"><i class="fas fa-edit"></i> Edit</button>
          <button class="btn btn-primary btn-sm" onclick="viewCourseDetail('${c.id}')"><i class="fas fa-eye"></i> View</button>
          <button class="btn btn-success btn-sm" onclick="openAddMaterialModal('${c.id}')"><i class="fas fa-plus"></i> Add Material</button>
        </div>
      </div>
    `;
  });
  html += `</div>`;
  $('adminCourseList').innerHTML = html;
}

function renderAdminProfessors() {
  const professors = getProfessors();
  if (professors.length === 0) { $('adminProfessorList').innerHTML = `<div class="empty-state"><i class="fas fa-chalkboard-teacher"></i><p>No professors added yet.</p></div>`; return; }
  let html = '';
  professors.forEach(p => {
    const photoHtml = p.photo ? `<img src="${p.photo}" alt="${p.name}">` : `<div style="width:60px;height:60px;border-radius:50%;background:#dce1e8;display:flex;align-items:center;justify-content:center;font-size:24px;color:#6b7a8f;"><i class="fas fa-user"></i></div>`;
    html += `<div class="admin-professor-item">${photoHtml}<div class="info"><h4>${p.name}</h4><div class="title">${p.title}</div><div style="font-size:13px;color:#6b7a8f;margin-top:2px;">${p.description || ''}</div></div><div class="actions"><button class="btn btn-danger btn-sm" onclick="deleteProfessor('${p.id}')"><i class="fas fa-trash"></i></button></div></div>`;
  });
  $('adminProfessorList').innerHTML = html;
}

async function renderAdminStudents() {
  const container = $('adminStudentList');
  if(!container) return; 
  container.innerHTML = `<div class="empty-state"><p>Loading students from database...</p></div>`;
  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/students');
    const data = await response.json();
    if (data.success) {
      if (data.students.length === 0) { container.innerHTML = `<div class="empty-state"><i class="fas fa-users"></i><p>No students registered yet.</p></div>`; return; }
      let html = '';
      data.students.forEach(s => {
        html += `<div class="student-list-item" style="background: #fff; padding: 15px; margin-bottom: 10px; border-radius: 8px; border: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center;"><div class="student-info"><h4 style="margin: 0 0 5px 0; color: #1e293b;">${s.fullName || s.username}</h4><div style="font-size: 13px; color: #64748b;"><strong>Username:</strong> @${s.username} <br>${s.email ? `<strong>Email:</strong> ${s.email}` : '<span style="color:#ef4444">No email provided</span>'}</div></div><div class="student-purchases" style="background: #f1f5f9; padding: 8px 12px; border-radius: 20px; font-size: 13px; color: #3b82f6; font-weight: bold;"><i class="fas fa-check-circle"></i> Registered</div></div>`;
      });
      container.innerHTML = html;
    }
  } catch (error) { container.innerHTML = `<div class="empty-state"><p style="color:red;">Error fetching student list.</p></div>`; }
}

function renderStudentHome() {
  const professors = getProfessors();
  if (professors.length === 0) { $('professorsGrid').innerHTML = `<p style="color:#94a3b8;">No professors added yet.</p>`; } 
  else {
    let html = '';
    professors.forEach(p => {
      const photoHtml = p.photo ? `<img src="${p.photo}" alt="${p.name}" class="professor-avatar">` : `<div class="professor-avatar" style="background:#dce1e8;display:flex;align-items:center;justify-content:center;font-size:40px;color:#6b7a8f;width:100px;height:100px;border-radius:50%;margin:0 auto 10px;"><i class="fas fa-user"></i></div>`;
      html += `<div class="professor-card">${photoHtml}<h3>${p.name}</h3><div class="prof-title">${p.title}</div><p>${p.description || ''}</p></div>`;
    });
    $('professorsGrid').innerHTML = html;
  }
}

function renderStudentCourses() {
  const courses = getCourses();
  const searchTerm = ($('studentCourseSearch').value || '').toLowerCase().trim();
  const filtered = courses.filter(c => c.name.toLowerCase().includes(searchTerm) || (c.code && c.code.toLowerCase().includes(searchTerm)));

  if (filtered.length === 0) { $('studentCourseList').innerHTML = `<div class="empty-state"><i class="fas fa-book-open"></i><p>No courses available.</p></div>`; return; }

  let html = `<div class="course-grid">`;
  filtered.forEach(c => {
    const isPurchased = currentUser.purchases && currentUser.purchases.includes(c.id);
    let badge = c.isPremium ? `<span class="premium-badge"><i class="fas fa-crown"></i> Premium</span>` + (!isPurchased ? ` <span class="premium-badge" style="background:#94a3b8;color:#fff;"><i class="fas fa-lock"></i> Locked</span>` : '') : '';
    html += `
  <div class="course-card" style="${accentStyle(c.code || c.name)}" onclick="viewCourseDetail('${c.id}')">
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
  $('studentCourseList').innerHTML = html;
}

function viewCourseDetail(courseId) { currentCourseId = courseId; window.currentSelectedCourseId = courseId; renderApp(); }
function goBackFromDetail() { currentCourseId = null; renderApp(); }

function setMaterialFilter(type) {
  currentMaterialFilter = type;
  if (window.currentSelectedCourseId) renderCourseDetail(window.currentSelectedCourseId);
}

function renderCourseDetail(courseId) {
  const course = findCourse(courseId);
  if (!course) { $('courseDetailContent').innerHTML = `<div class="empty-state"><p>Course not found.</p></div>`; return; }

  const isPremiumCourse = course.isPremium || false;
  const isPurchased = currentUser && currentUser.purchases && currentUser.purchases.includes(course.id);
  
let html = `
  <div class="course-detail-header" style="${accentStyle(course.code || course.name)}">
    <h2>${course.name} ${isPremiumCourse ? '<span class="premium-badge"><i class="fas fa-crown"></i> Premium Course</span>' : ''}</h2>
      <div class="meta">
        <span><i class="fas fa-code"></i> ${course.code || 'N/A'}</span>
        <span><i class="fas fa-user"></i> ${course.instructor || '—'}</span>
        ${isPremiumCourse ? `<span><i class="fas fa-rupee-sign"></i> ${course.price || 0}</span>` : ''}
      </div>
      <p style="margin-top:6px;color:#475569;">${course.description || ''}</p>
    </div>
  `;

  if (isPremiumCourse && currentUser.role === 'student' && !isPurchased) {
    html += `<div style="background: #fff3cd; color: #856404; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #ffeeba; display: flex; justify-content: space-between; align-items: center;">
        <div><i class="fas fa-info-circle"></i> Premium materials are locked.</div>
        <button class="btn btn-warning btn-sm" style="background:#f59e0b; color:#fff;" onclick="showPaymentModal('${course.id}')"><i class="fas fa-shopping-cart"></i> Buy Full Course (₹${course.price})</button>
      </div>`;
  }

  const materials = course.materials || [];
  const filtered = currentMaterialFilter === 'all' ? materials : materials.filter(m => m.type === currentMaterialFilter);
  const types = ['all', 'video', 'pyq', 'tutorial', 'slides', 'qa', 'other'];
  const typeLabels = { all: 'All', video: '🎬 Video', pyq: '📄 PYQ', tutorial: '📝 Tutorial', slides: '📊 Slides', qa: '❓ Q&A', other: '📁 Other' };
  
  html += `<div class="material-tabs">`;
  types.forEach(t => {
    let count = 0;
    if (t === 'all') count = materials.length;
    else if (t === 'qa') count = course.doubts ? course.doubts.length : 0;
    else count = materials.filter(m => m.type === t).length;
    html += `<button class="${currentMaterialFilter === t ? 'active' : ''}" onclick="setMaterialFilter('${t}')">${typeLabels[t]} (${count})</button>`;
  });
  html += `</div>`;

  // === ADVANCED Q&A UI ===
  if (currentMaterialFilter === 'qa') {
    const doubts = course.doubts || [];
    html += `<div class="qa-section" style="padding: 20px; background: #fff; border-radius: 12px; border: 1px solid #e9edf2;">
               <h3 style="margin-bottom: 15px; color: #0b1a33;"><i class="fas fa-comments"></i> Course Q&A / Doubts</h3>`;

    if (currentUser.role === 'student') {
      html += `<div style="margin-bottom: 25px; background: #f8fafc; padding: 15px; border-radius: 8px; border: 1px solid #e2e8f0;">
                 <label style="font-weight:600; color:#1e293b; display:block; margin-bottom:8px;">Ask a New Doubt</label>
                 <textarea id="newDoubtText" placeholder="Type your doubt here (e.g. Sir, derivation samajh nahi aaya...)" style="width:100%; padding:12px; border: 1px solid #cbd5e1; border-radius:8px; min-height:80px; font-family:inherit; margin-bottom:10px;"></textarea>
                 <button class="btn btn-primary" onclick="askDoubt('${course.id}')"><i class="fas fa-paper-plane"></i> Submit Doubt</button>
               </div>`;
    }
        
    if (doubts.length === 0) {
      html += `<div class="empty-state" style="padding: 20px;"><i class="fas fa-check-circle"></i><p>No doubts asked yet.</p></div>`;
    } else {
      const sortedDoubts = doubts.sort((a, b) => {
         if (!a.answer && b.answer) return -1;
         if (a.answer && !b.answer) return 1;
         return 0;
      });

      sortedDoubts.forEach(d => {
        const isAnswered = !!d.answer;
        const statusBadge = isAnswered 
          ? `<span style="background:#10b981; color:#fff; font-size:10px; padding:3px 8px; border-radius:12px; font-weight:bold;">SOLVED</span>` 
          : `<span style="background:#f59e0b; color:#fff; font-size:10px; padding:3px 8px; border-radius:12px; font-weight:bold;">PENDING</span>`;
        
        const dateText = d.date ? new Date(d.date).toLocaleDateString() : 'Recent';
        const emailText = d.studentEmail ? d.studentEmail : 'No Email';
        const usernameText = d.studentUsername ? `@${d.studentUsername}` : '';

        html += `
          <div style="background:#fff; padding:16px; margin-bottom:14px; border-left: 4px solid ${isAnswered ? '#10b981' : '#f59e0b'}; border-radius:8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); border: 1px solid #f1f5f9;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px; flex-wrap:wrap; gap:10px;">
              <div>
                <strong style="color:#0b1a33; font-size:15px;"><i class="fas fa-user-circle"></i> ${d.studentName} <span style="color:#64748b; font-size:13px; font-weight:normal;">${usernameText}</span></strong>
                ${currentUser.role === 'admin' ? `<div style="font-size:12px; color:#64748b; margin-top:2px;"><i class="fas fa-envelope"></i> ${emailText}</div>` : ''}
              </div>
              <div>${statusBadge} <span style="font-size:11px; color:#94a3b8; margin-left:8px;">${dateText}</span></div>
            </div>
            <p style="margin:8px 0; color:#334155; font-size:14px; background:#f8fafc; padding:10px; border-radius:6px;"><strong>Q:</strong> ${d.question}</p>
            ${isAnswered 
              ? `<div style="background:#eff6ff; padding:12px; border-radius:6px; color:#1e3a8a; margin-top:10px; font-size:14px; border-left: 3px solid #3b82f6;"><i class="fas fa-chalkboard-teacher"></i> <strong>Admin Reply:</strong> ${d.answer}</div>` 
              : (currentUser.role === 'admin' ? `<button class="btn btn-success btn-sm" style="margin-top:10px;" onclick="replyDoubt('${course.id}', '${d._id || d.id}')"><i class="fas fa-reply"></i> Give Reply</button>` : `<div style="font-size:13px; color:#d97706; margin-top:10px; font-weight:500;"><i class="fas fa-clock"></i> Waiting for admin's reply...</div>`)
            }
          </div>`;
      });
    }
    html += `</div>`;
    $('courseDetailContent').innerHTML = html;
    return;
  }

  if (filtered.length === 0) {
    html += `<div class="empty-state"><i class="fas fa-file-alt"></i><p>No content uploaded in this category.</p></div>`;
  } else {
    html += `<div class="material-list">`;
    filtered.forEach(m => {
      const hasFile = m.fileData && m.fileData.length > 0;
      const hasUrl = m.url && m.url.length > 0;
      const isMatPremium = m.isPremium === true || m.isPremium === 'true';
      const matPrice = parseFloat(m.price) || 0;
      const isMatPurchased = currentUser && currentUser.purchases && currentUser.purchases.includes(m.id);
      const canAccess = (currentUser.role === 'admin') || isPurchased || isMatPurchased || !isMatPremium;
      
      let fileActionHtml = '';
      if (!canAccess) {
        fileActionHtml = `<button class="btn btn-warning btn-sm" style="background:#b91c1c; color:#fff; border:none;" onclick="showPaymentModal('${course.id}', '${m.id}')"><i class="fas fa-lock"></i> Unlock for ₹${matPrice}</button>`;
      } else {
        if (hasFile) fileActionHtml += currentUser.role === 'admin' ? `<a href="${m.fileData}" download="${m.fileName || 'download'}" class="btn btn-primary btn-sm"><i class="fas fa-download"></i> Download</a> <button class="btn btn-outline btn-sm" onclick="viewFileOnline('${course.id}', '${m.id}')"><i class="fas fa-eye"></i> View</button>` : `<button class="btn btn-primary btn-sm" onclick="viewFileOnline('${course.id}', '${m.id}')"><i class="fas fa-eye"></i> View Content</button>`;
        if (hasUrl) fileActionHtml += ` <a href="${m.url}" target="_blank" class="btn btn-primary btn-sm"><i class="fas fa-external-link-alt"></i> Open Link</a>`;
      }

      const badgeHtml = isMatPremium ? `<span style="font-size:10px; background:#f0b429; color:#0b1a33; padding:3px 8px; border-radius:12px; font-weight:bold;"><i class="fas fa-crown"></i> PRO (₹${matPrice})</span>` : `<span style="font-size:10px; background:#10b981; color:white; padding:3px 8px; border-radius:12px; font-weight:bold;">FREE</span>`;

      html += `
        <div class="material-item ${!canAccess ? 'locked-mat' : ''}">
          ${currentUser.role === 'admin' ? `<button class="delete-mat-btn" style="right: 45px; color: #f59e0b; background: none; border: none; font-size: 18px;" onclick="editMaterial('${course.id}', '${m.id}')" title="Edit"><i class="fas fa-edit"></i></button><button class="delete-mat-btn" onclick="deleteMaterial('${course.id}','${m.id}')" title="Delete"><i class="fas fa-times-circle"></i></button>` : ''}
          <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;"><div class="mat-type ${m.type}">${m.type.toUpperCase()}</div>${badgeHtml}</div>
          <h4>${m.title}</h4>
          <div class="mat-desc">${m.description || ''}</div>
          <div class="mat-actions" style="margin-top:10px;">${fileActionHtml}</div>
        </div>
      `;
    });
    html += `</div>`;
  }
  $('courseDetailContent').innerHTML = html;
}

async function viewFileOnline(courseId, materialId) {
  const course = findCourse(courseId); if (!course) return;
  const mat = course.materials.find(m => m.id === materialId);
  if (mat && mat.fileData) {
    try {
      const response = await fetch(mat.fileData); const blob = await response.blob();
      window.open(URL.createObjectURL(blob), '_blank');
    } catch (error) { showToast('Error opening file online.', 'error'); }
  } else { showToast('No file attached.', 'info'); }
}

function openAddCourseModal() {
  $('courseModalTitle').textContent = '📚 New Course';
  $('editCourseId').value = ''; $('courseName').value = ''; $('courseCode').value = ''; $('courseSemester').value = ''; $('courseInstructor').value = ''; $('courseDescription').value = '';
  const pc = $('courseIsPremium'); if(pc) pc.checked = false; 
  const pi = $('coursePrice'); if(pi) pi.value = ''; 
  const pg = $('priceGroup'); if(pg) pg.style.display = 'none';
  openModal('courseModal');
}

function togglePriceInput() { const pg = $('priceGroup'); const pc = $('courseIsPremium'); if(pg && pc) pg.style.display = pc.checked ? 'block' : 'none'; }

async function saveCourse(e) {
  e.preventDefault();
  const id = $('editCourseId').value;
  const courseData = { name: $('courseName').value.trim(), code: $('courseCode').value.trim(), semester: $('courseSemester').value.trim(), instructor: $('courseInstructor').value.trim(), description: $('courseDescription').value.trim(), isPremium: $('courseIsPremium').checked, price: parseFloat($('coursePrice').value) || 0 };
  if (!courseData.name || !courseData.code) return showToast('Name and code required.', 'error');
  try {
    if (id) { showToast('Edit feature coming soon!', 'info'); closeModal('courseModal'); } 
    else {
      const response = await fetch('https://aerospace-portal.onrender.com/api/courses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(courseData) });
      const data = await response.json();
      if (data.success) { showToast('🎉 Course created!', 'success'); closeModal('courseModal'); fetchCoursesFromDB(); }
    }
  } catch (error) { showToast('Server error.', 'error'); }
}

async function deleteCourse(courseId) {
  if (!confirm('Are you sure you want to delete this course and all its materials?')) return;
  try {
    const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}`, { method: 'DELETE' });
    const data = await response.json();
    if (data.success) { if (currentCourseId === courseId) currentCourseId = null; showToast('🗑️ Course deleted.', 'info'); fetchCoursesFromDB(); }
  } catch (error) { showToast('Server error.', 'error'); }
}

async function editCourse(courseId) {
  const course = findCourse(courseId); if (!course) return;
  const newTitle = prompt("Update Course Name:", course.name); if (newTitle === null) return;
  const newDesc = prompt("Update Course Description:", course.description || ''); if (newDesc === null) return;
  let newPrice = prompt("Update Course Price (₹):", course.price || 0); if (newPrice === null) return;
  newPrice = parseFloat(newPrice) || 0; const isPremium = newPrice > 0; 
  try {
    const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newTitle, description: newDesc, price: newPrice, isPremium: isPremium }) });
    const data = await response.json();
    if (data.success) { showToast('✏️ ' + data.message, 'success'); course.name = newTitle; course.description = newDesc; course.price = newPrice; course.isPremium = isPremium; renderApp(); } 
    else { showToast(data.message, 'error'); }
  } catch (error) { showToast('Error connecting to server.', 'error'); }
}

window.toggleMaterialPriceInput = function() {
  const isPremium = $('materialIsPremium').checked; const priceGrp = $('materialPriceGroup');
  if(priceGrp) priceGrp.style.display = isPremium ? 'block' : 'none';
};

function openAddMaterialModal(courseId) {
  $('materialModalTitle').textContent = '📎 Add Material'; $('editMaterialId').value = ''; $('materialCourseId').value = courseId;
  $('materialTitle').value = ''; $('materialType').value = 'video'; $('materialDescription').value = ''; $('materialUrl').value = ''; $('materialFile').value = '';
  if($('materialIsPremium')) $('materialIsPremium').checked = false;
  if($('materialPrice')) $('materialPrice').value = '';
  toggleMaterialPriceInput(); openModal('materialModal');
}

async function saveMaterial(e) {
  e.preventDefault();
  const courseId = $('materialCourseId').value; const materialId = $('editMaterialId').value;
  const file = $('materialFile').files ? $('materialFile').files[0] : null;

  const processSave = async (fileData, fileName) => {
    const isPremiumMat = $('materialIsPremium') ? $('materialIsPremium').checked : false;
    const matPrice = $('materialPrice') ? (parseFloat($('materialPrice').value) || 0) : 0;
    const materialData = { title: $('materialTitle').value.trim(), type: $('materialType').value, description: $('materialDescription').value.trim(), url: $('materialUrl').value.trim(), isPremium: isPremiumMat, price: matPrice, fileData, fileName };

    if (materialId) { showToast('Edit feature coming soon!', 'info'); closeModal('materialModal'); } 
    else {
      try {
        const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/materials`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(materialData) });
        const data = await response.json();
        if (data.success) { showToast('📎 Content successfully uploaded!', 'success'); closeModal('materialModal'); fetchCoursesFromDB(); }
      } catch (error) { showToast('Server error.', 'error'); }
    }
  };
  if (file) { const reader = new FileReader(); reader.onload = ev => processSave(ev.target.result, file.name); reader.readAsDataURL(file); } 
  else { processSave('', ''); }
}

async function editMaterial(courseId, materialId) {
  const course = findCourse(courseId); if (!course) return;
  const mat = course.materials.find(m => m.id === materialId); if (!mat) return;
  const newTitle = prompt("Update Material Title:", mat.title); if (newTitle === null) return;
  const newDesc = prompt("Update Material Description:", mat.description || ''); if (newDesc === null) return;
  let newPrice = prompt("Update Material Unlock Price (₹) - [Type 0 to make it FREE]:", mat.price || 0); if (newPrice === null) return;
  newPrice = parseFloat(newPrice) || 0; const isPremium = newPrice > 0;
  try {
    const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/materials/${materialId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: newTitle, description: newDesc, isPremium: isPremium, price: newPrice }) });
    const data = await response.json();
    if (data.success) { showToast('✏️ Material updated with amount!', 'success'); fetchCoursesFromDB(); }
  } catch (error) { showToast('Error connecting to server.', 'error'); }
}

async function deleteMaterial(courseId, materialId) {
  if (!confirm('Are you sure you want to delete this material?')) return;
  try {
    const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/materials/${materialId}`, { method: 'DELETE' });
    const data = await response.json();
    if (data.success) { showToast('Material deleted.', 'info'); fetchCoursesFromDB(); }
  } catch (error) { showToast('Server error.', 'error'); }
}

function openAddProfessorModal() {
  $('editProfessorId').value = ''; $('professorName').value = ''; $('professorTitle').value = ''; $('professorDescription').value = ''; $('professorPhoto').value = ''; openModal('professorModal');
}
function saveProfessor(e) {
  e.preventDefault(); const data = loadData(); const name = $('professorName').value.trim();
  const processSave = (photoData) => { data.professors.push({ id: generateId(), name, title: $('professorTitle').value.trim(), description: $('professorDescription').value.trim(), photo: photoData || '' }); saveData(data); showToast('Professor added!', 'success'); closeModal('professorModal'); renderApp(); };
  const photoFile = $('professorPhoto').files ? $('professorPhoto').files[0] : null;
  if (photoFile) { const reader = new FileReader(); reader.onload = ev => processSave(ev.target.result); reader.readAsDataURL(photoFile); } else { processSave(null); }
}
function deleteProfessor(professorId) {
  if (!confirm('Delete this professor?')) return;
  const data = loadData(); data.professors = data.professors.filter(p => p.id !== professorId); saveData(data); showToast('Professor deleted.', 'info'); renderApp();
}

async function askDoubt(courseId) {
  const textarea = $('newDoubtText'); if (!textarea) return;
  const question = textarea.value.trim();
  if (!question) return showToast('Please type your doubt or question first.', 'error');
  try {
    const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/doubts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentName: currentUser.fullName || currentUser.username, studentUsername: currentUser.username, studentEmail: currentUser.email || '', question: question })
    });
    const data = await response.json();
    if (data.success) { showToast('❓ Doubt submitted successfully!', 'success'); textarea.value = ''; fetchCoursesFromDB(); } 
    else { showToast(data.message || 'Error submitting doubt', 'error'); }
  } catch (error) { showToast('Server error while submitting doubt.', 'error'); }
}

async function replyDoubt(courseId, doubtId) {
  const answer = prompt("Enter your reply/solution for this student:");
  if (answer === null || answer.trim() === '') return;
  try {
    const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/doubts/${doubtId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: answer.trim() }) });
    const data = await response.json();
    if (data.success) { showToast('💡 Answer posted successfully!', 'success'); fetchCoursesFromDB(); } 
    else { showToast(data.message || 'Error posting answer', 'error'); }
  } catch (error) { showToast('Server error while posting answer.', 'error'); }
}

async function showPaymentModal(courseId, materialId = null) {
  const course = findCourse(courseId); if (!course) return;
  let amount = course.price || 0; let itemName = course.name; let purchaseId = course.id; 
  if (materialId) {
    const mat = course.materials.find(m => m.id === materialId);
    if (mat) { amount = mat.price || 0; itemName = mat.title; purchaseId = mat.id; }
  }
  showToast(`Initiating secure payment for ${itemName}...`, 'info');
  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/create-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: amount }) });
    const data = await response.json();
    if (!data.success) return showToast('Error creating order.', 'error');
    const options = {
      "key": "rzp_test_TaPfJOdu1PgUed", "amount": data.order.amount, "currency": "INR", "name": "Aerospace EdTech", "description": `Purchase: ${itemName}`, "order_id": data.order.id,
      "handler": async function (response) {
        showToast('Verifying payment...', 'info');
        const verifyRes = await fetch('https://aerospace-portal.onrender.com/api/verify-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ razorpay_order_id: response.razorpay_order_id, razorpay_payment_id: response.razorpay_payment_id, razorpay_signature: response.razorpay_signature, courseId: purchaseId, userId: currentUser._id }) });
        const verifyData = await verifyRes.json();
        if (verifyData.success) {
          if (!currentUser.purchases) currentUser.purchases = [];
          if (!currentUser.purchases.includes(purchaseId)) currentUser.purchases.push(purchaseId);
          localStorage.setItem('aero_user', JSON.stringify(currentUser));
          showToast('🎉 Payment Successful! Content Unlocked.', 'success'); renderApp(); 
        } else { showToast('Payment verification failed!', 'error'); }
      },
      "prefill": { "name": currentUser.username, "email": currentUser.email || "student@aerospace.com", "contact": "9999999999" }, "theme": { "color": "#2563eb" }
    };
    new Razorpay(options).open();
  } catch (error) { showToast('Server error during payment initialization.', 'error'); }
}

function exportData() { showToast('Export feature is coming soon!', 'info'); }
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }
document.querySelectorAll('.modal-overlay').forEach(overlay => { overlay.addEventListener('click', function(e) { if (e.target === this) this.classList.remove('active'); }); });

function showToast(message, type = 'info') {
  const container = $('toastContainer'); const toast = document.createElement('div');
  toast.className = `toast ${type}`; toast.innerHTML = `<i class="fas fa-info-circle"></i> ${message}`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(30px)'; setTimeout(() => toast.remove(), 350); }, 3500);
}

async function initApp() {
  const savedUser = localStorage.getItem('aero_user');
  if (savedUser) { currentUser = JSON.parse(savedUser); if(currentUser.role === 'admin') adminTab = 'courses'; }
  renderApp(); await fetchCoursesFromDB();
}
initApp();