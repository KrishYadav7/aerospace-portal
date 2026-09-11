/* ============================================================
   STORAGE — Professors (localStorage)
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
   COURSES
   ============================================================ */
let liveCourses = [];
function getCourses() { return liveCourses; }
function findCourse(id) { return getCourses().find(c => c.id === id) || null; }

async function fetchCoursesFromDB() {
  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/courses?t=' + Date.now());
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
let adminTab = 'overview';
let editingCourseId = null;
let editingTab = 'details';

const $ = id => document.getElementById(id);

/* ============================================================
   HELPERS
   ============================================================ */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function syncHashToState() {
  const hash = location.hash || '#/home';
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);

  if (parts[0] === 'course' && parts[1]) {
    currentCourseId = parts[1];
    window.currentSelectedCourseId = parts[1];
    editingCourseId = null;
    return;
  }
  if (parts[0] === 'admin' && parts[1] === 'edit' && parts[2]) {
    editingCourseId = parts[2];
    currentCourseId = null;
    window.currentSelectedCourseId = null;
    return;
  }

  currentCourseId = null;
  window.currentSelectedCourseId = null;
  editingCourseId = null;

  if (parts[0] === 'admin') {
    adminTab = parts[1] || 'overview';
  } else if (parts[0] === 'courses') {
    studentNav = 'courses';
  } else if (parts[0] === 'saved') {
    studentNav = 'saved';
  } else {
    studentNav = 'home';
  }
}

function pushHash(path) {
  if (location.hash !== path) history.pushState(null, '', path);
}

/* ============================================================
   COURSE ACCENTS
   ============================================================ */
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
  for (let i = 0; i < s.length; i++) { hash = ((hash << 5) - hash) + s.charCodeAt(i); hash |= 0; }
  return Math.abs(hash);
}
function getCourseAccent(codeOrName) { return COURSE_ACCENTS[hashString(codeOrName) % COURSE_ACCENTS.length]; }
function accentStyle(codeOrName) {
  const a = getCourseAccent(codeOrName);
  return `--accent-1:${a.from};--accent-2:${a.to};--accent-solid:${a.solid};--accent-soft:${a.soft};--accent-glow:${a.glow};`;
}

/* ============================================================
   USER HELPERS
   ============================================================ */
function isBookmarked(courseId) { return !!(currentUser?.bookmarks?.includes(courseId)); }
function getProgress(courseId) {
  if (!currentUser?.progress) return [];
  const p = currentUser.progress[courseId];
  return Array.isArray(p) ? p : [];
}
function isMaterialViewed(courseId, materialId) { return getProgress(courseId).includes(materialId); }
function timeAgo(date) {
  if (!date) return 'recently';
  const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
  return Math.floor(s / 86400) + ' days ago';
}
function difficultyColor(d) {
  if (d === 'Beginner') return { bg: 'rgba(16,185,129,.12)', fg: '#059669' };
  if (d === 'Advanced') return { bg: 'rgba(239,68,68,.12)', fg: '#dc2626' };
  return { bg: 'rgba(245,158,11,.14)', fg: '#d97706' };
}

/* Robust clipboard helper */
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch { return false; }
}

/* ============================================================
   THEME
   ============================================================ */
(function initTheme() {
  const saved = localStorage.getItem('aero_theme');
  const prefers = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', saved || (prefers ? 'dark' : 'light'));
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
  if (e.target.closest('.main-nav a')) document.getElementById('mainNav')?.classList.remove('open');

  const notifWrap = document.getElementById('notifWrap');
  if (notifWrap) {
    if (e.target.closest('#notifBtn')) {
      notifWrap.classList.toggle('open');
      if (notifWrap.classList.contains('open')) { renderNotificationList(); loadNotifications(); }
      return;
    }
    if (!e.target.closest('#notifWrap')) notifWrap.classList.remove('open');
  }
});
document.addEventListener('DOMContentLoaded', updateThemeIcon);

document.addEventListener('click', (e) => {
  if (e.target.closest('#notifMarkAll')) { e.stopPropagation(); markAllNotificationsRead(); }
});
document.addEventListener('click', (e) => {
  if (e.target.closest('#quizAddQuestionBtn')) { e.preventDefault(); addQuizQuestion(); }
});

/* ============================================================
   AUTH
   ============================================================ */
function setLoginRole(role) {
  loginRole = role;
  document.querySelectorAll('.login-role-toggle button').forEach(b =>
    b.classList.toggle('active', b.dataset.role === role));
}

async function handleLogin(e) {
  e.preventDefault();
  const username = $('loginUsername').value.trim();
  const password = $('loginPassword').value.trim();
  if (!username || !password) return showToast('Please enter both username and password.', 'error');
  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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
      adminTab = 'overview';
      editingCourseId = null;
      pushHash(data.user.role === 'admin' ? '#/admin/overview' : '#/home');
      showToast(data.message, 'success');
      renderApp();
    } else showToast(data.message, 'error');
  } catch { showToast('Server network error.', 'error'); }
}

function logout() {
  currentUser = null; currentCourseId = null; editingCourseId = null;
  window.currentSelectedCourseId = null;
  currentMaterialFilter = 'all'; studentNav = 'home'; adminTab = 'overview';
  localStorage.removeItem('aero_token'); localStorage.removeItem('aero_user');
  pushHash('#/home'); renderApp(); showToast('Logged out.', 'info');
}

function showRegisterModal() {
  ['regFullName', 'regUsername', 'regEmail', 'regPassword'].forEach(id => { const el = $(id); if (el) el.value = ''; });
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
  showToast('Sending OTP...', 'info');
  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/send-otp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username })
    });
    const data = await response.json();
    if (data.success) {
      tempRegisterData = { fullName, username, email, password };
      closeModal('registerModal');
      const enteredOtp = prompt(`OTP sent to ${email}.\n\nEnter your 6-digit OTP:`);
      if (enteredOtp) verifyAndCompleteRegistration(enteredOtp);
    } else showToast(data.message, 'error');
  } catch { showToast('Server network error.', 'error'); }
}
async function verifyAndCompleteRegistration(otp) {
  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...tempRegisterData, otp })
    });
    const data = await response.json();
    if (data.success) { showToast('🎉 ' + data.message, 'success'); tempRegisterData = null; }
    else showToast(data.message, 'error');
  } catch { showToast('Error verifying OTP.', 'error'); }
}

/* ============================================================
   ADMIN — Manual Student Registration
   ============================================================ */
function openStudentRegModal() {
  ['newStuFullName', 'newStuUsername', 'newStuEmail', 'newStuPassword'].forEach(id => {
    const el = $(id); if (el) el.value = '';
  });
  const btn = $('studentRegSubmitBtn');
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-user-plus"></i> Create Student'; }
  openModal('studentRegModal');
  setTimeout(() => $('newStuFullName')?.focus(), 100);
}

function autoGeneratePassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const symbols = '@#$%&!';
  let pass = 'Aero@';
  for (let i = 0; i < 6; i++) pass += chars[Math.floor(Math.random() * chars.length)];
  pass += symbols[Math.floor(Math.random() * symbols.length)];
  pass += Math.floor(Math.random() * 90 + 10);
  $('newStuPassword').value = pass;
}

async function saveNewStudent(e) {
  e.preventDefault();
  const fullName = $('newStuFullName').value.trim();
  const username = $('newStuUsername').value.trim().toLowerCase();
  const email = $('newStuEmail').value.trim();
  const password = $('newStuPassword').value.trim();

  if (!fullName || !username || !password) return showToast('Fill all required fields.', 'error');
  if (username.length < 3) return showToast('Username must be at least 3 characters.', 'error');
  if (password.length < 6) return showToast('Password must be at least 6 characters.', 'error');
  if (!/^[a-z0-9._-]+$/.test(username)) return showToast('Username may only contain letters, numbers, dots, underscores, or hyphens.', 'error');

  const btn = $('studentRegSubmitBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';

  try {
    const res = await fetch('https://aerospace-portal.onrender.com/api/admin/create-student', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName, username, email, password })
    });
    const data = await res.json();

    if (data.success) {
      closeModal('studentRegModal');
      showCredentialsCard(data.student);
      if (adminTab === 'students') renderAdminStudents();
    } else {
      showToast(data.message || 'Failed to create student.', 'error');
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-user-plus"></i> Create Student';
    }
  } catch (err) {
    showToast('Server error.', 'error');
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-user-plus"></i> Create Student';
  }
}

function showCredentialsCard(student) {
  const card = $('credentialsCard');
  if (!card) return;

  card.innerHTML = `
    <div class="cred-row">
      <div class="cred-label"><i class="fas fa-id-card"></i> Full Name</div>
      <div class="cred-value-group">
        <span class="cred-value">${escapeHtml(student.fullName)}</span>
        <button type="button" class="cred-copy-btn" onclick="copyCredential('name', '${escapeHtml(student.fullName).replace(/'/g, "\\'")}')" title="Copy">
          <i class="fas fa-copy"></i>
        </button>
      </div>
    </div>
    <div class="cred-row">
      <div class="cred-label"><i class="fas fa-at"></i> Username</div>
      <div class="cred-value-group">
        <span class="cred-value cred-code">${escapeHtml(student.username)}</span>
        <button type="button" class="cred-copy-btn" onclick="copyCredential('username', '${escapeHtml(student.username)}')" title="Copy">
          <i class="fas fa-copy"></i>
        </button>
      </div>
    </div>
    <div class="cred-row">
      <div class="cred-label"><i class="fas fa-key"></i> Password</div>
      <div class="cred-value-group">
        <span class="cred-value cred-code">${escapeHtml(student.password)}</span>
        <button type="button" class="cred-copy-btn" onclick="copyCredential('password', '${escapeHtml(student.password)}')" title="Copy">
          <i class="fas fa-copy"></i>
        </button>
      </div>
    </div>
    ${student.email ? `
    <div class="cred-row">
      <div class="cred-label"><i class="fas fa-envelope"></i> Email</div>
      <div class="cred-value-group">
        <span class="cred-value">${escapeHtml(student.email)}</span>
        <button type="button" class="cred-copy-btn" onclick="copyCredential('email', '${escapeHtml(student.email)}')" title="Copy">
          <i class="fas fa-copy"></i>
        </button>
      </div>
    </div>` : ''}
  `;

  window.__lastCreatedStudent = student;
  openModal('credentialsModal');
}

async function copyCredential(field, value) {
  const ok = await copyToClipboard(value);
  if (ok) showToast(`✓ ${field.charAt(0).toUpperCase() + field.slice(1)} copied!`, 'success');
  else showToast('Copy failed. Please copy manually.', 'error');
}

async function copyAllCredentials() {
  const s = window.__lastCreatedStudent;
  if (!s) return;
  const text = [
    '🎓 Aerospace Department — Login Credentials',
    '',
    `Name: ${s.fullName}`,
    `Username: ${s.username}`,
    `Password: ${s.password}`,
    s.email ? `Email: ${s.email}` : '',
    '',
    'Login at: https://krishyadav7.github.io/aerospace-portal/',
    'Please change your password after first login.'
  ].filter(Boolean).join('\n');

  const ok = await copyToClipboard(text);
  if (ok) showToast('✓ Full credentials copied!', 'success');
  else showToast('Copy failed.', 'error');
}

/* ============================================================
   NOTIFICATIONS (RESTORED — this was missing!)
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
        method: 'POST', headers: { 'Content-Type': 'application/json' },
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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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
  } catch { showToast('Server error.', 'error'); }
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
   NAVIGATION
   ============================================================ */
function navigateStudent(dest) {
  currentCourseId = null; window.currentSelectedCourseId = null; editingCourseId = null;
  currentMaterialFilter = 'all';
  const path = dest === 'courses' ? '#/courses' : dest === 'saved' ? '#/saved' : '#/home';
  pushHash(path); studentNav = dest; renderApp();
}
function viewCourseDetail(courseId) {
  currentCourseId = courseId; window.currentSelectedCourseId = courseId;
  editingCourseId = null;
  currentMaterialFilter = 'all';
  pushHash(`#/course/${courseId}`); renderApp();
}
function goBackFromDetail() {
  if (history.length > 1) history.back();
  else { currentCourseId = null; window.currentSelectedCourseId = null; pushHash('#/home'); renderApp(); }
}
function setMaterialFilter(type) {
  currentMaterialFilter = type;
  if (window.currentSelectedCourseId) renderCourseDetail(window.currentSelectedCourseId);
}

/* ============================================================
   RENDER APP
   ============================================================ */
function renderApp() {
  ['loginView', 'adminView', 'adminEditView', 'studentHomeView', 'studentCoursesView', 'studentSavedView', 'courseDetailView']
    .forEach(id => { const el = $(id); if (el) el.classList.remove('active'); });
  $('appHeader').style.display = 'none';
  $('appFooter').style.display = 'none';

  if (!currentUser) { $('loginView').classList.add('active'); return; }

  $('appHeader').style.display = 'flex';
  $('appFooter').style.display = 'block';
  $('userDisplay').textContent = currentUser.username;
  $('roleBadge').textContent = currentUser.role === 'admin' ? 'Admin' : 'Student';
  $('roleBadge').className = 'role-badge ' + currentUser.role;

  const streakEl = $('streakBadge'); const streakNum = $('streakCount');
  if (streakEl && streakNum) {
    if (currentUser.role === 'student' && (currentUser.streakCount || 0) >= 2) {
      streakEl.style.display = 'inline-flex';
      streakNum.textContent = currentUser.streakCount;
      streakEl.title = `${currentUser.streakCount}-day streak! Best: ${currentUser.longestStreak || currentUser.streakCount}`;
    } else streakEl.style.display = 'none';
  }

  renderNotificationBadge();
  buildNav();

  if (editingCourseId && currentUser.role === 'admin') {
    $('adminEditView').classList.add('active');
    renderCourseEditor(editingCourseId);
    return;
  }
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
  if (studentNav === 'home') { $('studentHomeView').classList.add('active'); renderStudentHome(); }
  else if (studentNav === 'saved') { $('studentSavedView').classList.add('active'); renderSavedCourses(); }
  else { $('studentCoursesView').classList.add('active'); renderStudentCourses(); }
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
    <a href="#" class="${homeActive}" onclick="event.preventDefault();navigateStudent('home')"><i class="fas fa-house"></i> Home</a>
    <a href="#" class="${coursesActive}" onclick="event.preventDefault();navigateStudent('courses')"><i class="fas fa-graduation-cap"></i> Courses</a>
    <a href="#" class="${savedActive}" onclick="event.preventDefault();navigateStudent('saved')"><i class="fas fa-bookmark"></i> Saved${savedCount > 0 ? ' <span class="nav-count">' + savedCount + '</span>' : ''}</a>
  `;
}

/* ============================================================
   ADMIN DASHBOARD — STRICT TAB ISOLATION
   ============================================================ */
function switchAdminTab(tab) {
  adminTab = tab;
  pushHash(`#/admin/${tab}`);
  updateAdminTabUI();
  renderAdminDashboard();
}

function updateAdminTabUI() {
  document.querySelectorAll('.admin-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === adminTab));

  document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
  const contentId = `adminTab${adminTab.charAt(0).toUpperCase() + adminTab.slice(1)}`;
  const content = document.getElementById(contentId);
  if (content) content.classList.add('active');

  const titleEl = $('adminPageTitle');
  const actionsEl = $('adminHeaderActions');
  const titleMap = {
    overview:   { icon: 'fa-tachometer-alt', text: 'Admin Dashboard' },
    courses:    { icon: 'fa-graduation-cap', text: 'Manage Courses' },
    professors: { icon: 'fa-user-tie',       text: 'Manage Professors' },
    students:   { icon: 'fa-user-graduate',  text: 'Manage Students' }
  };
  const actionsMap = {
    overview: `<button class="btn btn-outline" onclick="switchAdminTab('courses')"><i class="fas fa-arrow-right"></i> Go to Courses</button>`,
    courses: `
      <button class="btn btn-outline" onclick="switchAdminTab('overview')"><i class="fas fa-chart-pie"></i> <span class="btn-text">Overview</span></button>
      <button class="btn btn-success" onclick="openAddCourseModal()"><i class="fas fa-plus-circle"></i> <span class="btn-text">New Course</span></button>`,
    professors: `
      <button class="btn btn-outline" onclick="switchAdminTab('overview')"><i class="fas fa-chart-pie"></i> <span class="btn-text">Overview</span></button>
      <button class="btn btn-success" onclick="openAddProfessorModal()"><i class="fas fa-user-plus"></i> <span class="btn-text">Add Professor</span></button>`,
    students: `
      <button class="btn btn-outline" onclick="switchAdminTab('overview')"><i class="fas fa-chart-pie"></i> <span class="btn-text">Overview</span></button>
      <button class="btn btn-success" onclick="openStudentRegModal()"><i class="fas fa-user-plus"></i> <span class="btn-text">Register Student</span></button>`
  };
  const meta = titleMap[adminTab] || titleMap.overview;
  if (titleEl) titleEl.innerHTML = `<i class="fas ${meta.icon}"></i> ${meta.text}`;
  if (actionsEl) actionsEl.innerHTML = actionsMap[adminTab] || '';
}

function renderAdminDashboard() {
  updateAdminTabUI();
  if (adminTab === 'overview') renderAdminOverview();
  else if (adminTab === 'courses') renderAdminCourses();
  else if (adminTab === 'professors') renderAdminProfessors();
  else if (adminTab === 'students') renderAdminStudents();
}

async function renderAdminOverview() {
  const courses = getCourses();
  const professors = getProfessors();

  $('statCourses').textContent = courses.length;
  $('statMaterials').textContent = courses.reduce((s, c) => s + (c.materials ? c.materials.length : 0), 0);
  $('statProfessors').textContent = professors.length;
  $('statStudents').textContent = '...';

  try {
    const res = await fetch('https://aerospace-portal.onrender.com/api/students');
    const data = await res.json();
    if (data.success) $('statStudents').textContent = data.students.length;
  } catch { $('statStudents').textContent = '—'; }
}

async function renderAdminCourses() {
  const courses = getCourses();
  const searchTerm = ($('adminCourseSearch')?.value || '').toLowerCase().trim();
  const filtered = courses.filter(c =>
    c.name.toLowerCase().includes(searchTerm) ||
    (c.code && c.code.toLowerCase().includes(searchTerm))
  );

  if (filtered.length === 0) {
    $('adminCourseList').innerHTML = `<div class="empty-state"><i class="fas fa-graduation-cap"></i><p>No courses found. Create your first course above.</p></div>`;
    return;
  }

  let html = `<div class="course-grid">`;
  filtered.forEach(c => {
    const matCount = (c.materials || []).length;
    const statusBadge = c.status === 'draft' ? '<span class="status-badge draft">DRAFT</span>'
                     : c.status === 'archived' ? '<span class="status-badge archived">ARCHIVED</span>' : '';
    const featuredBadge = c.featured ? '<span class="status-badge featured"><i class="fas fa-star"></i></span>' : '';
    const premiumLabel = c.isPremium ? `<span class="premium-badge"><i class="fas fa-crown"></i> Premium</span>` : '';

    const pendingDoubts = (c.doubts || []).filter(d => {
      const hasLegacy = d.answer && d.answer.trim();
      const hasReply = d.replies && d.replies.length > 0;
      return !hasLegacy && !hasReply;
    }).length;

    const alertHtml = pendingDoubts > 0 ? `
      <div class="admin-alert">
        <span><i class="fas fa-bell"></i> ${pendingDoubts} Pending</span>
        <button onclick="event.stopPropagation(); currentMaterialFilter='qa'; viewCourseDetail('${c.id}');">
          Reply <i class="fas fa-arrow-right"></i>
        </button>
      </div>` : '';

    const thumbHtml = c.thumbnail ? `<div class="course-thumb"><img src="${c.thumbnail}" alt=""></div>` : '';

    html += `
      <div class="course-card ${c.thumbnail ? 'has-thumb' : ''}" style="${accentStyle(c.code || c.name)}">
        ${thumbHtml}
        <button class="delete-course-btn" onclick="event.stopPropagation();deleteCourse('${c.id}')" title="Delete"><i class="fas fa-trash-alt"></i></button>
        <div class="course-code">${escapeHtml(c.code) || 'N/A'} ${premiumLabel} ${statusBadge} ${featuredBadge}</div>
        <h3>${escapeHtml(c.name)}</h3>
        ${alertHtml}
        <div class="course-meta">
          <span><i class="fas fa-user"></i> ${escapeHtml(c.instructor) || '—'}</span>
          <span><i class="fas fa-calendar-alt"></i> ${escapeHtml(c.semester) || '—'}</span>
          ${c.category ? `<span><i class="fas fa-tag"></i> ${escapeHtml(c.category)}</span>` : ''}
        </div>
        <div class="material-count"><i class="fas fa-layer-group"></i> ${matCount} materials</div>
        <div class="card-actions">
          <button class="btn btn-warning btn-sm" onclick="event.stopPropagation();openCourseEditor('${c.id}')"><i class="fas fa-edit"></i> Edit</button>
          <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();viewCourseDetail('${c.id}')"><i class="fas fa-eye"></i> View</button>
          <button class="btn btn-success btn-sm" onclick="event.stopPropagation();openAddMaterialModal('${c.id}')"><i class="fas fa-plus"></i> Material</button>
        </div>
      </div>
    `;
  });
  html += `</div>`;
  $('adminCourseList').innerHTML = html;
}

function renderAdminProfessors() {
  const professors = getProfessors();
  const countEl = $('professorCountLabel');
  if (countEl) countEl.textContent = `${professors.length} member${professors.length === 1 ? '' : 's'}`;

  if (professors.length === 0) {
    $('adminProfessorList').innerHTML = `
      <div class="empty-state">
        <i class="fas fa-user-tie"></i>
        <p>No professors added yet.</p>
        <button class="btn btn-success" style="margin-top:16px;" onclick="openAddProfessorModal()">
          <i class="fas fa-user-plus"></i> Add First Professor
        </button>
      </div>`;
    return;
  }

  let html = `<div class="admin-professor-grid">`;
  professors.forEach(p => {
    const photoHtml = p.photo
      ? `<img src="${p.photo}" alt="${escapeHtml(p.name)}">`
      : `<div class="avatar-placeholder"><i class="fas fa-user-tie"></i></div>`;

    html += `
      <div class="admin-professor-item">
        ${photoHtml}
        <div class="info">
          <h4>${escapeHtml(p.name)}</h4>
          <div class="title">${escapeHtml(p.title)}</div>
          <div class="desc">${escapeHtml(p.description) || ''}</div>
        </div>
        <div class="actions">
          <button class="btn btn-danger btn-sm" onclick="deleteProfessor('${p.id}')" title="Delete">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>`;
  });
  html += `</div>`;
  $('adminProfessorList').innerHTML = html;
}

async function renderAdminStudents() {
  const container = $('adminStudentList');
  if (!container) return;
  container.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>Loading students...</p></div>`;

  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/students');
    const data = await response.json();
    const countEl = $('studentCountLabel');

    if (data.success) {
      if (countEl) countEl.textContent = `${data.students.length} student${data.students.length === 1 ? '' : 's'}`;

      if (data.students.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <i class="fas fa-user-graduate"></i>
            <p>No students registered yet.</p>
            <button class="btn btn-success" style="margin-top:16px;" onclick="openStudentRegModal()">
              <i class="fas fa-user-plus"></i> Register First Student
            </button>
          </div>`;
        return;
      }

      let html = `<div class="student-grid">`;
      data.students.forEach(s => {
        const initials = (s.fullName || s.username || '?')
          .split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
        const created = s.createdAt ? new Date(s.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

        html += `
          <div class="student-card">
            <div class="student-card-header">
              <div class="student-avatar">${initials}</div>
              <div class="student-card-info">
                <h4>${escapeHtml(s.fullName || s.username)}</h4>
                <div class="student-username">@${escapeHtml(s.username)}</div>
              </div>
            </div>
            <div class="student-card-body">
              <div class="student-meta-row">
                <i class="fas fa-envelope"></i>
                <span>${s.email ? escapeHtml(s.email) : '<em style="color:var(--text-tertiary);">No email</em>'}</span>
              </div>
              <div class="student-meta-row">
                <i class="fas fa-calendar-plus"></i>
                <span>Joined ${created}</span>
              </div>
            </div>
            <div class="student-card-actions">
              <button class="btn btn-outline btn-sm" onclick="resetStudentPassword('${s._id}', '${escapeHtml(s.fullName || s.username).replace(/'/g, "\\'")}')">
                <i class="fas fa-key"></i> Reset Password
              </button>
              <button class="btn btn-danger btn-sm" onclick="deleteStudent('${s._id}', '${escapeHtml(s.fullName || s.username).replace(/'/g, "\\'")}')">
                <i class="fas fa-trash"></i>
              </button>
            </div>
          </div>`;
      });
      html += `</div>`;
      container.innerHTML = html;
    }
  } catch {
    container.innerHTML = `<div class="empty-state"><p style="color:var(--rose-500);">Error loading students.</p></div>`;
  }
}

async function resetStudentPassword(userId, name) {
  const newPass = prompt(`Enter new password for ${name} (min 6 characters):`);
  if (!newPass || newPass.length < 6) {
    if (newPass !== null) showToast('Password must be at least 6 characters.', 'error');
    return;
  }
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/admin/reset-password/${userId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: newPass })
    });
    const data = await res.json();
    if (data.success) {
      showCredentialsCard({
        fullName: name,
        username: '(unchanged)',
        password: newPass,
        email: ''
      });
      showToast('✓ Password reset!', 'success');
    } else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

async function deleteStudent(userId, name) {
  if (!confirm(`Delete student "${name}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/admin/students/${userId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('🗑️ Student deleted.', 'info');
      renderAdminStudents();
    } else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

/* ============================================================
   COURSE EDITOR
   ============================================================ */
function openCourseEditor(courseId) {
  editingCourseId = courseId;
  editingTab = 'details';
  currentCourseId = null;
  window.currentSelectedCourseId = null;
  pushHash(`#/admin/edit/${courseId}`);
  renderApp();
}
function closeCourseEditor() {
  editingCourseId = null;
  editingTab = 'details';
  pushHash('#/admin/courses');
  renderApp();
}
function switchEditorTab(tab) { editingTab = tab; renderCourseEditor(editingCourseId); }

function renderCourseEditor(courseId) {
  const course = findCourse(courseId);
  if (!course) {
    $('courseEditorContent').innerHTML = `<div class="empty-state"><p>Course not found.</p></div>`;
    return;
  }

  const acc = accentStyle(course.code || course.name);
  const statusChip = course.status === 'draft' ? '<span class="status-badge draft">DRAFT</span>'
                   : course.status === 'archived' ? '<span class="status-badge archived">ARCHIVED</span>'
                   : '<span class="status-badge published">PUBLISHED</span>';
  const featuredChip = course.featured ? '<span class="status-badge featured"><i class="fas fa-star"></i> FEATURED</span>' : '';
  const premiumChip = course.isPremium ? '<span class="premium-badge"><i class="fas fa-crown"></i> Premium</span>' : '';

  let html = `
    <div class="editor-hero" style="${acc}">
      <div class="editor-hero-left">
        <div class="editor-breadcrumb">
          <span class="course-code">${escapeHtml(course.code) || 'N/A'}</span>
          ${premiumChip} ${statusChip} ${featuredChip}
        </div>
        <h2>${escapeHtml(course.name)}</h2>
        <div class="editor-meta">
          <span><i class="fas fa-user"></i> ${escapeHtml(course.instructor) || '—'}</span>
          <span><i class="fas fa-tag"></i> ${escapeHtml(course.category) || 'General'}</span>
          <span><i class="fas fa-signal"></i> ${escapeHtml(course.difficulty) || 'Intermediate'}</span>
          <span><i class="fas fa-clock"></i> ${escapeHtml(course.duration) || 'Not set'}</span>
          <span><i class="fas fa-layer-group"></i> ${(course.materials || []).length} materials</span>
        </div>
      </div>
      <div class="editor-hero-right">
        <button class="btn btn-outline btn-sm" onclick="viewCourseDetail('${course.id}')">
          <i class="fas fa-eye"></i> Preview
        </button>
      </div>
    </div>
    <div class="editor-tabs">
      <button class="editor-tab ${editingTab === 'details' ? 'active' : ''}" onclick="switchEditorTab('details')">
        <i class="fas fa-info-circle"></i> Details
      </button>
      <button class="editor-tab ${editingTab === 'materials' ? 'active' : ''}" onclick="switchEditorTab('materials')">
        <i class="fas fa-layer-group"></i> Materials (${(course.materials || []).length})
      </button>
      <button class="editor-tab ${editingTab === 'announcements' ? 'active' : ''}" onclick="switchEditorTab('announcements')">
        <i class="fas fa-bullhorn"></i> Announcements (${(course.announcements || []).length})
      </button>
    </div>
    <div class="editor-body">
  `;
  if (editingTab === 'details') html += renderEditorDetails(course);
  else if (editingTab === 'materials') html += renderEditorMaterials(course);
  else if (editingTab === 'announcements') html += renderEditorAnnouncements(course);
  html += `</div>`;
  $('courseEditorContent').innerHTML = html;
}

function renderEditorDetails(course) {
  const outcomes = (course.learningOutcomes || []).join('\n');
  return `
    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-info-circle"></i> Basic Information</h3>
      <div class="editor-grid-2">
        <div class="form-group"><label>Course Name *</label><input type="text" id="edName" value="${escapeHtml(course.name)}"></div>
        <div class="form-group"><label>Course Code *</label><input type="text" id="edCode" value="${escapeHtml(course.code)}"></div>
        <div class="form-group"><label>Semester</label><input type="text" id="edSemester" value="${escapeHtml(course.semester) || ''}"></div>
        <div class="form-group"><label>Instructor</label><input type="text" id="edInstructor" value="${escapeHtml(course.instructor) || ''}"></div>
      </div>
      <div class="form-group"><label>Description</label>
        <textarea id="edDescription" rows="4">${escapeHtml(course.description) || ''}</textarea>
      </div>
    </div>
    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-layer-group"></i> Classification</h3>
      <div class="editor-grid-3">
        <div class="form-group"><label>Category</label>
          <select id="edCategory">
            ${['Aerodynamics','Propulsion','Structures','Avionics','Mathematics','General'].map(c => `<option value="${c}" ${course.category === c ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label>Difficulty</label>
          <select id="edDifficulty">
            ${['Beginner','Intermediate','Advanced'].map(c => `<option value="${c}" ${course.difficulty === c ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label>Duration</label>
          <input type="text" id="edDuration" value="${escapeHtml(course.duration) || ''}" placeholder="e.g. 12 hours">
        </div>
      </div>
    </div>
    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-bullseye"></i> Learning Outcomes</h3>
      <p class="editor-hint">One outcome per line.</p>
      <textarea id="edOutcomes" rows="5" placeholder="Understand aerodynamic principles&#10;Apply Bernoulli's equation...">${escapeHtml(outcomes)}</textarea>
    </div>
    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-cog"></i> Status & Visibility</h3>
      <div class="editor-grid-3">
        <div class="form-group"><label>Status</label>
          <select id="edStatus">
            <option value="published" ${course.status === 'published' ? 'selected' : ''}>✅ Published</option>
            <option value="draft" ${course.status === 'draft' ? 'selected' : ''}>📝 Draft</option>
            <option value="archived" ${course.status === 'archived' ? 'selected' : ''}>📦 Archived</option>
          </select>
        </div>
        <div class="form-group"><label>Featured</label>
          <label class="toggle-box" style="margin-top:6px;">
            <input type="checkbox" id="edFeatured" ${course.featured ? 'checked' : ''}>
            <span><i class="fas fa-star"></i> Featured</span>
          </label>
        </div>
        <div class="form-group"><label>Monetization</label>
          <label class="toggle-box" style="margin-top:6px;">
            <input type="checkbox" id="edIsPremium" ${course.isPremium ? 'checked' : ''}>
            <span><i class="fas fa-crown"></i> Premium</span>
          </label>
        </div>
      </div>
      <div class="form-group"><label>Price (₹)</label>
        <input type="number" id="edPrice" value="${course.price || 0}" min="0" step="1">
      </div>
    </div>
    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-image"></i> Thumbnail</h3>
      <div class="thumbnail-editor">
        ${course.thumbnail ? `<img src="${course.thumbnail}" class="thumbnail-preview" alt="">` : '<div class="thumbnail-preview-empty"><i class="fas fa-image"></i><span>No thumbnail</span></div>'}
        <div class="thumbnail-actions">
          <input type="file" id="edThumbnailFile" accept="image/*" style="display:none;" onchange="handleThumbnailUpload(this)">
          <button class="btn btn-outline btn-sm" onclick="document.getElementById('edThumbnailFile').click()"><i class="fas fa-upload"></i> Upload</button>
          ${course.thumbnail ? `<button class="btn btn-outline btn-sm" onclick="removeThumbnail()"><i class="fas fa-times"></i> Remove</button>` : ''}
        </div>
      </div>
    </div>
    <div class="editor-footer">
      <div class="editor-footer-left"><span class="editor-hint"><i class="fas fa-info-circle"></i> Saved to database immediately.</span></div>
      <div class="editor-footer-right">
        <button class="btn btn-outline" onclick="renderCourseEditor('${course.id}')">Reset</button>
        <button class="btn btn-primary btn-lg" onclick="saveCourseDetails('${course.id}')"><i class="fas fa-save"></i> Save Changes</button>
      </div>
    </div>
  `;
}

function renderEditorMaterials(course) {
  let html = `
    <div class="editor-section">
      <div class="editor-section-header">
        <h3 class="editor-section-title"><i class="fas fa-layer-group"></i> Materials (${(course.materials || []).length})</h3>
        <button class="btn btn-success" onclick="addNewMaterial('${course.id}')"><i class="fas fa-plus"></i> Add Material</button>
      </div>
      <p class="editor-hint">Click any material to expand and edit.</p>
    </div>
  `;
  if (!course.materials || course.materials.length === 0) {
    html += `<div class="empty-state"><i class="fas fa-layer-group"></i><p>No materials yet.</p></div>`;
    return html;
  }
  course.materials.forEach((m, idx) => { html += renderMaterialEditorCard(course.id, m, idx); });
  return html;
}

function renderMaterialEditorCard(courseId, m, idx) {
  const quizCount = (m.quiz || []).length;
  return `
    <details class="material-editor" data-mat-id="${m.id}">
      <summary>
        <div class="me-summary-left">
          <span class="me-index">#${idx + 1}</span>
          <span class="mat-type ${m.type}">${m.type.toUpperCase()}</span>
          <strong>${escapeHtml(m.title)}</strong>
          ${m.isPremium ? `<span class="mat-badge premium"><i class="fas fa-crown"></i> PRO</span>` : '<span class="mat-badge free">FREE</span>'}
          ${quizCount > 0 ? `<span class="mat-quiz-badge"><i class="fas fa-question-circle"></i> ${quizCount}</span>` : ''}
        </div>
        <div class="me-summary-right"><i class="fas fa-chevron-down me-chevron"></i></div>
      </summary>
      <div class="me-body">
        <div class="editor-grid-2">
          <div class="form-group"><label>Title</label><input type="text" class="me-title" value="${escapeHtml(m.title)}"></div>
          <div class="form-group"><label>Type</label>
            <select class="me-type">
              <option value="video" ${m.type === 'video' ? 'selected' : ''}>🎬 Video</option>
              <option value="pyq" ${m.type === 'pyq' ? 'selected' : ''}>📄 PYQ</option>
              <option value="tutorial" ${m.type === 'tutorial' ? 'selected' : ''}>📝 Tutorial</option>
              <option value="slides" ${m.type === 'slides' ? 'selected' : ''}>📊 Slides</option>
              <option value="other" ${m.type === 'other' ? 'selected' : ''}>📁 Other</option>
            </select>
          </div>
        </div>
        <div class="form-group"><label>Description</label><textarea class="me-desc" rows="2">${escapeHtml(m.description) || ''}</textarea></div>
        <div class="form-group"><label>Link</label><input type="url" class="me-url" value="${escapeHtml(m.url) || ''}"></div>
        <div class="editor-grid-2">
          <div class="form-group"><label>Access</label>
            <label class="toggle-box pro" style="margin-top:6px;">
              <input type="checkbox" class="me-premium" ${m.isPremium ? 'checked' : ''}>
              <span><i class="fas fa-crown"></i> PRO Material</span>
            </label>
          </div>
          <div class="form-group"><label>Price (₹)</label><input type="number" class="me-price" value="${m.price || 0}" min="0" step="1"></div>
        </div>
        <div class="me-file-section">
          <label>File</label>
          ${m.fileName ? `<div class="me-file-info"><i class="fas fa-paperclip"></i> ${escapeHtml(m.fileName)} <button class="btn btn-outline btn-sm" onclick="replaceMaterialFile('${courseId}', '${m.id}')"><i class="fas fa-sync"></i> Replace</button></div>`
                        : `<div class="me-file-info empty"><i class="fas fa-file"></i> No file <button class="btn btn-outline btn-sm" onclick="replaceMaterialFile('${courseId}', '${m.id}')"><i class="fas fa-upload"></i> Upload</button></div>`}
          <input type="file" class="me-file-input" style="display:none;" onchange="handleNewMaterialFile(this, '${courseId}', '${m.id}')">
        </div>
        <div class="me-quiz-section">
          <div class="me-quiz-header">
            <h4><i class="fas fa-question-circle"></i> Quiz (${quizCount})</h4>
            <button class="btn btn-accent btn-sm" onclick="openQuizModal('${courseId}', '${m.id}')"><i class="fas fa-pen"></i> ${quizCount > 0 ? 'Edit' : 'Add Quiz'}</button>
          </div>
        </div>
        <div class="me-actions">
          <button class="btn btn-danger btn-sm" onclick="deleteMaterialFromEditor('${courseId}', '${m.id}', '${escapeHtml(m.title).replace(/'/g, "\\'")}')"><i class="fas fa-trash"></i> Delete</button>
          <button class="btn btn-primary" onclick="saveMaterialInline('${courseId}', '${m.id}')"><i class="fas fa-save"></i> Save Material</button>
        </div>
      </div>
    </details>
  `;
}

function renderEditorAnnouncements(course) {
  const anns = (course.announcements || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  let html = `
    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-bullhorn"></i> Post Announcement</h3>
      <div class="form-group"><label>Title *</label><input type="text" id="annTitle" placeholder="e.g. Exam schedule update"></div>
      <div class="form-group"><label>Message</label><textarea id="annBody" rows="4" placeholder="Write your announcement..."></textarea></div>
      <button class="btn btn-primary" onclick="postAnnouncement('${course.id}')"><i class="fas fa-paper-plane"></i> Post</button>
    </div>
    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-list"></i> Posted (${anns.length})</h3>
  `;
  if (anns.length === 0) html += `<div class="empty-state" style="padding:30px;"><i class="fas fa-bullhorn"></i><p>No announcements yet.</p></div>`;
  else {
    html += `<div class="ann-list">`;
    anns.forEach(a => {
      const d = new Date(a.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      html += `<div class="ann-card">
        <div class="ann-card-head">
          <div><strong>${escapeHtml(a.title)}</strong><span class="ann-meta">by ${escapeHtml(a.authorName)} · ${d}</span></div>
          <button class="ann-delete" onclick="deleteAnnouncement('${course.id}', '${a.id}')"><i class="fas fa-trash-alt"></i></button>
        </div>
        ${a.body ? `<p class="ann-body">${escapeHtml(a.body)}</p>` : ''}
      </div>`;
    });
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

async function saveCourseDetails(courseId) {
  const name = $('edName').value.trim();
  const code = $('edCode').value.trim();
  if (!name || !code) return showToast('Name and code required.', 'error');
  const outcomesRaw = $('edOutcomes').value;
  const learningOutcomes = outcomesRaw.split('\n').map(l => l.trim()).filter(Boolean);
  const payload = {
    name, code,
    semester: $('edSemester').value.trim(),
    instructor: $('edInstructor').value.trim(),
    description: $('edDescription').value.trim(),
    category: $('edCategory').value,
    difficulty: $('edDifficulty').value,
    duration: $('edDuration').value.trim(),
    learningOutcomes,
    status: $('edStatus').value,
    featured: $('edFeatured').checked,
    isPremium: $('edIsPremium').checked,
    price: parseFloat($('edPrice').value) || 0
  };
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) { showToast('✅ Saved!', 'success'); await fetchCoursesFromDB(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

function handleThumbnailUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) return showToast('Image too large (max 2 MB).', 'error');
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${editingCourseId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thumbnail: e.target.result })
      });
      const data = await res.json();
      if (data.success) { showToast('✓ Thumbnail updated!', 'success'); await fetchCoursesFromDB(); }
    } catch { showToast('Upload failed.', 'error'); }
  };
  reader.readAsDataURL(file);
}

async function removeThumbnail() {
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${editingCourseId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thumbnail: '' })
    });
    const data = await res.json();
    if (data.success) { showToast('Thumbnail removed.', 'info'); await fetchCoursesFromDB(); }
  } catch { showToast('Failed.', 'error'); }
}

async function addNewMaterial(courseId) {
  const title = prompt('Material title:');
  if (!title || !title.trim()) return;
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/materials`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), type: 'video', description: '', url: '', isPremium: false, price: 0 })
    });
    const data = await res.json();
    if (data.success) { showToast('✓ Material added!', 'success'); await fetchCoursesFromDB(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

async function saveMaterialInline(courseId, materialId) {
  const el = document.querySelector(`.material-editor[data-mat-id="${materialId}"]`);
  if (!el) return;
  const payload = {
    title: el.querySelector('.me-title').value.trim(),
    type: el.querySelector('.me-type').value,
    description: el.querySelector('.me-desc').value.trim(),
    url: el.querySelector('.me-url').value.trim(),
    isPremium: el.querySelector('.me-premium').checked,
    price: parseFloat(el.querySelector('.me-price').value) || 0
  };
  if (!payload.title) return showToast('Title required.', 'error');
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/materials/${materialId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) { showToast('✓ Material saved!', 'success'); await fetchCoursesFromDB(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

async function deleteMaterialFromEditor(courseId, materialId, title) {
  if (!confirm(`Delete "${title}"?`)) return;
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/materials/${materialId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) { showToast('Deleted.', 'info'); await fetchCoursesFromDB(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

function replaceMaterialFile(courseId, materialId) {
  const el = document.querySelector(`.material-editor[data-mat-id="${materialId}"]`);
  if (el) el.querySelector('.me-file-input').click();
}

function handleNewMaterialFile(input, courseId, materialId) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) return showToast('File too large (max 10 MB).', 'error');
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/materials/${materialId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileData: e.target.result, fileName: file.name })
      });
      const data = await res.json();
      if (data.success) { showToast('✓ File replaced!', 'success'); await fetchCoursesFromDB(); }
    } catch { showToast('Upload failed.', 'error'); }
  };
  reader.readAsDataURL(file);
}

async function postAnnouncement(courseId) {
  const title = $('annTitle').value.trim();
  const body = $('annBody').value.trim();
  if (!title) return showToast('Title required.', 'error');
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/announcements`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, authorName: currentUser.fullName || currentUser.username || 'Instructor' })
    });
    const data = await res.json();
    if (data.success) { showToast('📢 Posted!', 'success'); await fetchCoursesFromDB(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

async function deleteAnnouncement(courseId, annId) {
  if (!confirm('Delete this announcement?')) return;
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/announcements/${annId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) { showToast('Deleted.', 'info'); await fetchCoursesFromDB(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
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
        : `<div class="professor-avatar avatar-placeholder-lg"><i class="fas fa-user-tie"></i></div>`;
      html += `<div class="professor-card">${photoHtml}<h3>${escapeHtml(p.name)}</h3><div class="prof-title">${escapeHtml(p.title)}</div><p>${escapeHtml(p.description) || ''}</p></div>`;
    });
    $('professorsGrid').innerHTML = html;
  }
}

function renderStreakCard() {
  const container = document.getElementById('streakCardContainer');
  if (!container) return;
  if (currentUser.role !== 'student') { container.innerHTML = ''; return; }
  const streak = currentUser.streakCount || 0;
  const longest = currentUser.longestStreak || 0;
  if (streak === 0 && longest === 0) { container.innerHTML = ''; return; }
  let message = ''; let icon = 'fa-fire'; let tone = 'warm';
  if (streak === 0) { message = `Welcome back! Best was ${longest} day${longest > 1 ? 's' : ''}.`; icon = 'fa-hourglass-start'; tone = 'cool'; }
  else if (streak < 3) message = `You're on a ${streak}-day streak. Keep going!`;
  else if (streak < 7) message = `🔥 ${streak} days strong!`;
  else if (streak < 30) message = `🚀 ${streak}-day streak!`;
  else message = `🏆 ${streak} days! Top tier.`;
  container.innerHTML = `
    <div class="streak-card ${tone}">
      <div class="streak-flame"><i class="fas ${icon}"></i></div>
      <div class="streak-info">
        <span class="streak-label">Daily Streak</span>
        <h3>${streak} day${streak === 1 ? '' : 's'}</h3>
        <p>${message}${longest > streak ? ` · Best: ${longest}` : ''}</p>
      </div>
    </div>`;
}

function renderContinueCard() {
  const container = document.getElementById('continueCardContainer');
  if (!container) return;
  const la = currentUser?.lastActivity;
  if (!la || !la.courseId || currentUser.role !== 'student') { container.innerHTML = ''; return; }
  const course = findCourse(la.courseId);
  if (!course) { container.innerHTML = ''; return; }
  const acc = accentStyle(course.code || course.name);
  const viewedCount = getProgress(course.id).length;
  const totalMats = (course.materials || []).length;
  container.innerHTML = `
    <div class="continue-card" style="${acc}">
      <div class="continue-icon"><i class="fas fa-play-circle"></i></div>
      <div class="continue-info">
        <span class="continue-label"><i class="fas fa-history"></i> Continue where you left off</span>
        <h3>${escapeHtml(course.name)}</h3>
        <p>${viewedCount} of ${totalMats} materials completed · ${timeAgo(la.timestamp)}</p>
      </div>
      <button class="btn btn-primary continue-btn" onclick="viewCourseDetail('${course.id}')"><i class="fas fa-play"></i> Resume</button>
    </div>`;
}

/* ============================================================
   STUDENT COURSES
   ============================================================ */
function clearCourseFilters() {
  const c = $('filterCategory'); const d = $('filterDifficulty'); const p = $('filterPrice');
  if (c) c.value = ''; if (d) d.value = ''; if (p) p.value = '';
  renderStudentCourses();
}

function renderStudentCourses() {
  const courses = getCourses().filter(c => c.status !== 'draft' && c.status !== 'archived');
  const searchTerm = ($('studentCourseSearch').value || '').toLowerCase().trim();
  const fCategory = ($('filterCategory')?.value || '').trim();
  const fDifficulty = ($('filterDifficulty')?.value || '').trim();
  const fPrice = ($('filterPrice')?.value || '').trim();

  const filtered = courses.filter(c => {
    if (searchTerm) {
      const hit = c.name.toLowerCase().includes(searchTerm) ||
                  (c.code && c.code.toLowerCase().includes(searchTerm)) ||
                  (c.instructor && c.instructor.toLowerCase().includes(searchTerm));
      if (!hit) return false;
    }
    if (fCategory && c.category !== fCategory) return false;
    if (fDifficulty && c.difficulty !== fDifficulty) return false;
    if (fPrice === 'free' && c.isPremium) return false;
    if (fPrice === 'premium' && !c.isPremium) return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (a.featured && !b.featured) return -1;
    if (!a.featured && b.featured) return 1;
    return a.name.localeCompare(b.name);
  });

  if (filtered.length === 0) {
    $('studentCourseList').innerHTML = `<div class="empty-state"><i class="fas fa-graduation-cap"></i><p>No courses match your filters.</p></div>`;
    return;
  }

  let html = `<div class="course-grid">`;
  filtered.forEach(c => { html += renderStudentCourseCard(c); });
  html += `</div>`;
  $('studentCourseList').innerHTML = html;
}

function renderStudentCourseCard(c) {
  const isPurchased = currentUser.purchases && currentUser.purchases.includes(c.id);
  const saved = isBookmarked(c.id);
  const viewedCount = getProgress(c.id).length;
  const totalMats = (c.materials || []).length;
  const pct = totalMats > 0 ? Math.round((viewedCount / totalMats) * 100) : 0;
  const diff = difficultyColor(c.difficulty);

  const progressHtml = totalMats > 0 ? `
    <div class="course-progress">
      <div class="course-progress-bar"><div style="width:${pct}%"></div></div>
      <span class="course-progress-text">${viewedCount}/${totalMats} completed</span>
    </div>` : '';

  const featuredBadge = c.featured ? '<span class="status-badge featured"><i class="fas fa-star"></i></span>' : '';
  let badge = c.isPremium
    ? `<span class="premium-badge"><i class="fas fa-crown"></i> Premium</span>${!isPurchased ? ` <span class="premium-badge premium-locked"><i class="fas fa-lock"></i> Locked</span>` : ''}`
    : '';

  const thumbHtml = c.thumbnail ? `<div class="course-thumb"><img src="${c.thumbnail}" alt=""></div>` : '';

  return `
    <div class="course-card ${c.thumbnail ? 'has-thumb' : ''}" style="${accentStyle(c.code || c.name)}" onclick="viewCourseDetail('${c.id}')">
      ${thumbHtml}
      <button class="bookmark-btn ${saved ? 'saved' : ''}" onclick="toggleBookmark(event, '${c.id}')" title="${saved ? 'Remove' : 'Save'}">
        <i class="fas fa-bookmark"></i>
      </button>
      <div class="course-code">${escapeHtml(c.code) || 'N/A'} ${featuredBadge} ${badge}</div>
      <h3>${escapeHtml(c.name)}</h3>
      <div class="course-meta">
        <span><i class="fas fa-user"></i> ${escapeHtml(c.instructor) || '—'}</span>
        ${c.category ? `<span><i class="fas fa-tag"></i> ${escapeHtml(c.category)}</span>` : ''}
      </div>
      <div class="course-chips">
        ${c.difficulty ? `<span class="chip" style="background:${diff.bg};color:${diff.fg};"><i class="fas fa-signal"></i> ${c.difficulty}</span>` : ''}
        ${c.duration ? `<span class="chip"><i class="fas fa-clock"></i> ${escapeHtml(c.duration)}</span>` : ''}
        ${c.isPremium ? `<span class="chip gold"><i class="fas fa-rupee-sign"></i> ${c.price || 0}</span>` : `<span class="chip green"><i class="fas fa-gift"></i> Free</span>`}
      </div>
      <p class="course-desc">${escapeHtml(c.description) || ''}</p>
      <div class="material-count"><i class="fas fa-layer-group"></i> ${totalMats} materials</div>
      ${progressHtml}
      ${c.isPremium && !isPurchased ? `<div style="margin-top:10px;"><button class="btn btn-primary btn-sm" onclick="event.stopPropagation();showPaymentModal('${c.id}')"><i class="fas fa-shopping-cart"></i> Buy Now</button></div>` : ''}
    </div>`;
}

function renderSavedCourses() {
  const container = $('studentSavedList');
  const savedIds = currentUser.bookmarks || [];
  if (savedIds.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <i class="fas fa-bookmark"></i>
      <p>You haven't saved any courses yet.</p>
      <p style="margin-top:8px;font-size:13px;">Tap the bookmark icon on any course to save it.</p>
      <button class="btn btn-primary" style="margin-top:16px;" onclick="navigateStudent('courses')"><i class="fas fa-graduation-cap"></i> Browse Courses</button>
    </div>`;
    return;
  }
  const courses = getCourses().filter(c => savedIds.includes(c.id));
  if (courses.length === 0) {
    container.innerHTML = `<div class="empty-state"><i class="fas fa-bookmark"></i><p>Saved courses are no longer available.</p></div>`;
    return;
  }
  let html = `<div class="course-grid">`;
  courses.forEach(c => { html += renderStudentCourseCard(c); });
  html += `</div>`;
  container.innerHTML = html;
}

/* ============================================================
   COURSE DETAIL
   ============================================================ */
function hasAnyAnswer(doubt) {
  if (doubt.answer && doubt.answer.trim()) return true;
  if (doubt.replies && doubt.replies.length > 0) return true;
  return false;
}

function renderCourseDetail(courseId) {
  const course = findCourse(courseId);
  if (!course) {
    $('courseDetailContent').innerHTML = `<div class="empty-state"><p>Course not found.</p></div>`;
    return;
  }
  const isPremiumCourse = course.isPremium || false;
  const isPurchased = currentUser && currentUser.purchases && currentUser.purchases.includes(course.id);
  const acc = accentStyle(course.code || course.name);
  const diff = difficultyColor(course.difficulty);

  let html = `
    <div class="course-detail-header" style="${acc}">
      ${course.thumbnail ? `<img src="${course.thumbnail}" class="cd-thumb" alt="">` : ''}
      <div class="cd-content">
        <h2>${escapeHtml(course.name)} ${isPremiumCourse ? '<span class="premium-badge"><i class="fas fa-crown"></i> Premium</span>' : ''}</h2>
        <div class="cd-chips">
          ${course.category ? `<span class="chip"><i class="fas fa-tag"></i> ${escapeHtml(course.category)}</span>` : ''}
          ${course.difficulty ? `<span class="chip" style="background:${diff.bg};color:${diff.fg};"><i class="fas fa-signal"></i> ${course.difficulty}</span>` : ''}
          ${course.duration ? `<span class="chip"><i class="fas fa-clock"></i> ${escapeHtml(course.duration)}</span>` : ''}
        </div>
        <div class="meta">
          <span><i class="fas fa-code"></i> ${escapeHtml(course.code) || 'N/A'}</span>
          <span><i class="fas fa-user"></i> ${escapeHtml(course.instructor) || '—'}</span>
          ${isPremiumCourse ? `<span><i class="fas fa-rupee-sign"></i> ${course.price || 0}</span>` : ''}
        </div>
        <p class="detail-desc">${escapeHtml(course.description) || ''}</p>
      </div>
    </div>
  `;

  if (course.learningOutcomes && course.learningOutcomes.length > 0) {
    html += `<div class="learning-outcomes">
      <h3><i class="fas fa-bullseye"></i> What you'll learn</h3>
      <ul>${course.learningOutcomes.map(o => `<li><i class="fas fa-check-circle"></i> ${escapeHtml(o)}</li>`).join('')}</ul>
    </div>`;
  }

  if (course.announcements && course.announcements.length > 0) {
    const sortedAnns = [...course.announcements].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 3);
    html += `<div class="course-announcements">
      <h3><i class="fas fa-bullhorn"></i> Announcements</h3>
      ${sortedAnns.map(a => {
        const d = new Date(a.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
        return `<div class="ann-card compact"><div class="ann-card-head"><div><strong>${escapeHtml(a.title)}</strong><span class="ann-meta">${d}</span></div></div>${a.body ? `<p class="ann-body">${escapeHtml(a.body)}</p>` : ''}</div>`;
      }).join('')}
    </div>`;
  }

  if (isPremiumCourse && currentUser.role === 'student' && !isPurchased) {
    html += `<div class="premium-notice">
      <div><i class="fas fa-info-circle"></i> Premium materials locked.</div>
      <button class="btn btn-warning btn-sm" onclick="showPaymentModal('${course.id}')"><i class="fas fa-shopping-cart"></i> Buy (₹${course.price})</button>
    </div>`;
  }

  if (currentUser.role === 'student') {
    const viewedCount = getProgress(course.id).length;
    const totalMats = (course.materials || []).length;
    const canAccess = !isPremiumCourse || isPurchased;
    if (canAccess && totalMats > 0 && viewedCount >= totalMats) {
      html += `<div class="cert-earned-banner">
        <div class="cert-earned-icon"><i class="fas fa-award"></i></div>
        <div class="cert-earned-info">
          <h4>🎉 Course Completed!</h4>
          <p>You've finished all ${totalMats} materials.</p>
        </div>
        <button class="btn btn-accent" onclick="generateCertificate('${course.id}')"><i class="fas fa-download"></i> Get Certificate</button>
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

  if (currentMaterialFilter === 'qa') {
    html += renderQASection(course);
    $('courseDetailContent').innerHTML = html;
    return;
  }

  if (filtered.length === 0) {
    html += `<div class="empty-state"><i class="fas fa-layer-group"></i><p>No content in this category.</p></div>`;
  } else {
    html += `<div class="material-list">`;
    filtered.forEach(m => { html += renderMaterialCard(course, m, isPurchased); });
    html += `</div>`;
  }

  $('courseDetailContent').innerHTML = html;
}

function renderMaterialCard(course, m, isPurchased) {
  const hasFile = m.fileData && m.fileData.length > 0;
  const hasUrl = m.url && m.url.length > 0;
  const isMatPremium = m.isPremium === true || m.isPremium === 'true';
  const matPrice = parseFloat(m.price) || 0;
  const isMatPurchased = currentUser && currentUser.purchases && currentUser.purchases.includes(m.id);
  const canAccess = (currentUser.role === 'admin') || isPurchased || isMatPurchased || !isMatPremium;
  const viewed = isMaterialViewed(course.id, m.id);
  const quizCount = (m.quiz || []).length;
  let fileActionHtml = '';
  if (!canAccess) {
    fileActionHtml = `<button class="btn btn-warning btn-sm" onclick="showPaymentModal('${course.id}', '${m.id}')"><i class="fas fa-lock"></i> Unlock ₹${matPrice}</button>`;
  } else {
    // Video → custom player (no download, custom controls)
    if (m.type === 'video' && hasUrl) {
      fileActionHtml += `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openMaterialVideo('${course.id}', '${m.id}')"><i class="fas fa-play"></i> Watch</button>`;
    } else if (hasUrl) {
      fileActionHtml += ` <a href="${escapeHtml(m.url)}" target="_blank" rel="noopener" class="btn btn-primary btn-sm"><i class="fas fa-external-link-alt"></i> Open Link</a>`;
    }

    // File → PDF viewer (or download for admins on non-PDFs)
    if (hasFile) {
      const isPdf = (m.fileName || '').toLowerCase().endsWith('.pdf') ||
                    String(m.fileData || '').startsWith('data:application/pdf');
      if (isPdf) {
        fileActionHtml += ` <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();viewFileOnline('${course.id}', '${m.id}')"><i class="fas fa-book-open"></i> Read</button>`;
      } else if (currentUser.role === 'admin') {
        fileActionHtml += ` <a href="${m.fileData}" download="${escapeHtml(m.fileName) || 'download'}" class="btn btn-outline btn-sm"><i class="fas fa-download"></i> Download</a>`;
      }
    }
  }

  let progressBtnHtml = '';
  if (currentUser.role === 'student' && canAccess) {
    progressBtnHtml = `<button class="btn ${viewed ? 'btn-success' : 'btn-outline'} btn-sm" onclick="event.stopPropagation();toggleMaterialViewed(event, '${course.id}', '${m.id}')">
      <i class="fas ${viewed ? 'fa-check-circle' : 'fa-circle'}"></i> ${viewed ? 'Completed' : 'Mark done'}
    </button>`;
    if (quizCount > 0) {
      const qr = (currentUser.quizResults || {})[m.id];
      const label = qr ? `Retake (${qr.score}/${qr.total})` : `Take Quiz (${quizCount})`;
      progressBtnHtml += ` <button class="btn btn-accent btn-sm" onclick="event.stopPropagation();openQuizPlayer('${course.id}', '${m.id}')"><i class="fas fa-question-circle"></i> ${label}</button>`;
    }
  }

  const badgeHtml = isMatPremium
    ? `<span class="mat-badge premium"><i class="fas fa-crown"></i> PRO (₹${matPrice})</span>`
    : `<span class="mat-badge free">FREE</span>`;

  const quizBadge = quizCount > 0 ? `<span class="mat-quiz-badge"><i class="fas fa-question-circle"></i> ${quizCount}</span>` : '';

  return `
    <div class="material-item ${!canAccess ? 'locked-mat' : ''}">
      <div class="mat-head">
        <div class="mat-type ${m.type}">${m.type.toUpperCase()}</div>
        ${badgeHtml}
        ${quizBadge}
      </div>
      <h4>${escapeHtml(m.title)}</h4>
      <div class="mat-desc">${escapeHtml(m.description) || ''}</div>
      <div class="mat-actions">${fileActionHtml}${progressBtnHtml}</div>
    </div>
  `;
}

function renderQASection(course) {
  const doubts = [...(course.doubts || [])];
  let html = `<div class="qa-section"><h3><i class="fas fa-comments"></i> Course Q&A / Doubts</h3>`;

  if (currentUser.role === 'student') {
    html += `<div class="qa-ask-box">
      <label>Ask a New Doubt</label>
      <textarea id="newDoubtText" placeholder="Type your doubt here..."></textarea>
      <button class="btn btn-primary" onclick="askDoubt('${course.id}')"><i class="fas fa-paper-plane"></i> Submit Doubt</button>
    </div>`;
  }

  if (doubts.length === 0) {
    html += `<div class="empty-state" style="padding:20px;"><i class="fas fa-check-circle"></i><p>No doubts asked yet.</p></div>`;
  } else {
    doubts.sort((a, b) => {
      const aHas = hasAnyAnswer(a); const bHas = hasAnyAnswer(b);
      if (!aHas && bHas) return -1;
      if (aHas && !bHas) return 1;
      return new Date(b.date) - new Date(a.date);
    });

    doubts.forEach(d => {
      const answered = hasAnyAnswer(d);
      const statusBadge = answered ? `<span class="qa-status solved">ANSWERED</span>` : `<span class="qa-status pending">OPEN</span>`;
      const dateText = d.date ? new Date(d.date).toLocaleDateString() : 'Recent';
      const emailText = d.studentEmail ? escapeHtml(d.studentEmail) : 'No Email';
      const usernameText = d.studentUsername ? `@${escapeHtml(d.studentUsername)}` : '';
      const isAsker = d.studentUsername === currentUser.username;
      const isAdmin = currentUser.role === 'admin';
      const canReply = isAdmin || currentUser.role === 'student';

      const replies = d.replies || [];
      let repliesHtml = '';
      if (replies.length > 0) {
        repliesHtml = `<div class="qa-replies">`;
        replies.forEach(r => {
          const rDate = r.date ? new Date(r.date).toLocaleDateString() : '';
          const isAdminReply = r.authorRole === 'admin';
          const canAccept = (isAsker || isAdmin) && !r.isAccepted;
          repliesHtml += `<div class="qa-reply ${isAdminReply ? 'admin-reply' : ''} ${r.isAccepted ? 'accepted' : ''}">
            <div class="qa-reply-head">
              <strong><i class="fas ${isAdminReply ? 'fa-user-shield' : 'fa-user-circle'}"></i> ${escapeHtml(r.authorName || r.authorUsername)}</strong>
              ${isAdminReply ? '<span class="qa-reply-tag">Instructor</span>' : ''}
              ${r.isAccepted ? '<span class="qa-reply-tag accepted-tag"><i class="fas fa-check-circle"></i> Accepted</span>' : ''}
              <span class="qa-reply-date">${rDate}</span>
            </div>
            <div class="qa-reply-text">${escapeHtml(r.text)}</div>
            ${canAccept ? `<button class="qa-accept-btn" onclick="acceptReply('${course.id}', '${d._id}', '${r._id}')"><i class="fas fa-check"></i> Accept</button>` : ''}
          </div>`;
        });
        repliesHtml += `</div>`;
      }

      const legacyAnswerHtml = (!replies.length && d.answer)
        ? `<div class="qa-answer"><i class="fas fa-chalkboard-teacher"></i> <strong>Admin:</strong> ${escapeHtml(d.answer)}</div>` : '';

      const replyFormHtml = canReply ? `
        <div class="qa-reply-form" id="replyForm-${d._id}">
          <textarea id="replyText-${d._id}" placeholder="${isAdmin ? 'Write an official answer...' : 'Share what you know...'}"></textarea>
          <button class="btn ${isAdmin ? 'btn-success' : 'btn-primary'} btn-sm" onclick="postReply('${course.id}', '${d._id}')">
            <i class="fas fa-reply"></i> ${isAdmin ? 'Post Answer' : 'Post Reply'}
          </button>
        </div>` : '';

      html += `<div class="qa-item ${answered ? 'solved' : 'pending'}">
        <div class="qa-head">
          <div>
            <strong><i class="fas fa-user-circle"></i> ${escapeHtml(d.studentName)} <span class="qa-username">${usernameText}</span></strong>
            ${isAdmin ? `<div class="qa-email"><i class="fas fa-envelope"></i> ${emailText}</div>` : ''}
          </div>
          <div>${statusBadge} <span class="qa-date">${dateText}</span></div>
        </div>
        <p class="qa-question"><strong>Q:</strong> ${escapeHtml(d.question)}</p>
        ${legacyAnswerHtml}
        ${repliesHtml}
        ${replyFormHtml}
      </div>`;
    });
  }
  html += `</div>`;
  return html;
}

/* ============================================================
   CERTIFICATE
   ============================================================ */
function generateCertificate(courseId) {
  const course = findCourse(courseId);
  if (!course) return;
  const viewedCount = getProgress(course.id).length;
  const totalMats = (course.materials || []).length;
  if (totalMats === 0 || viewedCount < totalMats) return showToast('Complete all materials first.', 'error');

  const studentName = currentUser.fullName || currentUser.username;
  const completionDate = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const certId = 'AERO-' + (course.code || 'CRS').toUpperCase().replace(/[^A-Z0-9]/g, '') + '-' + String(currentUser._id).slice(-4).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
  const acc = getCourseAccent(course.code || course.name);

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Certificate — ${escapeHtml(course.name)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;800;900&family=Playfair+Display:wght@700;800&display=swap" rel="stylesheet">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Inter',sans-serif;background:#f0f4f8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:30px 20px}
    .toolbar{position:fixed;top:20px;right:20px;z-index:100}
    .btn-print{padding:12px 22px;border:none;border-radius:10px;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;box-shadow:0 6px 18px rgba(79,70,229,.35)}
    .cert{position:relative;width:100%;max-width:1000px;aspect-ratio:1.414/1;background:#fff;box-shadow:0 20px 60px rgba(15,23,42,.15);overflow:hidden;border-radius:8px}
    .cert-inner{position:absolute;inset:20px;border:3px solid #0f172a;border-radius:6px;padding:40px 60px;display:flex;flex-direction:column;align-items:center;text-align:center;z-index:1}
    .cert-inner::before{content:"";position:absolute;inset:6px;border:1px solid #cbd5e1;border-radius:4px}
    .cert-logo{width:52px;height:52px;border-radius:12px;background:linear-gradient(135deg,${acc.from},${acc.to});display:flex;align-items:center;justify-content:center;font-size:26px;color:#fff}
    .cert-header{display:flex;align-items:center;gap:14px;margin-bottom:8px}
    .cert-dept{text-align:left}
    .cert-dept h1{font-size:20px;font-weight:800;color:#0f172a}
    .cert-dept span{font-size:12px;color:#64748b;letter-spacing:1px;text-transform:uppercase}
    .cert-title{font-family:'Playfair Display',serif;font-size:46px;font-weight:800;color:#0f172a;margin:22px 0 6px;line-height:1}
    .cert-subtitle{font-size:13px;color:#64748b;letter-spacing:3px;text-transform:uppercase;font-weight:600;margin-bottom:24px}
    .cert-presented{font-size:14px;color:#475569;margin-bottom:8px}
    .cert-name{font-family:'Playfair Display',serif;font-size:42px;font-weight:700;color:${acc.solid};margin:4px 0 14px;padding-bottom:8px;border-bottom:2px solid #e2e8f0;min-width:400px;display:inline-block}
    .cert-completed{font-size:14px;color:#475569;margin-bottom:10px}
    .cert-course{font-size:22px;font-weight:700;color:#0f172a;margin-bottom:4px}
    .cert-code{font-size:12px;color:#64748b;letter-spacing:2px;text-transform:uppercase;font-weight:600;margin-bottom:34px}
    .cert-footer{margin-top:auto;width:100%;display:flex;justify-content:space-between;align-items:flex-end;padding-top:20px;border-top:1px solid #e2e8f0}
    .cert-sign{text-align:center;min-width:180px}
    .cert-sign-line{font-family:'Playfair Display',serif;font-size:22px;font-style:italic;color:#0f172a;margin-bottom:4px;border-bottom:1.5px solid #cbd5e1;padding-bottom:4px}
    .cert-sign-role{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:1.5px;font-weight:600}
    .cert-meta{text-align:center;font-size:11px;color:#94a3b8}
    .cert-meta strong{color:#475569;font-family:'Courier New',monospace;font-size:12px}
    @page{size:A4 landscape;margin:0}
    @media print{body{background:#fff;padding:0}.toolbar{display:none!important}.cert{box-shadow:none;border-radius:0;width:100vw;height:100vh;max-width:none;aspect-ratio:auto}}
  </style></head><body>
  <div class="toolbar"><button class="btn-print" onclick="window.print()">🖨️ Print / Save as PDF</button></div>
  <div class="cert"><div class="cert-inner">
    <div class="cert-header"><div class="cert-logo">🚀</div><div class="cert-dept"><h1>Aerospace Department</h1><span>IIT Kharagpur</span></div></div>
    <div class="cert-title">Certificate</div>
    <div class="cert-subtitle">of Completion</div>
    <div class="cert-presented">This certificate is proudly presented to</div>
    <div class="cert-name">${escapeHtml(studentName)}</div>
    <div class="cert-completed">for successfully completing</div>
    <div class="cert-course">${escapeHtml(course.name)}</div>
    <div class="cert-code">${escapeHtml(course.code) || ''} · Completed on ${completionDate}</div>
    <div class="cert-footer">
      <div class="cert-meta">Certificate ID<br><strong>${certId}</strong></div>
      <div class="cert-sign"><div class="cert-sign-line">Krish Yadav</div><div class="cert-sign-role">Course Director</div></div>
    </div>
  </div></div></body></html>`;

  const win = window.open('', '_blank');
  if (!win) return showToast('Please allow popups.', 'error');
  win.document.write(html); win.document.close();
  showToast('🎓 Certificate generated!', 'success');
}

/* ============================================================
   QUIZ
   ============================================================ */
let quizDraft = [];
function openQuizModal(courseId, materialId) {
  const modal = document.getElementById('quizModal');
  if (!modal) return showToast('Quiz modal missing.', 'error');
  const course = findCourse(courseId);
  if (!course) return;
  const mat = course.materials.find(m => m.id === materialId);
  if (!mat) return;
  $('quizCourseId').value = courseId;
  $('quizMaterialId').value = materialId;
  quizDraft = JSON.parse(JSON.stringify(mat.quiz || []));
  renderQuizDraft();
  openModal('quizModal');
}

function renderQuizDraft() {
  const list = document.getElementById('quizQuestionsList');
  if (!list) return;
  if (quizDraft.length === 0) {
    list.innerHTML = `<div class="empty-state" style="padding:20px;margin-bottom:14px;"><i class="fas fa-question-circle"></i><p>No questions yet.</p></div>`;
    return;
  }
  let html = '';
  quizDraft.forEach((q, qi) => {
    html += `<div class="quiz-edit-card">
      <div class="quiz-edit-head"><strong>Question ${qi + 1}</strong>
        <button type="button" class="quiz-remove" onclick="removeQuizQuestion(${qi})"><i class="fas fa-trash-alt"></i></button>
      </div>
      <div class="form-group" style="margin-bottom:10px;">
        <input type="text" placeholder="Question text" value="${escapeHtml(q.question)}" oninput="updateQuizField(${qi}, 'question', this.value)">
      </div>
      <div class="quiz-options">
        ${(q.options || ['', '', '', '']).map((opt, oi) => `
          <div class="quiz-option-row">
            <label class="quiz-radio"><input type="radio" name="correct-${qi}" ${q.correctIndex === oi ? 'checked' : ''} onchange="updateQuizCorrect(${qi}, ${oi})"><span class="quiz-radio-dot"></span></label>
            <input type="text" placeholder="Option ${oi + 1}" value="${escapeHtml(opt)}" oninput="updateQuizOption(${qi}, ${oi}, this.value)">
          </div>`).join('')}
      </div>
      <div class="form-group" style="margin:10px 0 0;">
        <input type="text" placeholder="Explanation (optional)" value="${escapeHtml(q.explanation || '')}" oninput="updateQuizField(${qi}, 'explanation', this.value)">
      </div>
    </div>`;
  });
  list.innerHTML = html;
}
function addQuizQuestion() { quizDraft.push({ question: '', options: ['', '', '', ''], correctIndex: 0, explanation: '' }); renderQuizDraft(); }
function removeQuizQuestion(qi) { quizDraft.splice(qi, 1); renderQuizDraft(); }
function updateQuizField(qi, field, val) { quizDraft[qi][field] = val; }
function updateQuizOption(qi, oi, val) { quizDraft[qi].options[oi] = val; }
function updateQuizCorrect(qi, oi) { quizDraft[qi].correctIndex = oi; }

async function saveQuiz() {
  for (let i = 0; i < quizDraft.length; i++) {
    const q = quizDraft[i];
    if (!q.question.trim()) return showToast(`Question ${i + 1} has no text.`, 'error');
    if (q.options.some(o => !o.trim())) return showToast(`Question ${i + 1} has empty options.`, 'error');
  }
  const courseId = $('quizCourseId').value;
  const materialId = $('quizMaterialId').value;
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/materials/${materialId}/quiz`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quiz: quizDraft })
    });
    const data = await res.json();
    if (data.success) { showToast('✓ Quiz saved!', 'success'); closeModal('quizModal'); fetchCoursesFromDB(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

let quizPlayerState = null;
function openQuizPlayer(courseId, materialId) {
  const course = findCourse(courseId); if (!course) return;
  const mat = course.materials.find(m => m.id === materialId); if (!mat) return;
  const quiz = mat.quiz || [];
  if (quiz.length === 0) return showToast('No quiz.', 'info');
  quizPlayerState = { courseId, materialId, materialTitle: mat.title, quiz, answers: new Array(quiz.length).fill(-1), submitted: false, response: null };
  renderQuizPlayer();
  openModal('quizPlayerModal');
}
function renderQuizPlayer() {
  const st = quizPlayerState; if (!st) return;
  $('quizPlayerTitle').innerHTML = `<i class="fas fa-question-circle"></i> ${escapeHtml(st.materialTitle)}`;
  if (!st.submitted) {
    $('quizPlayerSub').textContent = `${st.quiz.length} questions · Choose one per question`;
    $('quizPlayerActions').innerHTML = `<button type="button" class="btn btn-outline" onclick="closeModal('quizPlayerModal')">Cancel</button>
      <button type="button" class="btn btn-primary" onclick="submitQuiz()"><i class="fas fa-paper-plane"></i> Submit</button>`;
    let html = '';
    st.quiz.forEach((q, qi) => {
      html += `<div class="quiz-play-card">
        <div class="quiz-play-qnum">Question ${qi + 1} of ${st.quiz.length}</div>
        <h4 class="quiz-play-question">${escapeHtml(q.question)}</h4>
        <div class="quiz-play-options">
          ${q.options.map((opt, oi) => `<label class="quiz-play-option ${st.answers[qi] === oi ? 'selected' : ''}" onclick="selectQuizAnswer(${qi}, ${oi})">
            <span class="quiz-play-letter">${String.fromCharCode(65 + oi)}</span>
            <span class="quiz-play-text">${escapeHtml(opt)}</span>
          </label>`).join('')}
        </div>
      </div>`;
    });
    $('quizPlayerBody').innerHTML = html;
  } else {
    const { score, total, percent, results, attempts } = st.response;
    const isPerfect = score === total;
    const isPass = percent >= 60;
    const emoji = isPerfect ? '🏆' : isPass ? '🎉' : '📚';
    const headline = isPerfect ? 'Perfect Score!' : isPass ? 'Well done!' : 'Keep practicing!';
    $('quizPlayerSub').textContent = `Attempt #${attempts}`;
    $('quizPlayerActions').innerHTML = `<button type="button" class="btn btn-outline" onclick="openQuizPlayer('${st.courseId}', '${st.materialId}')"><i class="fas fa-redo"></i> Retake</button>
      <button type="button" class="btn btn-primary" onclick="closeModal('quizPlayerModal')"><i class="fas fa-check"></i> Done</button>`;
    let html = `<div class="quiz-result-hero ${isPass ? 'pass' : 'fail'}">
      <div class="quiz-result-emoji">${emoji}</div>
      <div class="quiz-result-score">${score} / ${total}</div>
      <div class="quiz-result-pct">${percent}%</div>
      <div class="quiz-result-headline">${headline}</div>
    </div>`;
    st.quiz.forEach((q, qi) => {
      const r = results[qi]; const ok = r.correct;
      html += `<div class="quiz-result-item ${ok ? 'ok' : 'bad'}">
        <div class="quiz-result-head"><span class="quiz-result-badge ${ok ? 'ok' : 'bad'}"><i class="fas ${ok ? 'fa-check' : 'fa-times'}"></i></span><strong>Q${qi + 1}.</strong> ${escapeHtml(q.question)}</div>
        <div class="quiz-result-body">
          <div class="quiz-answer-row"><span class="quiz-answer-label">Your answer:</span><span class="${ok ? 'ok-text' : 'bad-text'}">${escapeHtml(q.options[r.chosen] ?? '—')}</span></div>
          ${!ok ? `<div class="quiz-answer-row"><span class="quiz-answer-label">Correct:</span><span class="ok-text">${escapeHtml(q.options[r.correctIndex])}</span></div>` : ''}
          ${r.explanation ? `<div class="quiz-explain"><i class="fas fa-lightbulb"></i> ${escapeHtml(r.explanation)}</div>` : ''}
        </div>
      </div>`;
    });
    $('quizPlayerBody').innerHTML = html;
  }
}
function selectQuizAnswer(qi, oi) {
  if (!quizPlayerState || quizPlayerState.submitted) return;
  quizPlayerState.answers[qi] = oi;
  renderQuizPlayer();
}
async function submitQuiz() {
  const st = quizPlayerState; if (!st) return;
  const unanswered = st.answers.filter(a => a < 0).length;
  if (unanswered > 0) return showToast(`Answer all (${unanswered} left).`, 'error');
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/user/quiz/${st.courseId}/${st.materialId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser._id, answers: st.answers })
    });
    const data = await res.json();
    if (data.success) {
      st.submitted = true; st.response = data;
      if (!currentUser.quizResults) currentUser.quizResults = {};
      currentUser.quizResults[st.materialId] = { score: data.score, total: data.total, attempts: data.attempts, lastAttemptAt: new Date().toISOString() };
      localStorage.setItem('aero_user', JSON.stringify(currentUser));
      renderQuizPlayer();
      const pct = data.percent;
      if (pct === 100) showToast('🏆 Perfect!', 'success');
      else if (pct >= 60) showToast(`🎉 Scored ${data.score}/${data.total}!`, 'success');
      else showToast(`📚 Scored ${data.score}/${data.total}.`, 'info');
    } else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

/* ============================================================
   FILE VIEWER / BOOKMARK / PROGRESS
   ============================================================ */
async function viewFileOnline(courseId, materialId) {
  const course = findCourse(courseId); if (!course) return;
  const mat = course.materials.find(m => m.id === materialId);
  if (!mat || !mat.fileData) return showToast('No file attached.', 'info');

  const fileName = (mat.fileName || '').toLowerCase();
  const isPdf =
    fileName.endsWith('.pdf') ||
    String(mat.fileData).startsWith('data:application/pdf');

  if (isPdf) {
    window.PDFViewer.open({
      data: mat.fileData,
      materialId: mat.id,
      courseId: course.id,
      fileName: mat.fileName,
      title: mat.title,
      username: currentUser.fullName || currentUser.username || 'Student'
    });
  } else {
    showToast('Inline preview is only available for PDFs.', 'info');
  }
}

/* NEW — opens video materials in the custom player */
function openMaterialVideo(courseId, materialId) {
  const course = findCourse(courseId); if (!course) return;
  const mat = course.materials.find(m => m.id === materialId);
  if (!mat || !mat.url) return showToast('No video URL set for this material.', 'error');
  window.VideoPlayer.open({
    src: mat.url,
    materialId: mat.id,
    courseId: course.id,
    title: mat.title,
    username: currentUser.fullName || currentUser.username || 'Student'
  });
}

/* NEW: open video material in the custom player */
function openMaterialVideo(courseId, materialId) {
  const course = findCourse(courseId); if (!course) return;
  const mat = course.materials.find(m => m.id === materialId);
  if (!mat || !mat.url) return showToast('No video URL set for this material.', 'error');
  window.VideoPlayer.open({
    src: mat.url,
    materialId: mat.id,
    courseId: course.id,
    title: mat.title,
    username: currentUser.fullName || currentUser.username || 'Student'
  });
}

async function toggleBookmark(e, courseId) {
  if (e) e.stopPropagation();
  if (!currentUser?._id) return;
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/user/bookmarks/${courseId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser._id })
    });
    const data = await res.json();
    if (data.success) {
      currentUser.bookmarks = data.bookmarks;
      localStorage.setItem('aero_user', JSON.stringify(currentUser));
      showToast(data.bookmarked ? '★ Saved' : 'Removed', 'success');
      renderApp();
    } else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

async function toggleMaterialViewed(e, courseId, materialId) {
  if (e) e.stopPropagation();
  const currently = isMaterialViewed(courseId, materialId);
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/user/progress/${courseId}/${materialId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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
    } else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
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
  } catch {}
}

/* ============================================================
   COURSE / MATERIAL CRUD
   ============================================================ */
function openAddCourseModal() {
  $('courseModalTitle').textContent = '📚 New Course';
  $('editCourseId').value = '';
  $('courseName').value = '';
  $('courseCode').value = '';
  $('courseSemester').value = '';
  $('courseInstructor').value = '';
  $('courseDescription').value = '';
  if ($('courseCategory')) $('courseCategory').value = 'General';
  if ($('courseDifficulty')) $('courseDifficulty').value = 'Intermediate';
  const pc = $('courseIsPremium'); if (pc) pc.checked = false;
  const pi = $('coursePrice'); if (pi) pi.value = '';
  const pg = $('priceGroup'); if (pg) pg.style.display = 'none';
  openModal('courseModal');
}

function togglePriceInput() {
  const pg = $('priceGroup'); const pc = $('courseIsPremium');
  if (pg && pc) pg.style.display = pc.checked ? 'block' : 'none';
}

async function saveCourse(e) {
  e.preventDefault();
  const payload = {
    name: $('courseName').value.trim(),
    code: $('courseCode').value.trim(),
    semester: $('courseSemester').value.trim(),
    instructor: $('courseInstructor').value.trim(),
    description: $('courseDescription').value.trim(),
    category: $('courseCategory')?.value || 'General',
    difficulty: $('courseDifficulty')?.value || 'Intermediate',
    isPremium: $('courseIsPremium').checked,
    price: parseFloat($('coursePrice').value) || 0,
    status: 'draft'
  };
  if (!payload.name || !payload.code) return showToast('Name and code required.', 'error');
  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/courses', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (data.success) {
      showToast('🎉 Course created! Opening editor...', 'success');
      closeModal('courseModal');
      await fetchCoursesFromDB();
      if (data.course && data.course._id) setTimeout(() => openCourseEditor(data.course._id), 300);
    } else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

async function deleteCourse(courseId) {
  if (!confirm('Delete this course and all its materials?')) return;
  try {
    const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}`, { method: 'DELETE' });
    const data = await response.json();
    if (data.success) {
      if (currentCourseId === courseId) currentCourseId = null;
      if (editingCourseId === courseId) editingCourseId = null;
      showToast('🗑️ Deleted.', 'info');
      fetchCoursesFromDB();
    } else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

/* ============================================================
   PROFESSORS
   ============================================================ */
function openAddProfessorModal() {
  ['editProfessorId', 'professorName', 'professorTitle', 'professorDescription', 'professorPhoto']
    .forEach(id => { const el = $(id); if (el) el.value = ''; });
  openModal('professorModal');
}
function saveProfessor(e) {
  e.preventDefault();
  const data = loadData();
  const name = $('professorName').value.trim();
  const processSave = (photoData) => {
    data.professors.push({
      id: generateId(), name,
      title: $('professorTitle').value.trim(),
      description: $('professorDescription').value.trim(),
      photo: photoData || ''
    });
    saveData(data);
    showToast('✓ Professor added!', 'success');
    closeModal('professorModal');
    renderApp();
  };
  const photoFile = $('professorPhoto').files ? $('professorPhoto').files[0] : null;
  if (photoFile) {
    const reader = new FileReader();
    reader.onload = ev => processSave(ev.target.result);
    reader.readAsDataURL(photoFile);
  } else processSave(null);
}
function deleteProfessor(professorId) {
  if (!confirm('Delete this professor?')) return;
  const data = loadData();
  data.professors = data.professors.filter(p => p.id !== professorId);
  saveData(data);
  showToast('Deleted.', 'info');
  renderApp();
}

/* ============================================================
   LEGACY MATERIAL MODAL
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
  const file = $('materialFile').files ? $('materialFile').files[0] : null;
  const processSave = async (fileData, fileName) => {
    const isPremiumMat = $('materialIsPremium') ? $('materialIsPremium').checked : false;
    const matPrice = $('materialPrice') ? (parseFloat($('materialPrice').value) || 0) : 0;
    const materialData = {
      title: $('materialTitle').value.trim(),
      type: $('materialType').value,
      description: $('materialDescription').value.trim(),
      url: $('materialUrl').value.trim(),
      isPremium: isPremiumMat, price: matPrice,
      fileData, fileName
    };
    try {
      const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/materials`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(materialData)
      });
      const data = await response.json();
      if (data.success) { showToast('📎 Uploaded!', 'success'); closeModal('materialModal'); fetchCoursesFromDB(); }
      else showToast(data.message || 'Failed.', 'error');
    } catch { showToast('Server error.', 'error'); }
  };
  if (file) {
    const reader = new FileReader();
    reader.onload = ev => processSave(ev.target.result, file.name);
    reader.readAsDataURL(file);
  } else processSave('', '');
}

/* ============================================================
   Q&A ACTIONS
   ============================================================ */
async function askDoubt(courseId) {
  const textarea = $('newDoubtText'); if (!textarea) return;
  const question = textarea.value.trim();
  if (!question) return showToast('Type your doubt first.', 'error');
  try {
    const response = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/doubts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentName: currentUser.fullName || currentUser.username,
        studentUsername: currentUser.username,
        studentEmail: currentUser.email || '',
        question
      })
    });
    const data = await response.json();
    if (data.success) { showToast('❓ Submitted!', 'success'); textarea.value = ''; fetchCoursesFromDB(); }
    else showToast(data.message || 'Error.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

async function postReply(courseId, doubtId) {
  const ta = document.getElementById(`replyText-${doubtId}`); if (!ta) return;
  const text = ta.value.trim();
  if (!text) return showToast('Type a reply.', 'error');
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/doubts/${doubtId}/replies`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authorName: currentUser.fullName || currentUser.username,
        authorUsername: currentUser.username,
        authorRole: currentUser.role,
        text
      })
    });
    const data = await res.json();
    if (data.success) { showToast('💬 Posted!', 'success'); ta.value = ''; fetchCoursesFromDB(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

async function acceptReply(courseId, doubtId, replyId) {
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/doubts/${doubtId}/replies/${replyId}/accept`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptedBy: currentUser.username })
    });
    const data = await res.json();
    if (data.success) { showToast('✅ Accepted!', 'success'); fetchCoursesFromDB(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
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
  showToast(`Initiating payment for ${itemName}...`, 'info');
  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/create-order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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
        showToast('Verifying...', 'info');
        const verifyRes = await fetch('https://aerospace-portal.onrender.com/api/verify-payment', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
            courseId: purchaseId, userId: currentUser._id
          })
        });
        const verifyData = await verifyRes.json();
        if (verifyData.success) {
          if (!currentUser.purchases) currentUser.purchases = [];
          if (!currentUser.purchases.includes(purchaseId)) currentUser.purchases.push(purchaseId);
          localStorage.setItem('aero_user', JSON.stringify(currentUser));
          showToast('🎉 Payment Successful!', 'success');
          renderApp();
        } else showToast('Verification failed!', 'error');
      },
      prefill: { name: currentUser.username, email: currentUser.email || 'student@aerospace.com', contact: '9999999999' },
      theme: { color: '#4f46e5' }
    };
    new Razorpay(options).open();
  } catch { showToast('Server error during payment.', 'error'); }
}

/* ============================================================
   MODAL + TOAST
   ============================================================ */
function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return showToast(`Modal "${id}" missing.`, 'error');
  el.classList.add('active');
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('active');
}
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', function (e) { if (e.target === this) this.classList.remove('active'); });
});

function showToast(message, type = 'info') {
  const container = $('toastContainer'); if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const iconMap = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle' };
  toast.innerHTML = `<i class="fas ${iconMap[type] || 'fa-info-circle'}"></i> <span>${message}</span>`;
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
    if (currentUser.role === 'admin') adminTab = 'overview';
  }
  syncHashToState();
  renderApp();
  await fetchCoursesFromDB();
  await refreshUserData();
  await loadNotifications();
  renderApp();
}

window.addEventListener('hashchange', () => { syncHashToState(); renderApp(); });
initApp();