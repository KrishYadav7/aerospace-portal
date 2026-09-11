/* ============================================================
   STORAGE — Professors (still localStorage)
   ============================================================ */
const STORAGE_KEY = 'aerospace_data';

function getDefaultData() {
  return {
    professors: [
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

/* ============================================================
   COURSES — live from DB
   ============================================================ */
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
  } catch (error) {
    console.error('Error fetching courses:', error);
    renderApp();
  }
}

/* ============================================================
   APP STATE
   ============================================================ */
let currentUser = null;
let currentCourseId = null;
let currentMaterialFilter = 'all';
let loginRole = 'student';
let studentNav = 'home';
let adminTab = 'courses';

const $ = id => document.getElementById(id);

/* ============================================================
   HELPERS
   ============================================================ */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function syncHashToState() {
  const hash = location.hash || '#/home';
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);

  if (parts[0] === 'course' && parts[1]) {
    currentCourseId = parts[1];
    window.currentSelectedCourseId = parts[1];
    return;
  }

  currentCourseId = null;
  window.currentSelectedCourseId = null;

  if (parts[0] === 'admin') {
    adminTab = parts[1] || 'courses';
  } else if (parts[0] === 'courses') {
    studentNav = 'courses';
  } else if (parts[0] === 'saved') {
    studentNav = 'saved';
  } else {
    studentNav = 'home';
  }
}

function pushHash(path) {
  if (location.hash !== path) {
    history.pushState(null, '', path);
  }
}

const COURSE_ACCENTS = [
  { from: '#6366f1', to: '#8b5cf6', solid: '#6366f1', soft: 'rgba(99,102,241,0.12)', glow: 'rgba(99,102,241,0.28)' },
  { from: '#06b6d4', to: '#3b82f6', solid: '#0891b2', soft: 'rgba(6,182,212,0.12)',  glow: 'rgba(6,182,212,0.28)' },
  { from: '#10b981', to: '#14b8a6', solid: '#059669', soft: 'rgba(16,185,129,0.12)', glow: 'rgba(16,185,129,0.28)' },
  { from: '#f59e0b', to: '#f97316', solid: '#d97706', soft: 'rgba(245,158,11,0.14)', glow: 'rgba(245,158,11,0.30)' },
  { from: '#ec4899', to: '#f43f5e', solid: '#db2777', soft: 'rgba(236,72,153,0.12)', glow: 'rgba(236,72,153,0.28)' },
  { from: '#8b5cf6', to: '#d946ef', solid: '#7c3aed', soft: 'rgba(139,92,246,0.14)', glow: 'rgba(139,92,246,0.28)' },
  { from: '#0ea5e9', to: '#6366f1', solid: '#0284c7', soft: 'rgba(14,165,233,0.12)', glow: 'rgba(14,165,233,0.28)' },
  { from: '#22c55e', to: '#84cc16', solid: '#16a34a', soft: 'rgba(34,197,94,0.12)',  glow: 'rgba(34,197,94,0.28)' }
];

function hashString(str) {
  const s = String(str || 'COURSE');
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getCourseAccent(codeOrName) {
  return COURSE_ACCENTS[hashString(codeOrName) % COURSE_ACCENTS.length];
}

function accentStyle(codeOrName) {
  const a = getCourseAccent(codeOrName);
  return `--accent-1:${a.from};--accent-2:${a.to};--accent-solid:${a.solid};--accent-soft:${a.soft};--accent-glow:${a.glow};`;
}

/* ============================================================
   BOOKMARK / PROGRESS / STREAK HELPERS
   ============================================================ */
function isBookmarked(courseId) {
  return !!(currentUser?.bookmarks?.includes(courseId));
}

function getProgress(courseId) {
  if (!currentUser?.progress) return [];
  const p = currentUser.progress[courseId];
  return Array.isArray(p) ? p : [];
}

function isMaterialViewed(courseId, materialId) {
  return getProgress(courseId).includes(materialId);
}

function timeAgo(date) {
  if (!date) return 'recently';
  const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
  return Math.floor(s / 86400) + ' days ago';
}

/* ============================================================
   THEME
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

/* ============================================================
   GLOBAL CLICK HANDLERS
   ============================================================ */
document.addEventListener('click', (e) => {
  if (e.target.closest('#themeToggle')) {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('aero_theme', next);
    updateThemeIcon();
    return;
  }
  if (e.target.closest('#navToggle')) {
    document.getElementById('mainNav')?.classList.toggle('open');
    return;
  }
  if (e.target.closest('.main-nav a')) {
    document.getElementById('mainNav')?.classList.remove('open');
  }

  // Notification bell
  const notifWrap = document.getElementById('notifWrap');
  if (notifWrap) {
    if (e.target.closest('#notifBtn')) {
      notifWrap.classList.toggle('open');
      if (notifWrap.classList.contains('open')) {
        renderNotificationList();
        loadNotifications();
      }
      return;
    }
    if (!e.target.closest('#notifWrap')) {
      notifWrap.classList.remove('open');
    }
  }
});

document.addEventListener('DOMContentLoaded', updateThemeIcon);

// Mark all notifications read
document.addEventListener('click', (e) => {
  if (e.target.closest('#notifMarkAll')) {
    e.stopPropagation();
    markAllNotificationsRead();
  }
});

/* ============================================================
   LOGIN / LOGOUT / REGISTER
   ============================================================ */
function setLoginRole(role) {
  loginRole = role;
  document.querySelectorAll('.login-role-toggle button').forEach(b =>
    b.classList.toggle('active', b.dataset.role === role)
  );
}

async function handleLogin(e) {
  e.preventDefault();
  const username = $('loginUsername').value.trim();
  const password = $('loginPassword').value.trim();
  if (!username || !password) return showToast('Please enter both username and password.', 'error');

  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await response.json();

    if (data.success) {
      if (loginRole === 'admin' && data.user.role !== 'admin') return showToast('Not an admin account.', 'error');
      if (loginRole === 'student' && data.user.role !== 'student') return showToast('Not a student account.', 'error');

      currentUser = data.user;
      localStorage.setItem('aero_token', data.token);
      localStorage.setItem('aero_user', JSON.stringify(data.user));

      studentNav = 'home';
      adminTab = 'courses';
      pushHash('#/home');
      showToast(data.message, 'success');
      renderApp();
    } else {
      showToast(data.message, 'error');
    }
  } catch (error) {
    showToast('Server network error.', 'error');
  }
}

function logout() {
  currentUser = null;
  currentCourseId = null;
  window.currentSelectedCourseId = null;
  currentMaterialFilter = 'all';
  studentNav = 'home';
  adminTab = 'courses';
  localStorage.removeItem('aero_token');
  localStorage.removeItem('aero_user');
  pushHash('#/home');
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

let tempRegisterData = null;

async function registerStudent(e) {
  e.preventDefault();
  const fullName = $('regFullName').value.trim();
  const username = $('regUsername').value.trim();
  const email = $('regEmail').value.trim();
  const password = $('regPassword').value.trim();

  if (!fullName || !username || !password || !email) return showToast('Fill all fields.', 'error');

  showToast('Sending OTP to your email... Please wait.', 'info');
  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username })
    });
    const data = await response.json();

    if (data.success) {
      tempRegisterData = { fullName, username, email, password };
      closeModal('registerModal');
      const enteredOtp = prompt(`An OTP has been sent to ${email}.\n\nPlease enter your 6-digit OTP below:`);
      if (enteredOtp) verifyAndCompleteRegistration(enteredOtp);
    } else {
      showToast(data.message, 'error');
    }
  } catch (error) {
    showToast('Server network error.', 'error');
  }
}

async function verifyAndCompleteRegistration(otp) {
  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...tempRegisterData, otp: otp })
    });
    const data = await response.json();
    if (data.success) {
      showToast('🎉 ' + data.message, 'success');
      tempRegisterData = null;
    } else {
      showToast(data.message, 'error');
    }
  } catch (error) {
    showToast('Error verifying OTP.', 'error');
  }
}

/* ============================================================
   NAVIGATION
   ============================================================ */
function navigateStudent(dest) {
  currentCourseId = null;
  window.currentSelectedCourseId = null;
  currentMaterialFilter = 'all';
  const path = dest === 'courses' ? '#/courses' : dest === 'saved' ? '#/saved' : '#/home';
  pushHash(path);
  studentNav = dest;
  renderApp();
}

function viewCourseDetail(courseId) {
  currentCourseId = courseId;
  window.currentSelectedCourseId = courseId;
  currentMaterialFilter = 'all';
  pushHash(`#/course/${courseId}`);
  renderApp();
}

function goBackFromDetail() {
  if (history.length > 1) {
    history.back();
  } else {
    currentCourseId = null;
    window.currentSelectedCourseId = null;
    pushHash('#/home');
    renderApp();
  }
}

function setMaterialFilter(type) {
  currentMaterialFilter = type;
  if (window.currentSelectedCourseId) renderCourseDetail(window.currentSelectedCourseId);
}

/* ============================================================
   RENDER APP
   ============================================================ */
function renderApp() {
  $('loginView').classList.remove('active');
  $('adminView').classList.remove('active');
  $('studentHomeView').classList.remove('active');
  $('studentCoursesView').classList.remove('active');
  $('studentSavedView').classList.remove('active');
  $('courseDetailView').classList.remove('active');
  $('appHeader').style.display = 'none';
  $('appFooter').style.display = 'none';

  if (!currentUser) {
    $('loginView').classList.add('active');
    return;
  }

  $('appHeader').style.display = 'flex';
  $('appFooter').style.display = 'block';
  $('userDisplay').textContent = currentUser.username;
  $('roleBadge').textContent = currentUser.role === 'admin' ? 'Admin' : 'Student';
  $('roleBadge').className = 'role-badge ' + currentUser.role;

  // Streak badge
  const streakEl = $('streakBadge');
  const streakNum = $('streakCount');
  if (streakEl && streakNum) {
    if (currentUser.role === 'student' && (currentUser.streakCount || 0) >= 2) {
      streakEl.style.display = 'inline-flex';
      streakNum.textContent = currentUser.streakCount;
      streakEl.title = `${currentUser.streakCount}-day streak! Best: ${currentUser.longestStreak || currentUser.streakCount}`;
    } else {
      streakEl.style.display = 'none';
    }
  }

  renderNotificationBadge();
  buildNav();

  if (currentCourseId) {
    $('courseDetailView').classList.add('active');
    renderCourseDetail(currentCourseId);
    return;
  }

  if (currentUser.role === 'admin') {
    $('adminView').classList.add('active');
    renderAdminDashboard();
    return;
  }

  if (studentNav === 'home') {
    $('studentHomeView').classList.add('active');
    renderStudentHome();
  } else if (studentNav === 'saved') {
    $('studentSavedView').classList.add('active');
    renderSavedCourses();
  } else {
    $('studentCoursesView').classList.add('active');
    renderStudentCourses();
  }
}

function buildNav() {
  if (currentUser.role === 'admin') {
    $('mainNav').innerHTML = `<a href="#" class="active" onclick="event.preventDefault();">Dashboard</a>`;
    return;
  }

  const homeActive    = (studentNav === 'home'    && !currentCourseId) ? 'active' : '';
  const coursesActive = (studentNav === 'courses' && !currentCourseId) ? 'active' : '';
  const savedActive   = (studentNav === 'saved'   && !currentCourseId) ? 'active' : '';
  const savedCount = (currentUser.bookmarks || []).length;

  $('mainNav').innerHTML = `
    <a href="#" class="${homeActive}" onclick="event.preventDefault();navigateStudent('home')"><i class="fas fa-home"></i> Home</a>
    <a href="#" class="${coursesActive}" onclick="event.preventDefault();navigateStudent('courses')"><i class="fas fa-book"></i> Courses</a>
    <a href="#" class="${savedActive}" onclick="event.preventDefault();navigateStudent('saved')"><i class="fas fa-bookmark"></i> Saved${savedCount > 0 ? ' <span class="nav-count">' + savedCount + '</span>' : ''}</a>
  `;
}

/* ============================================================
   NOTIFICATIONS
   ============================================================ */
function getUnreadCount() {
  return (currentUser?.notifications || []).filter(n => !n.read).length;
}

function renderNotificationBadge() {
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  const count = getUnreadCount();
  if (count > 0) {
    badge.textContent = count > 9 ? '9+' : count;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

function renderNotificationList() {
  const list = document.getElementById('notifList');
  const markAll = document.getElementById('notifMarkAll');
  if (!list) return;

  const notifs = (currentUser?.notifications || [])
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (notifs.length === 0) {
    list.innerHTML = `
      <div class="notif-empty">
        <i class="fas fa-bell-slash"></i>
        <p>No notifications yet.</p>
      </div>`;
    if (markAll) markAll.style.display = 'none';
    return;
  }

  const unread = notifs.filter(n => !n.read).length;
  if (markAll) markAll.style.display = unread > 0 ? 'inline-block' : 'none';

  let html = '';
  notifs.forEach(n => {
    const ago = timeAgo(n.createdAt);
    const icon = n.type === 'doubt-reply' ? 'fa-comment-dots' : 'fa-bell';
    html += `
      <div class="notif-item ${n.read ? '' : 'unread'}" onclick="openNotification('${n.id}')">
        <div class="notif-icon"><i class="fas ${icon}"></i></div>
        <div class="notif-content">
          <div class="notif-title">${escapeHtml(n.title)}</div>
          <div class="notif-body">${escapeHtml(n.body)}</div>
          <div class="notif-time">${ago}</div>
        </div>
        ${!n.read ? '<span class="notif-dot"></span>' : ''}
      </div>`;
  });
  list.innerHTML = html;
}

async function openNotification(notifId) {
  const n = (currentUser?.notifications || []).find(x => x.id === notifId);
  if (!n) return;

  if (!n.read) {
    try {
      const res = await fetch(`https://aerospace-portal.onrender.com/api/user/notifications/${currentUser._id}/mark-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifId })
      });
      const data = await res.json();
      if (data.success) {
        currentUser.notifications = data.notifications;
        localStorage.setItem('aero_user', JSON.stringify(currentUser));
        renderNotificationBadge();
        renderNotificationList();
      }
    } catch { /* silent */ }
  }

  document.getElementById('notifWrap')?.classList.remove('open');
  if (n.link) location.hash = n.link;
}

async function markAllNotificationsRead() {
  if (!currentUser?._id) return;
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/user/notifications/${currentUser._id}/mark-read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true })
    });
    const data = await res.json();
    if (data.success) {
      currentUser.notifications = data.notifications;
      localStorage.setItem('aero_user', JSON.stringify(currentUser));
      renderNotificationBadge();
      renderNotificationList();
      showToast('All notifications marked read.', 'success');
    }
  } catch {
    showToast('Server error.', 'error');
  }
}

async function loadNotifications() {
  if (!currentUser?._id) return;
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/user/notifications/${currentUser._id}`);
    const data = await res.json();
    if (data.success) {
      currentUser.notifications = data.notifications;
      localStorage.setItem('aero_user', JSON.stringify(currentUser));
      renderNotificationBadge();
      renderNotificationList();
    }
  } catch { /* silent */ }
}

/* ============================================================
   ADMIN DASHBOARD
   ============================================================ */
function switchAdminTab(tab) {
  adminTab = tab;
  pushHash(`#/admin/${tab}`);
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
  const filtered = courses.filter(c =>
    c.name.toLowerCase().includes(searchTerm) ||
    (c.code && c.code.toLowerCase().includes(searchTerm))
  );

  $('statCourses').textContent = courses.length;
  $('statMaterials').textContent = courses.reduce((sum, c) => sum + (c.materials ? c.materials.length : 0), 0);
  $('statStudents').textContent = '...';

  try {
    const res = await fetch('https://aerospace-portal.onrender.com/api/students');
    const data = await res.json();
    if (data.success) $('statStudents').textContent = data.students.length;
  } catch (e) {
    $('statStudents').textContent = 'Error';
  }

  if (filtered.length === 0) {
    $('adminCourseList').innerHTML = `<div class="empty-state"><i class="fas fa-search"></i><p>No courses found.</p></div>`;
    return;
  }

  let html = `<div class="course-grid">`;
  filtered.forEach(c => {
    const matCount = c.materials ? c.materials.length : 0;
    const premiumLabel = c.isPremium ? `<span class="premium-badge"><i class="fas fa-crown"></i> Premium</span>` : '';

    const pendingDoubts = (c.doubts || []).filter(d => !d.answer).length;
    const alertHtml = pendingDoubts > 0 ? `
      <div class="admin-alert">
        <span><i class="fas fa-bell"></i> ${pendingDoubts} Pending Doubt(s)</span>
        <button onclick="event.stopPropagation(); currentMaterialFilter='qa'; viewCourseDetail('${c.id}');">
          Reply Now <i class="fas fa-arrow-right"></i>
        </button>
      </div>` : '';

    html += `
      <div class="course-card" style="${accentStyle(c.code || c.name)}">
        <button class="delete-course-btn" onclick="event.stopPropagation();deleteCourse('${c.id}')" title="Delete course"><i class="fas fa-trash-alt"></i></button>
        <div class="course-code">${escapeHtml(c.code) || 'N/A'} ${premiumLabel}</div>
        <h3>${escapeHtml(c.name)}</h3>
        ${alertHtml}
        <div class="course-meta">
          <span><i class="fas fa-user"></i> ${escapeHtml(c.instructor) || '—'}</span>
          <span><i class="fas fa-calendar-alt"></i> ${escapeHtml(c.semester) || '—'}</span>
          ${c.isPremium ? `<span><i class="fas fa-rupee-sign"></i> ${c.price || 0}</span>` : ''}
        </div>
        <div class="material-count"><i class="fas fa-file-alt"></i> ${matCount} materials</div>
        <div class="card-actions">
          <button class="btn btn-warning btn-sm" onclick="event.stopPropagation();editCourse('${c.id}')"><i class="fas fa-edit"></i> Edit</button>
          <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();viewCourseDetail('${c.id}')"><i class="fas fa-eye"></i> View</button>
          <button class="btn btn-success btn-sm" onclick="event.stopPropagation();openAddMaterialModal('${c.id}')"><i class="fas fa-plus"></i> Add Material</button>
        </div>
      </div>
    `;
  });
  html += `</div>`;
  $('adminCourseList').innerHTML = html;
}

function renderAdminProfessors() {
  const professors = getProfessors();
  if (professors.length === 0) {
    $('adminProfessorList').innerHTML = `<div class="empty-state"><i class="fas fa-chalkboard-teacher"></i><p>No professors added yet.</p></div>`;
    return;
  }

  let html = '';
  professors.forEach(p => {
    const photoHtml = p.photo
      ? `<img src="${p.photo}" alt="${escapeHtml(p.name)}">`
      : `<div class="avatar-placeholder"><i class="fas fa-user"></i></div>`;

    html += `
      <div class="admin-professor-item">
        ${photoHtml}
        <div class="info">
          <h4>${escapeHtml(p.name)}</h4>
          <div class="title">${escapeHtml(p.title)}</div>
          <div class="desc">${escapeHtml(p.description) || ''}</div>
        </div>
        <div class="actions">
          <button class="btn btn-danger btn-sm" onclick="deleteProfessor('${p.id}')"><i class="fas fa-trash"></i></button>
        </div>
      </div>`;
  });
  $('adminProfessorList').innerHTML = html;
}

async function renderAdminStudents() {
  const container = $('adminStudentList');
  if (!container) return;
  container.innerHTML = `<div class="empty-state"><p>Loading students from database...</p></div>`;

  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/students');
    const data = await response.json();

    if (data.success) {
      if (data.students.length === 0) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-users"></i><p>No students registered yet.</p></div>`;
        return;
      }

      let html = '';
      data.students.forEach(s => {
        html += `
          <div class="student-list-item">
            <div class="student-info">
              <h4>${escapeHtml(s.fullName || s.username)}</h4>
              <div>
                <strong>Username:</strong> @${escapeHtml(s.username)}<br>
                ${s.email ? `<strong>Email:</strong> ${escapeHtml(s.email)}` : '<span style="color:#ef4444">No email provided</span>'}
              </div>
            </div>
            <div class="student-purchases"><i class="fas fa-check-circle"></i> Registered</div>
          </div>`;
      });
      container.innerHTML = html;
    }
  } catch (error) {
    container.innerHTML = `<div class="empty-state"><p style="color:red;">Error fetching student list.</p></div>`;
  }
}

/* ============================================================
   STUDENT HOME
   ============================================================ */
function renderStudentHome() {
  renderStreakCard();
  renderContinueCard();

  const professors = getProfessors();
  if (professors.length === 0) {
    $('professorsGrid').innerHTML = `<p style="color:var(--text-tertiary);">No professors added yet.</p>`;
  } else {
    let html = '';
    professors.forEach(p => {
      const photoHtml = p.photo
        ? `<img src="${p.photo}" alt="${escapeHtml(p.name)}" class="professor-avatar">`
        : `<div class="professor-avatar avatar-placeholder-lg"><i class="fas fa-user"></i></div>`;

      html += `<div class="professor-card">
        ${photoHtml}
        <h3>${escapeHtml(p.name)}</h3>
        <div class="prof-title">${escapeHtml(p.title)}</div>
        <p>${escapeHtml(p.description) || ''}</p>
      </div>`;
    });
    $('professorsGrid').innerHTML = html;
  }
}

function renderStreakCard() {
  const container = document.getElementById('streakCardContainer');
  if (!container) return;

  if (currentUser.role !== 'student') {
    container.innerHTML = '';
    return;
  }

  const streak = currentUser.streakCount || 0;
  const longest = currentUser.longestStreak || 0;

  if (streak === 0 && longest === 0) {
    container.innerHTML = '';
    return;
  }

  let message = '';
  let icon = 'fa-fire';
  let tone = 'warm';

  if (streak === 0) {
    message = `Welcome back! Start a new streak today. Your best was ${longest} day${longest > 1 ? 's' : ''}.`;
    icon = 'fa-hourglass-start';
    tone = 'cool';
  } else if (streak < 3) {
    message = `You're on a ${streak}-day streak. Keep it going!`;
  } else if (streak < 7) {
    message = `🔥 ${streak} days strong! You're building momentum.`;
  } else if (streak < 30) {
    message = `🚀 ${streak}-day streak! That's serious consistency.`;
  } else {
    message = `🏆 ${streak} days! You're in the top tier of learners.`;
  }

  container.innerHTML = `
    <div class="streak-card ${tone}">
      <div class="streak-flame"><i class="fas ${icon}"></i></div>
      <div class="streak-info">
        <span class="streak-label">Daily Streak</span>
        <h3>${streak} day${streak === 1 ? '' : 's'}</h3>
        <p>${message}${longest > streak ? ` · Best: ${longest} days` : ''}</p>
      </div>
    </div>
  `;
}

function renderContinueCard() {
  const container = document.getElementById('continueCardContainer');
  if (!container) return;

  const la = currentUser?.lastActivity;
  if (!la || !la.courseId || currentUser.role !== 'student') {
    container.innerHTML = '';
    return;
  }

  const course = findCourse(la.courseId);
  if (!course) {
    container.innerHTML = '';
    return;
  }

  const acc = accentStyle(course.code || course.name);
  const viewedCount = getProgress(course.id).length;
  const totalMats = (course.materials || []).length;

  container.innerHTML = `
    <div class="continue-card" style="${acc}">
      <div class="continue-icon"><i class="fas fa-play-circle"></i></div>
      <div class="continue-info">
        <span class="continue-label"><i class="fas fa-history"></i> Continue where you left off</span>
        <h3>${escapeHtml(course.name)}</h3>
        <p>${viewedCount} of ${totalMats} materials completed · Last opened ${timeAgo(la.timestamp)}</p>
      </div>
      <button class="btn btn-primary continue-btn" onclick="viewCourseDetail('${course.id}')">
        <i class="fas fa-play"></i> Resume
      </button>
    </div>
  `;
}

/* ============================================================
   STUDENT COURSES
   ============================================================ */
function renderStudentCourses() {
  const courses = getCourses();
  const searchTerm = ($('studentCourseSearch').value || '').toLowerCase().trim();
  const filtered = courses.filter(c =>
    c.name.toLowerCase().includes(searchTerm) ||
    (c.code && c.code.toLowerCase().includes(searchTerm))
  );

  if (filtered.length === 0) {
    $('studentCourseList').innerHTML = `<div class="empty-state"><i class="fas fa-book-open"></i><p>No courses available.</p></div>`;
    return;
  }

  let html = `<div class="course-grid">`;
  filtered.forEach(c => {
    const isPurchased = currentUser.purchases && currentUser.purchases.includes(c.id);
    const saved = isBookmarked(c.id);
    const viewedCount = getProgress(c.id).length;
    const totalMats = (c.materials || []).length;
    const pct = totalMats > 0 ? Math.round((viewedCount / totalMats) * 100) : 0;

    const progressHtml = totalMats > 0 ? `
      <div class="course-progress">
        <div class="course-progress-bar"><div style="width:${pct}%"></div></div>
        <span class="course-progress-text">${viewedCount}/${totalMats} completed</span>
      </div>` : '';

    let badge = c.isPremium
      ? `<span class="premium-badge"><i class="fas fa-crown"></i> Premium</span>${!isPurchased ? ` <span class="premium-badge premium-locked"><i class="fas fa-lock"></i> Locked</span>` : ''}`
      : '';

    html += `
      <div class="course-card" style="${accentStyle(c.code || c.name)}" onclick="viewCourseDetail('${c.id}')">
        <button class="bookmark-btn ${saved ? 'saved' : ''}" onclick="toggleBookmark(event, '${c.id}')" title="${saved ? 'Remove from saved' : 'Save course'}">
          <i class="fas fa-bookmark"></i>
        </button>
        <div class="course-code">${escapeHtml(c.code) || 'N/A'} ${badge}</div>
        <h3>${escapeHtml(c.name)}</h3>
        <div class="course-meta">
          <span><i class="fas fa-user"></i> ${escapeHtml(c.instructor) || '—'}</span>
          <span><i class="fas fa-calendar-alt"></i> ${escapeHtml(c.semester) || '—'}</span>
          ${c.isPremium ? `<span><i class="fas fa-rupee-sign"></i> ${c.price || 0}</span>` : ''}
        </div>
        <p class="course-desc">${escapeHtml(c.description) || ''}</p>
        <div class="material-count"><i class="fas fa-file-alt"></i> ${totalMats} materials</div>
        ${progressHtml}
        ${c.isPremium && !isPurchased ? `<div style="margin-top:10px;"><button class="btn btn-primary btn-sm" onclick="event.stopPropagation();showPaymentModal('${c.id}')"><i class="fas fa-shopping-cart"></i> Buy Now</button></div>` : ''}
      </div>
    `;
  });
  html += `</div>`;
  $('studentCourseList').innerHTML = html;
}

function renderSavedCourses() {
  const container = $('studentSavedList');
  const savedIds = currentUser.bookmarks || [];

  if (savedIds.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-bookmark"></i>
        <p>You haven't saved any courses yet.</p>
        <p style="margin-top:8px;font-size:13px;">Tap the bookmark icon on any course to save it for later.</p>
        <button class="btn btn-primary" style="margin-top:16px;" onclick="navigateStudent('courses')">
          <i class="fas fa-book"></i> Browse Courses
        </button>
      </div>`;
    return;
  }

  const courses = getCourses().filter(c => savedIds.includes(c.id));

  if (courses.length === 0) {
    container.innerHTML = `<div class="empty-state"><i class="fas fa-bookmark"></i><p>Saved courses are no longer available.</p></div>`;
    return;
  }

  let html = `<div class="course-grid">`;
  courses.forEach(c => {
    const isPurchased = currentUser.purchases && currentUser.purchases.includes(c.id);
    const isPremiumCourse = c.isPremium || false;
    const viewedCount = getProgress(c.id).length;
    const totalMats = (c.materials || []).length;
    const pct = totalMats > 0 ? Math.round((viewedCount / totalMats) * 100) : 0;

    html += `
      <div class="course-card" style="${accentStyle(c.code || c.name)}" onclick="viewCourseDetail('${c.id}')">
        <button class="bookmark-btn saved" onclick="toggleBookmark(event, '${c.id}')" title="Remove from saved">
          <i class="fas fa-bookmark"></i>
        </button>
        <div class="course-code">${escapeHtml(c.code) || 'N/A'} ${isPremiumCourse ? '<span class="premium-badge"><i class="fas fa-crown"></i> Premium</span>' : ''}</div>
        <h3>${escapeHtml(c.name)}</h3>
        <div class="course-meta">
          <span><i class="fas fa-user"></i> ${escapeHtml(c.instructor) || '—'}</span>
          <span><i class="fas fa-calendar-alt"></i> ${escapeHtml(c.semester) || '—'}</span>
        </div>
        <div class="material-count"><i class="fas fa-file-alt"></i> ${totalMats} materials</div>
        ${totalMats > 0 ? `<div class="course-progress"><div class="course-progress-bar"><div style="width:${pct}%"></div></div><span class="course-progress-text">${viewedCount}/${totalMats} completed</span></div>` : ''}
      </div>
    `;
  });
  html += `</div>`;
  container.innerHTML = html;
}

/* ============================================================
   COURSE DETAIL
   ============================================================ */
function renderCourseDetail(courseId) {
  const course = findCourse(courseId);
  if (!course) {
    $('courseDetailContent').innerHTML = `<div class="empty-state"><p>Course not found.</p></div>`;
    return;
  }

  const isPremiumCourse = course.isPremium || false;
  const isPurchased = currentUser && currentUser.purchases && currentUser.purchases.includes(course.id);

  let html = `
    <div class="course-detail-header" style="${accentStyle(course.code || course.name)}">
      <h2>${escapeHtml(course.name)} ${isPremiumCourse ? '<span class="premium-badge"><i class="fas fa-crown"></i> Premium Course</span>' : ''}</h2>
      <div class="meta">
        <span><i class="fas fa-code"></i> ${escapeHtml(course.code) || 'N/A'}</span>
        <span><i class="fas fa-user"></i> ${escapeHtml(course.instructor) || '—'}</span>
        ${isPremiumCourse ? `<span><i class="fas fa-rupee-sign"></i> ${course.price || 0}</span>` : ''}
      </div>
      <p class="detail-desc">${escapeHtml(course.description) || ''}</p>
    </div>
  `;

  if (isPremiumCourse && currentUser.role === 'student' && !isPurchased) {
    html += `
      <div class="premium-notice">
        <div><i class="fas fa-info-circle"></i> Premium materials are locked.</div>
        <button class="btn btn-warning btn-sm" onclick="showPaymentModal('${course.id}')">
          <i class="fas fa-shopping-cart"></i> Buy Full Course (₹${course.price})
        </button>
      </div>`;
  }

  // Certificate earned banner
  if (currentUser.role === 'student') {
    const viewedCount = getProgress(course.id).length;
    const totalMats = (course.materials || []).length;
    const canAccess = !isPremiumCourse || isPurchased;

    if (canAccess && totalMats > 0 && viewedCount >= totalMats) {
      html += `
        <div class="cert-earned-banner">
          <div class="cert-earned-icon"><i class="fas fa-award"></i></div>
          <div class="cert-earned-info">
            <h4>🎉 Course Completed!</h4>
            <p>You've finished all ${totalMats} materials. Claim your certificate.</p>
          </div>
          <button class="btn btn-accent" onclick="generateCertificate('${course.id}')">
            <i class="fas fa-download"></i> Get Certificate
          </button>
        </div>`;
    }
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

  /* ===== Q&A section ===== */
  if (currentMaterialFilter === 'qa') {
    const doubts = [...(course.doubts || [])];
    html += `<div class="qa-section">
      <h3><i class="fas fa-comments"></i> Course Q&A / Doubts</h3>`;

    if (currentUser.role === 'student') {
      html += `
        <div class="qa-ask-box">
          <label>Ask a New Doubt</label>
          <textarea id="newDoubtText" placeholder="Type your doubt here..."></textarea>
          <button class="btn btn-primary" onclick="askDoubt('${course.id}')"><i class="fas fa-paper-plane"></i> Submit Doubt</button>
        </div>`;
    }

    if (doubts.length === 0) {
      html += `<div class="empty-state" style="padding: 20px;"><i class="fas fa-check-circle"></i><p>No doubts asked yet.</p></div>`;
    } else {
      doubts.sort((a, b) => {
        if (!a.answer && b.answer) return -1;
        if (a.answer && !b.answer) return 1;
        return 0;
      });

      doubts.forEach(d => {
        const isAnswered = !!d.answer;
        const statusBadge = isAnswered
          ? `<span class="qa-status solved">SOLVED</span>`
          : `<span class="qa-status pending">PENDING</span>`;

        const dateText = d.date ? new Date(d.date).toLocaleDateString() : 'Recent';
        const emailText = d.studentEmail ? escapeHtml(d.studentEmail) : 'No Email';
        const usernameText = d.studentUsername ? `@${escapeHtml(d.studentUsername)}` : '';

        html += `
          <div class="qa-item ${isAnswered ? 'solved' : 'pending'}">
            <div class="qa-head">
              <div>
                <strong><i class="fas fa-user-circle"></i> ${escapeHtml(d.studentName)} <span class="qa-username">${usernameText}</span></strong>
                ${currentUser.role === 'admin' ? `<div class="qa-email"><i class="fas fa-envelope"></i> ${emailText}</div>` : ''}
              </div>
              <div>${statusBadge} <span class="qa-date">${dateText}</span></div>
            </div>
            <p class="qa-question"><strong>Q:</strong> ${escapeHtml(d.question)}</p>
            ${isAnswered
              ? `<div class="qa-answer"><i class="fas fa-chalkboard-teacher"></i> <strong>Admin Reply:</strong> ${escapeHtml(d.answer)}</div>`
              : (currentUser.role === 'admin'
                  ? `<button class="btn btn-success btn-sm" onclick="replyDoubt('${course.id}', '${d._id || d.id}')"><i class="fas fa-reply"></i> Give Reply</button>`
                  : `<div class="qa-waiting"><i class="fas fa-clock"></i> Waiting for admin's reply...</div>`)
            }
          </div>`;
      });
    }
    html += `</div>`;
    $('courseDetailContent').innerHTML = html;
    return;
  }

  /* ===== Material list ===== */
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
      const viewed = isMaterialViewed(course.id, m.id);

      let fileActionHtml = '';
      if (!canAccess) {
        fileActionHtml = `<button class="btn btn-warning btn-sm" onclick="showPaymentModal('${course.id}', '${m.id}')"><i class="fas fa-lock"></i> Unlock for ₹${matPrice}</button>`;
      } else {
        if (hasFile) {
          fileActionHtml += currentUser.role === 'admin'
            ? `<a href="${m.fileData}" download="${escapeHtml(m.fileName) || 'download'}" class="btn btn-primary btn-sm"><i class="fas fa-download"></i> Download</a> <button class="btn btn-outline btn-sm" onclick="viewFileOnline('${course.id}', '${m.id}')"><i class="fas fa-eye"></i> View</button>`
            : `<button class="btn btn-primary btn-sm" onclick="viewFileOnline('${course.id}', '${m.id}')"><i class="fas fa-eye"></i> View Content</button>`;
        }
        if (hasUrl) {
          fileActionHtml += ` <a href="${escapeHtml(m.url)}" target="_blank" rel="noopener" class="btn btn-primary btn-sm"><i class="fas fa-external-link-alt"></i> Open Link</a>`;
        }
      }

      let progressBtnHtml = '';
      if (currentUser.role === 'student' && canAccess) {
        progressBtnHtml = `<button class="btn ${viewed ? 'btn-success' : 'btn-outline'} btn-sm" onclick="event.stopPropagation();toggleMaterialViewed(event, '${course.id}', '${m.id}')">
          <i class="fas ${viewed ? 'fa-check-circle' : 'fa-circle'}"></i> ${viewed ? 'Completed' : 'Mark done'}
        </button>`;
      }

      const badgeHtml = isMatPremium
        ? `<span class="mat-badge premium"><i class="fas fa-crown"></i> PRO (₹${matPrice})</span>`
        : `<span class="mat-badge free">FREE</span>`;

      html += `
        <div class="material-item ${!canAccess ? 'locked-mat' : ''}">
          ${currentUser.role === 'admin' ? `
            <button class="delete-mat-btn edit" onclick="editMaterial('${course.id}', '${m.id}')" title="Edit"><i class="fas fa-edit"></i></button>
            <button class="delete-mat-btn" onclick="deleteMaterial('${course.id}','${m.id}')" title="Delete"><i class="fas fa-times-circle"></i></button>
          ` : ''}
          <div class="mat-head">
            <div class="mat-type ${m.type}">${m.type.toUpperCase()}</div>
            ${badgeHtml}
          </div>
          <h4>${escapeHtml(m.title)}</h4>
          <div class="mat-desc">${escapeHtml(m.description) || ''}</div>
          <div class="mat-actions">${fileActionHtml}${progressBtnHtml}</div>
        </div>
      `;
    });
    html += `</div>`;
  }
  $('courseDetailContent').innerHTML = html;
}

/* ============================================================
   CERTIFICATE
   ============================================================ */
function generateCertificate(courseId) {
  const course = findCourse(courseId);
  if (!course) return;

  const viewedCount = getProgress(course.id).length;
  const totalMats = (course.materials || []).length;
  if (totalMats === 0 || viewedCount < totalMats) {
    return showToast('Complete all materials to earn a certificate.', 'error');
  }

  const studentName = currentUser.fullName || currentUser.username;
  const completionDate = new Date().toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric'
  });

  const certId = 'AERO-' +
    (course.code || 'CRS').toUpperCase().replace(/[^A-Z0-9]/g, '') + '-' +
    String(currentUser._id).slice(-4).toUpperCase() + '-' +
    Date.now().toString(36).toUpperCase();

  const acc = getCourseAccent(course.code || course.name);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Certificate — ${escapeHtml(course.name)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Playfair+Display:wght@600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      font-family: 'Inter', sans-serif;
      background: #f0f4f8;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 30px 20px;
    }
    .toolbar {
      position: fixed;
      top: 20px; right: 20px;
      z-index: 100;
    }
    .btn-print {
      padding: 12px 22px;
      border: none;
      border-radius: 10px;
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: .2s;
      background: linear-gradient(135deg, #4f46e5, #6366f1);
      color: #fff;
      box-shadow: 0 6px 18px rgba(79,70,229,.35);
    }
    .btn-print:hover { transform: translateY(-2px); box-shadow: 0 10px 24px rgba(79,70,229,.45); }
    .cert {
      position: relative;
      width: 100%;
      max-width: 1000px;
      aspect-ratio: 1.414 / 1;
      background: #fff;
      box-shadow: 0 20px 60px rgba(15,23,42,.15);
      overflow: hidden;
      border-radius: 8px;
    }
    .cert-bg { position: absolute; inset: 0; pointer-events: none; }
    .cert-bg::before {
      content: ""; position: absolute; top: -20%; right: -15%;
      width: 500px; height: 500px; border-radius: 50%;
      background: radial-gradient(circle, ${acc.solid}22, transparent 70%);
    }
    .cert-bg::after {
      content: ""; position: absolute; bottom: -25%; left: -12%;
      width: 460px; height: 460px; border-radius: 50%;
      background: radial-gradient(circle, #f59e0b1a, transparent 70%);
    }
    .cert-inner {
      position: absolute; inset: 20px;
      border: 3px solid #0f172a; border-radius: 6px;
      padding: 40px 60px;
      display: flex; flex-direction: column;
      align-items: center; text-align: center; z-index: 1;
    }
    .cert-inner::before {
      content: ""; position: absolute; inset: 6px;
      border: 1px solid #cbd5e1; border-radius: 4px; pointer-events: none;
    }
    .corner { position: absolute; width: 40px; height: 40px; border: 3px solid ${acc.solid}; }
    .corner.tl { top: 8px; left: 8px; border-right: none; border-bottom: none; }
    .corner.tr { top: 8px; right: 8px; border-left: none; border-bottom: none; }
    .corner.bl { bottom: 8px; left: 8px; border-right: none; border-top: none; }
    .corner.br { bottom: 8px; right: 8px; border-left: none; border-top: none; }
    .cert-header { display: flex; align-items: center; gap: 14px; margin-bottom: 8px; }
    .cert-logo {
      width: 52px; height: 52px; border-radius: 12px;
      background: linear-gradient(135deg, ${acc.from}, ${acc.to});
      display: flex; align-items: center; justify-content: center;
      font-size: 26px; color: #fff;
      box-shadow: 0 8px 20px ${acc.solid}44;
    }
    .cert-dept { text-align: left; }
    .cert-dept h1 { font-size: 20px; font-weight: 800; color: #0f172a; letter-spacing: -.3px; }
    .cert-dept span { font-size: 12px; color: #64748b; font-weight: 500; letter-spacing: 1px; text-transform: uppercase; }
    .cert-title {
      font-family: 'Playfair Display', serif;
      font-size: 46px; font-weight: 800;
      color: #0f172a; letter-spacing: -.5px;
      margin: 22px 0 6px; line-height: 1;
    }
    .cert-subtitle {
      font-size: 13px; color: #64748b;
      letter-spacing: 3px; text-transform: uppercase;
      font-weight: 600; margin-bottom: 24px;
    }
    .cert-presented { font-size: 14px; color: #475569; margin-bottom: 8px; }
    .cert-name {
      font-family: 'Playfair Display', serif;
      font-size: 42px; font-weight: 700;
      color: ${acc.solid}; letter-spacing: -.3px;
      margin: 4px 0 14px; padding-bottom: 8px;
      border-bottom: 2px solid #e2e8f0;
      min-width: 400px; display: inline-block;
    }
    .cert-completed { font-size: 14px; color: #475569; margin-bottom: 10px; }
    .cert-course { font-size: 22px; font-weight: 700; color: #0f172a; margin-bottom: 4px; }
    .cert-code {
      font-size: 12px; color: #64748b;
      letter-spacing: 2px; text-transform: uppercase;
      font-weight: 600; margin-bottom: 34px;
    }
    .cert-footer {
      margin-top: auto; width: 100%;
      display: flex; justify-content: space-between;
      align-items: flex-end; padding-top: 20px;
      border-top: 1px solid #e2e8f0;
    }
    .cert-sign { text-align: center; min-width: 180px; }
    .cert-sign-line {
      font-family: 'Playfair Display', serif;
      font-size: 22px; font-style: italic;
      color: #0f172a; margin-bottom: 4px;
      border-bottom: 1.5px solid #cbd5e1; padding-bottom: 4px;
    }
    .cert-sign-role {
      font-size: 11px; color: #64748b;
      text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600;
    }
    .cert-meta { text-align: center; font-size: 11px; color: #94a3b8; letter-spacing: .5px; }
    .cert-meta strong {
      color: #475569; font-weight: 700;
      font-family: 'Courier New', monospace;
      font-size: 12px; letter-spacing: 1px;
    }
    .cert-seal {
      position: absolute; bottom: 28px; right: 42px;
      width: 92px; height: 92px; border-radius: 50%;
      background: linear-gradient(135deg, #f59e0b, #d97706);
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-size: 10px; font-weight: 800;
      letter-spacing: 1px; text-align: center;
      box-shadow: 0 8px 24px rgba(245,158,11,.4);
      border: 3px solid #fff; transform: rotate(-8deg);
    }
    .cert-seal-inner { display: flex; flex-direction: column; align-items: center; gap: 2px; }
    .cert-seal i { font-size: 20px; }
    @page { size: A4 landscape; margin: 0; }
    @media print {
      body { background: #fff; padding: 0; }
      .toolbar { display: none !important; }
      .cert { box-shadow: none; border-radius: 0; width: 100vw; height: 100vh; max-width: none; aspect-ratio: auto; }
    }
    @media (max-width: 800px) {
      .cert { aspect-ratio: auto; min-height: 600px; }
      .cert-inner { padding: 20px 24px; position: relative; inset: auto; }
      .cert-title { font-size: 32px; }
      .cert-name { font-size: 28px; min-width: 260px; }
      .cert-course { font-size: 18px; }
      .cert-footer { flex-direction: column; gap: 14px; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button class="btn-print" onclick="window.print()">
      <i class="fas fa-download"></i> Print / Save as PDF
    </button>
  </div>
  <div class="cert">
    <div class="cert-bg"></div>
    <div class="cert-inner">
      <div class="corner tl"></div>
      <div class="corner tr"></div>
      <div class="corner bl"></div>
      <div class="corner br"></div>
      <div class="cert-header">
        <div class="cert-logo"><i class="fas fa-rocket"></i></div>
        <div class="cert-dept">
          <h1>Aerospace Department</h1>
          <span>IIT Kharagpur</span>
        </div>
      </div>
      <div class="cert-title">Certificate</div>
      <div class="cert-subtitle">of Completion</div>
      <div class="cert-presented">This certificate is proudly presented to</div>
      <div class="cert-name">${escapeHtml(studentName)}</div>
      <div class="cert-completed">for successfully completing</div>
      <div class="cert-course">${escapeHtml(course.name)}</div>
      <div class="cert-code">${escapeHtml(course.code) || ''} · Completed on ${completionDate}</div>
      <div class="cert-footer">
        <div class="cert-meta">
          Certificate ID<br>
          <strong>${certId}</strong>
        </div>
        <div class="cert-sign">
          <div class="cert-sign-line">Krish Yadav</div>
          <div class="cert-sign-role">Course Director</div>
        </div>
      </div>
    </div>
    <div class="cert-seal">
      <div class="cert-seal-inner">
        <i class="fas fa-check-circle"></i>
        <div>VERIFIED</div>
      </div>
    </div>
  </div>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) return showToast('Please allow popups to view your certificate.', 'error');
  win.document.write(html);
  win.document.close();
  showToast('🎓 Certificate generated!', 'success');
}

/* ============================================================
   FILE VIEWER
   ============================================================ */
async function viewFileOnline(courseId, materialId) {
  const course = findCourse(courseId);
  if (!course) return;
  const mat = course.materials.find(m => m.id === materialId);
  if (mat && mat.fileData) {
    try {
      const response = await fetch(mat.fileData);
      const blob = await response.blob();
      window.open(URL.createObjectURL(blob), '_blank');
    } catch (error) {
      showToast('Error opening file online.', 'error');
    }
  } else {
    showToast('No file attached.', 'info');
  }
}

/* ============================================================
   BOOKMARK + PROGRESS ACTIONS
   ============================================================ */
async function toggleBookmark(e, courseId) {
  if (e) e.stopPropagation();
  if (!currentUser?._id) return;

  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/user/bookmarks/${courseId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser._id })
    });
    const data = await res.json();

    if (data.success) {
      currentUser.bookmarks = data.bookmarks;
      localStorage.setItem('aero_user', JSON.stringify(currentUser));
      showToast(data.bookmarked ? '★ Saved to your list' : 'Removed from saved', 'success');
      renderApp();
    } else {
      showToast(data.message || 'Failed to update bookmark.', 'error');
    }
  } catch {
    showToast('Server error.', 'error');
  }
}

async function toggleMaterialViewed(e, courseId, materialId) {
  if (e) e.stopPropagation();
  const currently = isMaterialViewed(courseId, materialId);

  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/user/progress/${courseId}/${materialId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser._id, viewed: !currently })
    });
    const data = await res.json();

    if (data.success) {
      currentUser.progress = data.progress;
      currentUser.lastActivity = data.lastActivity;
      if (data.streakCount !== undefined) currentUser.streakCount = data.streakCount;
      if (data.longestStreak !== undefined) currentUser.longestStreak = data.longestStreak;
      if (data.lastActiveDate) currentUser.lastActiveDate = data.lastActiveDate;
      localStorage.setItem('aero_user', JSON.stringify(currentUser));
      renderApp();
    } else {
      showToast(data.message || 'Failed to update progress.', 'error');
    }
  } catch {
    showToast('Server error.', 'error');
  }
}

async function refreshUserData() {
  if (!currentUser?._id) return;
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/user/me/${currentUser._id}`);
    const data = await res.json();
    if (data.success) {
      currentUser = data.user;
      localStorage.setItem('aero_user', JSON.stringify(currentUser));
    }
  } catch { /* silent */ }
}

/* ============================================================
   COURSE CRUD (admin)
   ============================================================ */
function openAddCourseModal() {
  $('courseModalTitle').textContent = '📚 New Course';
  $('editCourseId').value = '';
  $('courseName').value = '';
  $('courseCode').value = '';
  $('courseSemester').value = '';
  $('courseInstructor').value = '';
  $('courseDescription').value = '';
  const pc = $('courseIsPremium'); if (pc) pc.checked = false;
  const pi = $('coursePrice'); if (pi) pi.value = '';
  const pg = $('priceGroup'); if (pg) pg.style.display = 'none';
  openModal('courseModal');
}

function togglePriceInput() {
  const pg = $('priceGroup');
  const pc = $('courseIsPremium');
  if (pg && pc) pg.style.display = pc.checked ? 'block' : 'none';
}

async function saveCourse(e) {
  e.preventDefault();
  const id = $('editCourseId').value;
  const courseData = {
    name: $('courseName').value.trim(),
    code: $('courseCode').value.trim(),
    semester: $('courseSemester').value.trim(),
    instructor: $('courseInstructor').value.trim(),
    description: $('courseDescription').value.trim(),
    isPremium: $('courseIsPremium').checked,
    price: parseFloat($('coursePrice').value) || 0
  };
  if (!courseData.name || !courseData.code) return showToast('Name and code required.', 'error');

  try {
    if (id) {
      showToast('Edit feature coming soon!', 'info');
      closeModal('courseModal');
    } else {
      const response = await fetch('https://aerospace-portal.onrender.com/api/courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(courseData)
      });
      const data = await response.json();
      if (data.success) {
        showToast('🎉 Course created!', 'success');
        closeModal('courseModal');
        fetchCoursesFromDB();
      } else {
        showToast(data.message || 'Failed to create course.', 'error');
      }
    }
  } catch (error) {
    showToast('Server error.', 'error');
  }
}

async function deleteCourse(courseId) {
  if (!confirm('Are you sure you want to delete this course and all its materials?')) return;
  try {
    const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}`, { method: 'DELETE' });
    const data = await response.json();
    if (data.success) {
      if (currentCourseId === courseId) {
        currentCourseId = null;
        pushHash('#/admin/courses');
      }
      showToast('🗑️ Course deleted.', 'info');
      fetchCoursesFromDB();
    } else {
      showToast(data.message || 'Failed to delete course.', 'error');
    }
  } catch (error) {
    showToast('Server error.', 'error');
  }
}

async function editCourse(courseId) {
  const course = findCourse(courseId);
  if (!course) return;
  const newTitle = prompt('Update Course Name:', course.name); if (newTitle === null) return;
  const newDesc = prompt('Update Course Description:', course.description || ''); if (newDesc === null) return;
  let newPrice = prompt('Update Course Price (₹):', course.price || 0); if (newPrice === null) return;
  newPrice = parseFloat(newPrice) || 0;
  const isPremium = newPrice > 0;

  try {
    const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newTitle, description: newDesc, price: newPrice, isPremium })
    });
    const data = await response.json();
    if (data.success) {
      showToast('✏️ ' + data.message, 'success');
      fetchCoursesFromDB();
    } else {
      showToast(data.message, 'error');
    }
  } catch (error) {
    showToast('Error connecting to server.', 'error');
  }
}

/* ============================================================
   MATERIAL CRUD (admin)
   ============================================================ */
window.toggleMaterialPriceInput = function () {
  const isPremium = $('materialIsPremium').checked;
  const priceGrp = $('materialPriceGroup');
  if (priceGrp) priceGrp.style.display = isPremium ? 'block' : 'none';
};

function openAddMaterialModal(courseId) {
  $('materialModalTitle').textContent = '📎 Add Material';
  $('editMaterialId').value = '';
  $('materialCourseId').value = courseId;
  $('materialTitle').value = '';
  $('materialType').value = 'video';
  $('materialDescription').value = '';
  $('materialUrl').value = '';
  $('materialFile').value = '';
  if ($('materialIsPremium')) $('materialIsPremium').checked = false;
  if ($('materialPrice')) $('materialPrice').value = '';
  toggleMaterialPriceInput();
  openModal('materialModal');
}

async function saveMaterial(e) {
  e.preventDefault();
  const courseId = $('materialCourseId').value;
  const materialId = $('editMaterialId').value;
  const file = $('materialFile').files ? $('materialFile').files[0] : null;

  const processSave = async (fileData, fileName) => {
    const isPremiumMat = $('materialIsPremium') ? $('materialIsPremium').checked : false;
    const matPrice = $('materialPrice') ? (parseFloat($('materialPrice').value) || 0) : 0;
    const materialData = {
      title: $('materialTitle').value.trim(),
      type: $('materialType').value,
      description: $('materialDescription').value.trim(),
      url: $('materialUrl').value.trim(),
      isPremium: isPremiumMat,
      price: matPrice,
      fileData,
      fileName
    };

    if (materialId) {
      showToast('Edit feature coming soon!', 'info');
      closeModal('materialModal');
    } else {
      try {
        const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/materials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(materialData)
        });
        const data = await response.json();
        if (data.success) {
          showToast('📎 Content successfully uploaded!', 'success');
          closeModal('materialModal');
          fetchCoursesFromDB();
        } else {
          showToast(data.message || 'Failed to upload material.', 'error');
        }
      } catch (error) {
        showToast('Server error.', 'error');
      }
    }
  };

  if (file) {
    const reader = new FileReader();
    reader.onload = ev => processSave(ev.target.result, file.name);
    reader.readAsDataURL(file);
  } else {
    processSave('', '');
  }
}

async function editMaterial(courseId, materialId) {
  const course = findCourse(courseId); if (!course) return;
  const mat = course.materials.find(m => m.id === materialId); if (!mat) return;

  const newTitle = prompt('Update Material Title:', mat.title); if (newTitle === null) return;
  const newDesc = prompt('Update Material Description:', mat.description || ''); if (newDesc === null) return;
  let newPrice = prompt('Update Material Unlock Price (₹) - [Type 0 to make it FREE]:', mat.price || 0); if (newPrice === null) return;
  newPrice = parseFloat(newPrice) || 0;
  const isPremium = newPrice > 0;

  try {
    const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/materials/${materialId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle, description: newDesc, isPremium, price: newPrice })
    });
    const data = await response.json();
    if (data.success) {
      showToast('✏️ Material updated!', 'success');
      fetchCoursesFromDB();
    } else {
      showToast(data.message || 'Failed to update material.', 'error');
    }
  } catch (error) {
    showToast('Error connecting to server.', 'error');
  }
}

async function deleteMaterial(courseId, materialId) {
  if (!confirm('Are you sure you want to delete this material?')) return;
  try {
    const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/materials/${materialId}`, { method: 'DELETE' });
    const data = await response.json();
    if (data.success) {
      showToast('Material deleted.', 'info');
      fetchCoursesFromDB();
    } else {
      showToast(data.message || 'Failed to delete material.', 'error');
    }
  } catch (error) {
    showToast('Server error.', 'error');
  }
}

/* ============================================================
   PROFESSORS (admin — localStorage)
   ============================================================ */
function openAddProfessorModal() {
  $('editProfessorId').value = '';
  $('professorName').value = '';
  $('professorTitle').value = '';
  $('professorDescription').value = '';
  $('professorPhoto').value = '';
  openModal('professorModal');
}

function saveProfessor(e) {
  e.preventDefault();
  const data = loadData();
  const name = $('professorName').value.trim();

  const processSave = (photoData) => {
    data.professors.push({
      id: generateId(),
      name,
      title: $('professorTitle').value.trim(),
      description: $('professorDescription').value.trim(),
      photo: photoData || ''
    });
    saveData(data);
    showToast('Professor added!', 'success');
    closeModal('professorModal');
    renderApp();
  };

  const photoFile = $('professorPhoto').files ? $('professorPhoto').files[0] : null;
  if (photoFile) {
    const reader = new FileReader();
    reader.onload = ev => processSave(ev.target.result);
    reader.readAsDataURL(photoFile);
  } else {
    processSave(null);
  }
}

function deleteProfessor(professorId) {
  if (!confirm('Delete this professor?')) return;
  const data = loadData();
  data.professors = data.professors.filter(p => p.id !== professorId);
  saveData(data);
  showToast('Professor deleted.', 'info');
  renderApp();
}

/* ============================================================
   Q&A ACTIONS
   ============================================================ */
async function askDoubt(courseId) {
  const textarea = $('newDoubtText'); if (!textarea) return;
  const question = textarea.value.trim();
  if (!question) return showToast('Please type your doubt or question first.', 'error');

  try {
    const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/doubts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentName: currentUser.fullName || currentUser.username,
        studentUsername: currentUser.username,
        studentEmail: currentUser.email || '',
        question
      })
    });
    const data = await response.json();
    if (data.success) {
      showToast('❓ Doubt submitted successfully!', 'success');
      textarea.value = '';
      fetchCoursesFromDB();
    } else {
      showToast(data.message || 'Error submitting doubt', 'error');
    }
  } catch (error) {
    showToast('Server error while submitting doubt.', 'error');
  }
}

async function replyDoubt(courseId, doubtId) {
  const answer = prompt('Enter your reply/solution for this student:');
  if (answer === null || answer.trim() === '') return;

  try {
    const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/doubts/${doubtId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: answer.trim() })
    });
    const data = await response.json();
    if (data.success) {
      showToast('💡 Answer posted successfully!', 'success');
      fetchCoursesFromDB();
    } else {
      showToast(data.message || 'Error posting answer', 'error');
    }
  } catch (error) {
    showToast('Server error while posting answer.', 'error');
  }
}

/* ============================================================
   PAYMENT
   ============================================================ */
async function showPaymentModal(courseId, materialId = null) {
  const course = findCourse(courseId); if (!course) return;

  let amount = course.price || 0;
  let itemName = course.name;
  let purchaseId = course.id;

  if (materialId) {
    const mat = course.materials.find(m => m.id === materialId);
    if (mat) { amount = mat.price || 0; itemName = mat.title; purchaseId = mat.id; }
  }

  showToast(`Initiating secure payment for ${itemName}...`, 'info');

  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount })
    });
    const data = await response.json();
    if (!data.success) return showToast('Error creating order.', 'error');

    const options = {
      key: 'rzp_test_TaPfJOdu1PgUed',
      amount: data.order.amount,
      currency: 'INR',
      name: 'Aerospace EdTech',
      description: `Purchase: ${itemName}`,
      order_id: data.order.id,
      handler: async function (response) {
        showToast('Verifying payment...', 'info');
        const verifyRes = await fetch('https://aerospace-portal.onrender.com/api/verify-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
            courseId: purchaseId,
            userId: currentUser._id
          })
        });
        const verifyData = await verifyRes.json();
        if (verifyData.success) {
          if (!currentUser.purchases) currentUser.purchases = [];
          if (!currentUser.purchases.includes(purchaseId)) currentUser.purchases.push(purchaseId);
          localStorage.setItem('aero_user', JSON.stringify(currentUser));
          showToast('🎉 Payment Successful! Content Unlocked.', 'success');
          renderApp();
        } else {
          showToast('Payment verification failed!', 'error');
        }
      },
      prefill: {
        name: currentUser.username,
        email: currentUser.email || 'student@aerospace.com',
        contact: '9999999999'
      },
      theme: { color: '#4f46e5' }
    };
    new Razorpay(options).open();
  } catch (error) {
    showToast('Server error during payment initialization.', 'error');
  }
}

/* ============================================================
   MODAL + TOAST
   ============================================================ */
function exportData() { showToast('Export feature is coming soon!', 'info'); }
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', function (e) { if (e.target === this) this.classList.remove('active'); });
});

function showToast(message, type = 'info') {
  const container = $('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const iconMap = {
    success: 'fa-check-circle',
    error:   'fa-exclamation-circle',
    info:    'fa-info-circle'
  };
  const icon = iconMap[type] || 'fa-info-circle';

  toast.innerHTML = `<i class="fas ${icon}"></i> <span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(30px)';
    setTimeout(() => toast.remove(), 350);
  }, 3500);
}

/* ============================================================
   INIT
   ============================================================ */
async function initApp() {
  const savedUser = localStorage.getItem('aero_user');
  if (savedUser) {
    currentUser = JSON.parse(savedUser);
    if (currentUser.role === 'admin') adminTab = 'courses';
  }
  syncHashToState();
  renderApp();
  await fetchCoursesFromDB();
  await refreshUserData();
  await loadNotifications();
  renderApp();
}

window.addEventListener('hashchange', () => {
  syncHashToState();
  renderApp();
});

initApp();