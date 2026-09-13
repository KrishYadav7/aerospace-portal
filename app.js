/* ============================================================
   API CONFIGURATION
   ============================================================ */
const API_BASE = 'https://aerospace-portal.onrender.com/api';

/* ============================================================
   SAFE JSON FETCH
   ------------------------------------------------------------
   Wraps fetch() and guarantees:
     • If the server returns HTML (404 page, 500 page, proxy error),
       we throw a human-readable error instead of "Unexpected token '<'".
     • If the server returns empty body, we throw a clear message.
     • If JSON parsing fails, we include a snippet of the raw reply.
   ============================================================ */
async function fetchJSON(url, options = {}) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (networkErr) {
    throw new Error('Network error — could not reach the server. Check your connection.');
  }

  const raw = (await res.text() || '').trim();

  // Empty body? Give a clean error.
  if (!raw) {
    throw new Error('Server returned an empty response (HTTP ' + res.status + ').');
  }

  // HTML response = backend route missing OR server crashed.
  if (raw.startsWith('<')) {
    if (res.status === 404) {
      throw new Error(
        'API route not found (HTTP 404). The endpoint "' + url + '" is not deployed on the server yet. ' +
        'Please redeploy the latest server.js to Render.'
      );
    }
    if (res.status === 500) {
      throw new Error(
        'Server error (HTTP 500). The backend crashed while handling this request. ' +
        'Check the Render logs — a route or model may be missing.'
      );
    }
    throw new Error(
      'Server returned HTML instead of JSON (HTTP ' + res.status + '). ' +
      'The backend route is probably missing.'
    );
  }

  // JSON parse
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      'Invalid JSON from server (HTTP ' + res.status + '). ' +
      'Raw reply starts with: ' + raw.slice(0, 120)
    );
  }
}

/* ============================================================
   PROFESSORS (MongoDB — centralized database)
   ============================================================ */
let liveProfessors = [];
function getProfessors() { return liveProfessors; }
function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

async function fetchProfessorsFromDB() {
  try {
    const response = await fetch(`${API_BASE}/professors?t=${Date.now()}`);
    const data = await response.json();
    if (data.success) {
      // Map _id (from MongoDB) to id (for the frontend)
      liveProfessors = data.professors.map(p => ({ 
        ...p, 
        id: p._id || p.id 
      }));
    }
  } catch (error) {
    console.error('Error fetching professors:', error);
  }
}
/* ============================================================
   SESSION HELPERS (per-tab auth — do NOT use localStorage here)
   ============================================================ */
const SESSION_USER_KEY  = 'aero_user';
const SESSION_TOKEN_KEY = 'aero_token';

function saveSession(user, token) {
  if (user)  sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(user));
  if (token) sessionStorage.setItem(SESSION_TOKEN_KEY, token);
}
function saveSessionUser(user) {
  if (user) sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(user));
}
function loadSessionUser() {
  try {
    const raw = sessionStorage.getItem(SESSION_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function clearSession() {
  sessionStorage.removeItem(SESSION_USER_KEY);
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
}

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
      return { ...course, id: course._id, materials: fixedMaterials, playlists: course.playlists || [] };
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
let addingCourse = false;
let addingProfessor = false;
let addingMaterialCourseId = null;
let addingStudent = false;

// ---- Bulk email selection (in-memory only; cleared on tab switch / logout) ----
let _emailSelectedIds = new Set();

// ---- Subscription settings (global, fetched on boot) ----
let liveSubscriptionSettings = { enabled: false, amount: 0, title: '', description: '' };

async function fetchSubscriptionSettings() {
  try {
    const res = await fetch(`${API_BASE}/settings/subscription?t=${Date.now()}`);
    const data = await res.json();
    if (data.success && data.settings) {
      liveSubscriptionSettings = data.settings;
    }
  } catch (e) { /* silent */ }
}

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
/* ============================================================
   MATERIAL TYPES — fixed + user-defined custom types
   ============================================================ */
const KNOWN_MAT_TYPES = ['video', 'pyq', 'tutorial', 'slides', 'other'];

function isKnownMaterialType(t) {
  return KNOWN_MAT_TYPES.includes(String(t || '').toLowerCase());
}

// Slug used for CSS class (e.g. "Lab Manual" -> "lab-manual")
function materialTypeSlug(t) {
  const s = String(t || 'other')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'other';
}

// Called by <select onchange="..."> to reveal the custom-type input
function handleMaterialTypeChange(selectEl, customGroupId) {
  const grp = document.getElementById(customGroupId);
  if (!grp) return;
  const isCustom = selectEl.value === '__custom__';
  grp.style.display = isCustom ? 'block' : 'none';
  if (isCustom) {
    const inp = grp.querySelector('input');
    if (inp) setTimeout(() => inp.focus(), 30);
  }
}

// Resolve the final type value when saving
function resolveMaterialType(selectValue, customValue) {
  if (selectValue === '__custom__') {
    const v = String(customValue || '').trim().toLowerCase();
    return v || null;
  }
  return selectValue;
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
  if (parts[0] === 'admin' && parts[1] === 'quiz' && parts[2] && parts[3]) {
    quizEditingCourseId = parts[2];
    quizEditingMaterialId = parts[3];
    currentCourseId = null; editingCourseId = null;
    addingCourse = false; addingProfessor = false;
    addingMaterialCourseId = null; addingStudent = false;
    return;
  }
  if (parts[0] === 'admin' && parts[1] === 'course' && parts[2] === 'new') {
    addingCourse = true; addingProfessor = false; addingMaterialCourseId = null; addingStudent = false;
    currentCourseId = null; editingCourseId = null; return;
  }
  if (parts[0] === 'admin' && parts[1] === 'professor' && parts[2] === 'new') {
    addingProfessor = true; addingCourse = false; addingMaterialCourseId = null; addingStudent = false;
    currentCourseId = null; editingCourseId = null; return;
  }
  if (parts[0] === 'admin' && parts[1] === 'course' && parts[2] && parts[3] === 'material' && parts[4] === 'new') {
    addingMaterialCourseId = parts[2]; addingCourse = false; addingProfessor = false; addingStudent = false;
    currentCourseId = null; editingCourseId = null; return;
  }
  if (parts[0] === 'admin' && parts[1] === 'student' && parts[2] === 'new') {
    addingStudent = true; addingCourse = false; addingProfessor = false; addingMaterialCourseId = null;
    currentCourseId = null; editingCourseId = null; return;
  }

  currentCourseId = null;
  window.currentSelectedCourseId = null;
  editingCourseId = null;
  addingCourse = false; addingProfessor = false; addingMaterialCourseId = null; addingStudent = false;
  if (parts[0] === 'admin') {
    adminTab = parts[1] || 'overview';
  } else if (parts[0] === 'courses') {
    studentNav = 'courses';
  } else if (parts[0] === 'saved') {
    studentNav = 'saved';
  } else if (parts[0] === 'analytics') {
    studentNav = 'analytics';
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
   THEME — three-way cycle: light → dim → dark
   ============================================================ */
const THEME_CYCLE = ['light', 'dim', 'dark'];
const THEME_ICONS = {
  light: { icon: 'fa-sun',                label: 'Light mode — click for dim' },
  dim:   { icon: 'fa-circle-half-stroke', label: 'Dim mode — click for dark' },
  dark:  { icon: 'fa-moon',               label: 'Dark mode — click for light' }
};

function getCurrentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'light';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('aero_theme', theme); } catch {}
  updateThemeIcon();
}
function cycleTheme() {
  const cur = getCurrentTheme();
  const idx = THEME_CYCLE.indexOf(cur);
  const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
  applyTheme(next);
}
function updateThemeIcon() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const t = getCurrentTheme();
  const meta = THEME_ICONS[t] || THEME_ICONS.light;
  btn.innerHTML = `<i class="fas ${meta.icon}" aria-hidden="true"></i>`;
  btn.setAttribute('aria-label', meta.label);
  btn.setAttribute('title', meta.label);
}

(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('aero_theme'); } catch {}
  const valid = ['light', 'dim', 'dark'];
  const prefers = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initial = valid.includes(saved) ? saved : (prefers ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', initial);
})();

/* ============================================================
   GLOBAL CLICK HANDLERS
   ============================================================ */
document.addEventListener('click', (e) => {
  if (e.target.closest('#themeToggle')) {
    cycleTheme();
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
   GLOBAL SEARCH (Cmd/Ctrl + K)
   ============================================================ */
let _searchFocusedIndex = 0;
let _searchResults = [];

function openGlobalSearch() {
  const el = document.getElementById('globalSearchOverlay');
  if (!el) return;
  el.classList.add('active');
  const input = document.getElementById('globalSearchInput');
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 30);
  }
  runGlobalSearch('');
}
function closeGlobalSearch() {
  document.getElementById('globalSearchOverlay')?.classList.remove('active');
}
function runGlobalSearch(query) {
  const q = (query || '').trim().toLowerCase();
  const results = [];
  const courses = getCourses();

  if (!q) {
    const cont = document.getElementById('globalSearchResults');
    if (cont) cont.innerHTML = `<div class="global-search-empty">
      <i class="fas fa-search"></i>
      Start typing to search across all courses, materials, and doubts
    </div>`;
    _searchResults = [];
    _searchFocusedIndex = 0;
    return;
  }

  courses.slice(0, 8).forEach(c => {
    const hay = (c.name + ' ' + (c.code || '') + ' ' + (c.instructor || '')).toLowerCase();
    if (hay.includes(q)) {
      results.push({
        kind: 'course', id: c.id,
        title: c.name, meta: `${c.code || ''} · ${c.instructor || 'Instructor'}`,
        icon: 'fa-graduation-cap'
      });
    }
  });

  courses.forEach(c => {
    (c.materials || []).forEach(m => {
      const hay = (m.title + ' ' + (m.description || '')).toLowerCase();
      if (hay.includes(q)) {
        results.push({
          kind: 'material', courseId: c.id, id: m.id,
          title: m.title,
          meta: `${c.name} · ${(m.type || '').toUpperCase()}`,
          icon: 'fa-layer-group'
        });
      }
    });
  });

  courses.forEach(c => {
    (c.doubts || []).forEach(d => {
      if ((d.question || '').toLowerCase().includes(q)) {
        results.push({
          kind: 'doubt', courseId: c.id,
          title: d.question,
          meta: `${c.name} · asked by ${d.studentName || 'student'}`,
          icon: 'fa-comment-dots'
        });
      }
    });
  });

  _searchResults = results.slice(0, 30);
  _searchFocusedIndex = 0;
  renderGlobalSearchResults(q);
}

function renderGlobalSearchResults(query) {
  const cont = document.getElementById('globalSearchResults');
  if (!cont) return;
  if (_searchResults.length === 0) {
    cont.innerHTML = `<div class="global-search-empty">
      <i class="fas fa-inbox"></i>
      No results for "${escapeHtml(query)}"
    </div>`;
    return;
  }

  let html = '<div class="global-search-section-label">Results</div>';
  _searchResults.forEach((r, i) => {
    const t = highlightMatch(r.title, query);
    const m = highlightMatch(r.meta, query);
    html += `<div class="global-search-item${i === _searchFocusedIndex ? ' focused' : ''}" data-idx="${i}">
      <div class="global-search-item-icon"><i class="fas ${r.icon}"></i></div>
      <div class="global-search-item-body">
        <div class="global-search-item-title">${t}</div>
        <div class="global-search-item-meta">${m}</div>
      </div>
    </div>`;
  });
  cont.innerHTML = html;

  cont.querySelectorAll('.global-search-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx, 10);
      openSearchResult(_searchResults[idx]);
    });
  });
}

function highlightMatch(text, query) {
  const safe = escapeHtml(text || '');
  if (!query) return safe;
  const safeQ = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return safe.replace(new RegExp('(' + safeQ + ')', 'ig'), '<mark>$1</mark>');
  } catch { return safe; }
}

function openSearchResult(r) {
  if (!r) return;
  closeGlobalSearch();
  if (r.kind === 'course') {
    viewCourseDetail(r.id);
  } else if (r.kind === 'material') {
    viewCourseDetail(r.courseId);
  } else if (r.kind === 'doubt') {
    currentMaterialFilter = 'qa';
    viewCourseDetail(r.courseId);
  }
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    const overlay = document.getElementById('globalSearchOverlay');
    if (overlay?.classList.contains('active')) closeGlobalSearch();
    else openGlobalSearch();
    return;
  }
  const overlay = document.getElementById('globalSearchOverlay');
  if (!overlay?.classList.contains('active')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeGlobalSearch(); return; }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _searchFocusedIndex = Math.min(_searchResults.length - 1, _searchFocusedIndex + 1);
    renderGlobalSearchResults(document.getElementById('globalSearchInput')?.value || '');
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _searchFocusedIndex = Math.max(0, _searchFocusedIndex - 1);
    renderGlobalSearchResults(document.getElementById('globalSearchInput')?.value || '');
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (_searchResults[_searchFocusedIndex]) openSearchResult(_searchResults[_searchFocusedIndex]);
  }
});

document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'globalSearchInput') {
    runGlobalSearch(e.target.value);
  }
});

document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'globalSearchOverlay') closeGlobalSearch();
  if (e.target.closest('#globalSearchCloseBtn')) closeGlobalSearch();
  if (e.target.closest('#globalSearchTrigger')) { e.preventDefault(); openGlobalSearch(); }
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

  const btn = e.target.querySelector('button[type="submit"]');
  const originalBtnText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing in...';

  const resetBtn = () => {
    btn.disabled = false;
    btn.innerHTML = originalBtnText;
  };

  const attemptLogin = async (retries = 2) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout for Render cold start

      const response = await fetch('https://aerospace-portal.onrender.com/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role: loginRole }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const data = await response.json();

      if (data.requires2FA && data.pendingToken) {
        _adminPendingToken = data.pendingToken;
        openOtpModal({
          title: 'Admin 2FA Verification',
          subtitle: `We've sent a 6-digit code to ${data.maskedEmail || 'your email'}. Enter it to finish logging in.`,
          type: 'admin-login',
          data: { pendingToken: data.pendingToken }
        });
        showToast('OTP sent to your email.', 'info');
        resetBtn();
        return;
      }

      if (data.success) {
        currentUser = data.user;
        saveSession(data.user, data.token);
        studentNav = 'home';
        adminTab = 'overview';
        editingCourseId = null;
        setLoginRole('student');
        pushHash(data.user.role === 'admin' ? '#/admin/overview' : '#/home');
        showToast(data.message, 'success');
        renderApp();
      } else {
        showToast(data.message, 'error');
        resetBtn();
      }
    } catch (err) {
      if (err.name === 'AbortError' || err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
        if (retries > 0) {
          showToast(`Server is waking up... Retrying (${3 - retries}/2)`, 'info');
          await new Promise(r => setTimeout(r, 5000));
          return attemptLogin(retries - 1);
        }
        showToast('Server is taking too long to respond. Please try again.', 'error');
      } else {
        showToast('Network error. Check your connection.', 'error');
      }
      resetBtn();
    }
  };

  await attemptLogin();
}

function logout() {
  currentUser = null; currentCourseId = null; editingCourseId = null;
  window.currentSelectedCourseId = null;
  currentMaterialFilter = 'all'; studentNav = 'home'; adminTab = 'overview';
  clearSession();
  loginRole = 'student';
  try { setLoginRole('student'); } catch (e) { }
  try { _emailSelectedIds.clear(); } catch (e) {}
  _analyticsCache = null;
  _analyticsCacheAt = 0;
  try { destroyAnalyticsCharts(); } catch (e) {}
   quizEditingCourseId = null;
  quizEditingMaterialId = null;
  quizDraft = [];
  quizPlayerState = null;
  stopQuizAutosave();
  stopQuizTimer();
  pushHash('#/home'); renderApp(); showToast('Logged out.', 'info');
}

function showRegisterModal() {
  ['regFullName', 'regUsername', 'regEmail', 'regPassword'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  openModal('registerModal');
}
let tempRegisterData = null;
let _adminPendingToken = null; // pendingToken between password + admin 2FA
async function registerStudent(e) {
  e.preventDefault();
  const fullName = $('regFullName').value.trim();
  const username = $('regUsername').value.trim();
  const email    = $('regEmail').value.trim();
  const phone    = $('regPhone').value.trim();
  const password = $('regPassword').value.trim();

  if (!fullName || !username || !password || !email || !phone) {
    return showToast('Please fill all fields.', 'error');
  }
  if (password.length < 6) return showToast('Password must be at least 6 characters.', 'error');
  if (!/^\d{10,15}$/.test(phone.replace(/\D/g, ''))) {
    return showToast('Please enter a valid contact number.', 'error');
  }

  showToast('Sending OTP...', 'info');
  try {
    const response = await fetch(`${API_BASE}/send-otp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username, phone })
    });
    const data = await response.json();
    if (data.success) {
      tempRegisterData = { fullName, username, email, phone, password };
      closeModal('registerModal');
      openOtpModal({
        title: 'Verify Email & Phone',
        subtitle: `We've sent a 6-digit OTP to ${email} and your phone. Enter it below to finish registration.`,
        type: 'register',
        data: tempRegisterData
      });
    } else {
      showToast(data.message || 'Could not send OTP.', 'error');
    }
  } catch {
    showToast('Server network error.', 'error');
  }
}
/* ============================================================
   SHARED OTP MODAL — used by register / forgot-username / forgot-password
   ============================================================ */
let _otpContext = null;    // { type, data }
let _resetToken = null;    // held after forgot-password verify

function openOtpModal({ title, subtitle, type, data }) {
  _otpContext = { type, data };

  const titleEl = $('otpModalTitle');
  const subEl   = $('otpModalSub');
  const input   = $('otpModalInput');
  const btn     = $('otpModalSubmitBtn');
  const resendRow = document.getElementById('otpResendRow');

  if (titleEl) titleEl.innerHTML = `<i class="fas fa-shield-halved"></i> ${escapeHtml(title)}`;
  if (subEl)   subEl.textContent = subtitle || 'Enter the code we sent you.';
  if (input)   input.value = '';
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-check"></i> Verify';
  }
  // Resend link is only useful for admin-login
  if (resendRow) resendRow.style.display = (type === 'admin-login') ? 'block' : 'none';

  openModal('otpVerificationModal');
  setTimeout(() => input && input.focus(), 120);
}

/* ---- Resend the OTP for the current context ---- */
/* ---- Resend the OTP for the current context ---- */
async function resendOtpForCurrentContext() {
  if (!_otpContext) return;
  const btn = document.getElementById('otpResendBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending…'; }

  try {
    if (_otpContext.type === 'admin-login' && _otpContext.data?.pendingToken) {
      const res = await fetchJSON(`${API_BASE}/admin/login/resend-otp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingToken: _otpContext.data.pendingToken })
      });
      
      if (res.success) {
        // IMPORTANT: Update the pendingToken with the new one returned by the server
        _otpContext.data.pendingToken = res.pendingToken;
        showToast('✓ New OTP sent.', 'success');
      } else {
        showToast(res.message || 'Could not resend.', 'error');
      }
    } else {
      showToast('Resend is not available for this step.', 'info');
    }
  } catch (err) {
    showToast(err.message || 'Network error.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-rotate-right"></i> Resend OTP'; }
  }
}

function cancelOtpVerification() {
  _otpContext = null;
  closeModal('otpVerificationModal');
}

async function submitOtpVerification() {
  if (!_otpContext) return closeModal('otpVerificationModal');

  const input = $('otpModalInput');
  const btn   = $('otpModalSubmitBtn');
  const otp   = input ? input.value.trim() : '';

  if (!/^\d{6}$/.test(otp)) {
    return showToast('Please enter a valid 6-digit OTP.', 'error');
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying…';
  }

  try {
    if (_otpContext.type === 'register') {
      await _handleRegisterOtp(otp);
    } else if (_otpContext.type === 'forgot-username') {
      await _handleForgotUsernameOtp(otp);
    } else if (_otpContext.type === 'forgot-password') {
      await _handleForgotPasswordOtp(otp);
    } else if (_otpContext.type === 'admin-login') {
      await _handleAdminLoginOtp(otp);
    } else {
      throw new Error('Unknown verification context.');
    }
  } catch (err) {
    showToast(err.message || 'Verification failed.', 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-check"></i> Verify';
    }
    if (input) { input.value = ''; input.focus(); }
  }
}

/* ---- Registration OTP handler ---- */
async function _handleRegisterOtp(otp) {
  const res = await fetch(`${API_BASE}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ..._otpContext.data, otp })
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.message || 'Registration failed.');

  _otpContext = null;
  tempRegisterData = null;
  closeModal('otpVerificationModal');
  showToast('🎉 Registration successful! You can now log in.', 'success');
}


/* ---- Admin 2FA login OTP handler ---- */
async function _handleAdminLoginOtp(otp) {
  const data = await fetchJSON(`${API_BASE}/admin/login/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pendingToken: _otpContext.data.pendingToken,
      otp
    })
  });
  
  if (!data.success) throw new Error(data.message || 'Invalid OTP.');

  // Success — establish session
  currentUser = data.user;
  saveSession(data.user, data.token);
  _adminPendingToken = null;
  _otpContext = null;

  closeModal('otpVerificationModal');
  studentNav = 'home';
  adminTab = 'overview';
  editingCourseId = null;
  pushHash('#/admin/overview');
  showToast('🎉 Admin login successful.', 'success');
  renderApp();
}

/* ============================================================
   FORGOT USERNAME FLOW
   ============================================================ */
function showForgotUsernameModal() {
  if ($('fuEmail')) $('fuEmail').value = '';
  if ($('fuPhone')) $('fuPhone').value = '';
  openModal('forgotUsernameModal');
}

async function submitForgotUsernameRequest(e) {
  if (e) e.preventDefault();
  const email = $('fuEmail').value.trim();
  const phone = $('fuPhone').value.trim();

  if (!email && !phone) return showToast('Enter your email or phone.', 'error');

  try {
    const res = await fetch(`${API_BASE}/forgot-username/send-otp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, phone })
    });
    const data = await res.json();
    if (!data.success) return showToast(data.message || 'Could not send OTP.', 'error');

    closeModal('forgotUsernameModal');
    openOtpModal({
      title: 'Verify Your Identity',
      subtitle: 'Enter the OTP we sent. After verification, your username will be sent to your phone and email.',
      type: 'forgot-username',
      data: { email, phone }
    });
    showToast('✅ OTP sent.', 'success');
  } catch {
    showToast('Network error.', 'error');
  }
}

async function _handleForgotUsernameOtp(otp) {
  const res = await fetch(`${API_BASE}/forgot-username/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ..._otpContext.data, otp })
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.message || 'Verification failed.');

  _otpContext = null;
  closeModal('otpVerificationModal');
  showToast('✅ ' + (data.message || 'Username sent to your phone and email.'), 'success');
}

/* ============================================================
   FORGOT PASSWORD FLOW
   ============================================================ */
function showForgotPasswordModal() {
  if ($('fpEmail')) $('fpEmail').value = '';
  if ($('fpPhone')) $('fpPhone').value = '';
  _resetToken = null;
  openModal('forgotPasswordModal');
}

async function submitForgotPasswordRequest(e) {
  if (e) e.preventDefault();
  const email = $('fpEmail').value.trim();
  const phone = $('fpPhone').value.trim();

  if (!email && !phone) return showToast('Enter your email or phone.', 'error');

  try {
    const res = await fetch(`${API_BASE}/forgot-password/send-otp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, phone })
    });
    const data = await res.json();
    if (!data.success) return showToast(data.message || 'Could not send OTP.', 'error');

    closeModal('forgotPasswordModal');
    openOtpModal({
      title: 'Verify Your Identity',
      subtitle: 'Enter the OTP we sent. After verification you can set a new password.',
      type: 'forgot-password',
      data: { email, phone }
    });
    showToast('✅ OTP sent.', 'success');
  } catch {
    showToast('Network error.', 'error');
  }
}

async function _handleForgotPasswordOtp(otp) {
  const res = await fetch(`${API_BASE}/forgot-password/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ..._otpContext.data, otp })
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.message || 'Verification failed.');

  _resetToken = data.resetToken;
  _otpContext = null;
  closeModal('otpVerificationModal');

  if ($('rpNewPassword'))     $('rpNewPassword').value = '';
  if ($('rpConfirmPassword')) $('rpConfirmPassword').value = '';
  openModal('resetPasswordModal');
  showToast('✅ Identity verified. Set a new password.', 'success');
}

async function submitNewPassword(e) {
  if (e) e.preventDefault();

  const pw1 = $('rpNewPassword').value;
  const pw2 = $('rpConfirmPassword').value;

  if (!_resetToken) return showToast('Reset session expired. Start over.', 'error');
  if (pw1.length < 6) return showToast('Password must be at least 6 characters.', 'error');
  if (pw1 !== pw2)    return showToast('Passwords do not match.', 'error');

  const btn = $('rpSubmitBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }

  try {
    const res = await fetch(`${API_BASE}/forgot-password/reset`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetToken: _resetToken, newPassword: pw1 })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.message || 'Could not update password.');

    _resetToken = null;
    closeModal('resetPasswordModal');
    showToast('✅ Password updated. Please log in with your new password.', 'success');
  } catch (err) {
    showToast(err.message || 'Server error.', 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Save New Password'; }
  }
}

/* ============================================================
   ADMIN — Manual Student Registration (Full Page)
   ============================================================ */
function openStudentRegModal() {
  addingStudent = true;
  addingCourse = false;
  addingProfessor = false;
  addingMaterialCourseId = null;
  pushHash('#/admin/student/new');
  renderApp();
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

function renderAdminAddStudent() {
  const container = $('addStudentFormContent');
  if (!container) return;
  container.innerHTML = `
    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-user-graduate"></i> Student Details</h3>
      <div class="editor-grid-2">
        <div class="form-group"><label>Full Name *</label><input type="text" id="newStuFullName" placeholder="e.g. Rohan Verma" required autocomplete="off"></div>
        <div class="form-group"><label>Username *</label><input type="text" id="newStuUsername" placeholder="e.g. rohan.v" required autocomplete="off"></div>
        <div class="form-group"><label>Email (optional)</label><input type="email" id="newStuEmail" placeholder="rohan@example.com" autocomplete="off"></div>
        <div class="form-group"><label>Password *</label>
          <div class="password-field-row">
            <input type="text" id="newStuPassword" placeholder="Min. 6 characters" required minlength="6" autocomplete="off">
            <button type="button" class="btn btn-outline btn-sm" onclick="autoGeneratePassword()" title="Auto-generate"><i class="fas fa-wand-magic-sparkles"></i> Generate</button>
          </div>
          <span class="hint">You'll see this password once after creating. Copy it and share it with the student.</span>
        </div>
      </div>
    </div>
  `;
}

async function saveNewStudentPage() {
  const fullName = $('newStuFullName').value.trim();
  const username = $('newStuUsername').value.trim().toLowerCase();
  const email = $('newStuEmail').value.trim();
  const password = $('newStuPassword').value.trim();

  if (!fullName || !username || !password) return showToast('Fill all required fields.', 'error');
  if (username.length < 3) return showToast('Username must be at least 3 characters.', 'error');
  if (password.length < 6) return showToast('Password must be at least 6 characters.', 'error');
  if (!/^[a-z0-9._-]+$/.test(username)) return showToast('Username may only contain letters, numbers, dots, underscores, or hyphens.', 'error');

  try {
    const res = await fetch('https://aerospace-portal.onrender.com/api/admin/create-student', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName, username, email, password })
    });
    const data = await res.json();

    if (data.success) {
      showToast('🎉 Student created successfully!', 'success');
      addingStudent = false;
      showCredentialsCard(data.student);
      switchAdminTab('students');
    } else {
      showToast(data.message || 'Failed to create student.', 'error');
    }
  } catch (err) {
    showToast('Server error.', 'error');
  }
}

/* ============================================================
   ADMIN — COURSE & PROFESSOR FULL PAGES
   ============================================================ */
function renderAdminAddCourse() {
  const container = $('addCourseFormContent');
  if (!container) return;

  container.innerHTML = `
    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-info-circle"></i> Basic Information</h3>
      <div class="editor-grid-2">
        <div class="form-group"><label>Course Name *</label><input type="text" id="newCourseName" placeholder="e.g. Aerodynamics" required></div>
        <div class="form-group"><label>Course Code *</label><input type="text" id="newCourseCode" placeholder="e.g. AE101" required></div>
        <div class="form-group"><label>Semester</label>
  <select id="newCourseSemester">
    <option value="">Select Semester</option>
    <option value="1">Semester 1</option>
    <option value="2">Semester 2</option>
    <option value="3">Semester 3</option>
    <option value="4">Semester 4</option>
    <option value="5">Semester 5</option>
    <option value="6">Semester 6</option>
    <option value="7">Semester 7</option>
    <option value="8">Semester 8</option>
    <option value="9">Semester 9</option>
    <option value="10">Semester 10</option>
  </select>
</div>
        <div class="form-group"><label>Instructor</label><input type="text" id="newCourseInstructor" placeholder="e.g. Dr. Smith"></div>
      </div>
      <div class="form-group"><label>Description</label><textarea id="newCourseDescription" rows="4" placeholder="Brief description of the course..."></textarea></div>
    </div>

    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-layer-group"></i> Classification & Details</h3>
      <div class="editor-grid-3">
        <div class="form-group"><label>Category</label>
          <select id="newCourseCategory">
            <option value="Aerodynamics">Aerodynamics</option>
            <option value="Propulsion">Propulsion</option>
            <option value="Structures">Structures</option>
            <option value="Avionics">Avionics</option>
            <option value="Mathematics">Mathematics</option>
            <option value="General" selected>General</option>
          </select>
        </div>
        <div class="form-group"><label>Difficulty</label>
          <select id="newCourseDifficulty">
            <option value="Beginner">Beginner</option>
            <option value="Intermediate" selected>Intermediate</option>
            <option value="Advanced">Advanced</option>
          </select>
        </div>
        <div class="form-group"><label>Duration</label><input type="text" id="newCourseDuration" placeholder="e.g. 12 hours"></div>
        <div class="form-group"><label>Credits (Optional)</label><input type="number" id="newCourseCredits" placeholder="e.g. 3" min="0" step="1"></div>
        <div class="form-group"><label>Language (Optional)</label><input type="text" id="newCourseLanguage" placeholder="e.g. English"></div>
      </div>
    </div>

    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-bullseye"></i> Learning Outcomes</h3>
      <p class="editor-hint">One outcome per line. These will be displayed as bullet points on the course page.</p>
      <textarea id="newCourseOutcomes" rows="5" placeholder="Understand aerodynamic principles&#10;Apply Bernoulli's equation..."></textarea>
    </div>

    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-cog"></i> Status & Monetization</h3>
      <div class="editor-grid-3">
        <div class="form-group"><label>Status</label>
          <select id="newCourseStatus">
            <option value="published" selected>✅ Published</option>
            <option value="draft">📝 Draft</option>
          </select>
        </div>
        <div class="form-group"><label>Featured</label>
          <label class="toggle-box" style="margin-top:6px;"><input type="checkbox" id="newCourseFeatured"><span><i class="fas fa-star"></i> Featured</span></label>
        </div>
        <div class="form-group"><label>Premium</label>
          <label class="toggle-box pro" style="margin-top:6px;"><input type="checkbox" id="newCoursePremium" onchange="document.getElementById('newCoursePriceGroup').style.display=this.checked?'block':'none'"><span><i class="fas fa-crown"></i> Premium Course</span></label>
        </div>
      </div>
      <div class="form-group" id="newCoursePriceGroup" style="display:none; margin-top:10px;">
        <label>Price (₹)</label><input type="number" id="newCoursePrice" placeholder="e.g. 499" min="0" step="1">
      </div>
    </div>
  `;
}

async function saveNewCoursePage() {
  const name = $('newCourseName').value.trim();
  const code = $('newCourseCode').value.trim();
  if (!name || !code) return showToast('Course Name and Code are required.', 'error');

  const outcomesRaw = $('newCourseOutcomes').value;
  const learningOutcomes = outcomesRaw.split('\n').map(l => l.trim()).filter(Boolean);
  const isPremium = $('newCoursePremium').checked;

  const payload = {
    name, code,
    semester: $('newCourseSemester').value, // Changed to .value (no trim needed for select)
    instructor: $('newCourseInstructor').value.trim(),
    description: $('newCourseDescription').value.trim(),
    category: $('newCourseCategory').value,
    difficulty: $('newCourseDifficulty').value,
    duration: $('newCourseDuration').value.trim(),
    credits: parseInt($('newCourseCredits').value) || 0,
    language: $('newCourseLanguage').value.trim(),
    learningOutcomes,
    status: $('newCourseStatus').value,
    featured: $('newCourseFeatured').checked,
    isPremium: isPremium,
    price: isPremium ? (parseFloat($('newCoursePrice').value) || 0) : 0
  };

  try {
    const res = await fetch('https://aerospace-portal.onrender.com/api/courses', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    
    if (data.success) {
      showToast('🎉 Course created successfully!', 'success');
      addingCourse = false;
      await fetchCoursesFromDB();
      
      // If the course was created successfully, try to open the editor.
      // If the editor fails to open, fall back to the courses list.
      if (data.course && data.course._id) {
        openCourseEditor(data.course._id);
      } else {
        switchAdminTab('courses');
      }
    } else {
      showToast(data.message || 'Failed to create course.', 'error');
    }
  } catch {
    showToast('Server error.', 'error');
  }
}

function renderAdminAddProfessor() {
  const container = $('addProfessorFormContent');
  if (!container) return;

  container.innerHTML = `
    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-user-tie"></i> Basic Information</h3>
      <div class="editor-grid-2">
        <div class="form-group"><label>Full Name *</label><input type="text" id="newProfName" placeholder="e.g. Dr. S. K. Mehta" required></div>
        <div class="form-group"><label>Title / Role *</label><input type="text" id="newProfTitle" placeholder="e.g. Professor of Aerodynamics" required></div>
      </div>
      <div class="form-group"><label>Short Bio / Description</label><textarea id="newProfDescription" rows="4" placeholder="e.g. Ph.D. from MIT, specializing in computational fluid dynamics..."></textarea></div>
    </div>

    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-address-card"></i> Contact Details (Optional)</h3>
      <div class="editor-grid-2">
        <div class="form-group"><label>Email Address</label><input type="email" id="newProfEmail" placeholder="e.g. s.mehta@iitkgp.ac.in"></div>
        <div class="form-group"><label>Phone Number</label><input type="text" id="newProfPhone" placeholder="e.g. +91 98765 43210"></div>
        <div class="form-group"><label>Office Location</label><input type="text" id="newProfOffice" placeholder="e.g. Room 204, Aerospace Building"></div>
        <div class="form-group"><label>Department</label><input type="text" id="newProfDept" placeholder="e.g. Aerospace Engineering"></div>
      </div>
      <div class="form-group"><label>LinkedIn / Website URL</label><input type="url" id="newProfWebsite" placeholder="https://linkedin.com/in/..."></div>
    </div>

    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-image"></i> Profile Photo (Optional)</h3>
      <div class="thumbnail-editor">
        <div class="thumbnail-preview-empty" id="newProfPhotoPreview"><i class="fas fa-user-tie"></i><span>No photo selected</span></div>
        <div class="thumbnail-actions">
          <input type="file" id="newProfPhotoInput" accept="image/*" style="display:none;" onchange="previewProfPhoto(this)">
          <button class="btn btn-outline btn-sm" onclick="document.getElementById('newProfPhotoInput').click()"><i class="fas fa-upload"></i> Upload Photo</button>
        </div>
      </div>
    </div>
  `;
}

function previewProfPhoto(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) return showToast('Image too large (max 2 MB).', 'error');
  const reader = new FileReader();
  reader.onload = (e) => {
    const preview = $('newProfPhotoPreview');
    if (preview) preview.outerHTML = `<img src="${e.target.result}" class="thumbnail-preview" id="newProfPhotoPreview" alt="Preview">`;
  };
  reader.readAsDataURL(file);
}

async function saveNewProfessorPage() {
  const name = $('newProfName').value.trim();
  const title = $('newProfTitle').value.trim();
  if (!name || !title) return showToast('Name and Title are required.', 'error');

  const processSave = async (photoData) => {
    const payload = {
      name, title,
      description: $('newProfDescription').value.trim(),
      email: $('newProfEmail').value.trim(),
      phone: $('newProfPhone').value.trim(),
      office: $('newProfOffice').value.trim(),
      department: $('newProfDept').value.trim(),
      website: $('newProfWebsite').value.trim(),
      photo: photoData || ''
    };

    try {
      const res = await fetch(`${API_BASE}/professors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        showToast('✓ Professor added successfully!', 'success');
        addingProfessor = false;
        await fetchProfessorsFromDB(); // Fetch updated list from DB
        switchAdminTab('professors');
      } else {
        showToast(data.message || 'Failed to add professor.', 'error');
      }
    } catch (err) {
      showToast('Server error.', 'error');
    }
  };

  const photoInput = $('newProfPhotoInput');
  const photoFile = photoInput && photoInput.files ? photoInput.files[0] : null;
  
  if (photoFile) {
    const reader = new FileReader();
    reader.onload = ev => processSave(ev.target.result);
    reader.readAsDataURL(photoFile);
  } else {
    processSave(null);
  }
}

function renderAdminAddMaterial(courseId) {
  const container = $('addMaterialFormContent');
  if (!container) return;
  const course = findCourse(courseId);
  if (!course) return showToast('Course not found.', 'error');

  container.innerHTML = `
    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-info-circle"></i> Material Details</h3>
      <div class="editor-grid-2">
        <div class="form-group"><label>Title *</label><input type="text" id="newMatTitle" placeholder="e.g. Lecture 1: Introduction" required></div>
        <div class="form-group"><label>Type *</label>
          <select id="newMatType">
            <option value="video">🎬 Video Lecture</option>
            <option value="pyq">📄 Previous Year Question</option>
            <option value="tutorial">📝 Tutorial Sheet</option>
            <option value="slides">📊 Slides</option>
            <option value="other">📁 Other</option>
          </select>
        </div>
      </div>
      <div class="form-group"><label>Description</label><textarea id="newMatDescription" rows="3" placeholder="Brief description of the material..."></textarea></div>
    </div>

    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-link"></i> Content Source</h3>
      <div class="form-group"><label>External URL / YouTube Link (Optional)</label><input type="text" id="newMatUrl" placeholder="https://... or youtube.com/..."></div>
      <div class="form-group" style="margin-top:16px;">
        <label>Or Upload File (PDF, PPT, DOCX) (Optional)</label>
        <input type="file" id="newMatFile" style="margin-top:6px;">
        <span class="hint">Max file size: 10 MB. Uploading a file will override the URL.</span>
      </div>
    </div>

    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-cog"></i> Access & Settings</h3>
      <div class="editor-grid-3">
        <div class="form-group"><label>Access Level</label>
          <label class="toggle-box pro" style="margin-top:6px;"><input type="checkbox" id="newMatPremium" onchange="document.getElementById('newMatPriceGroup').style.display=this.checked?'block':'none'"><span><i class="fas fa-crown"></i> PRO Material</span></label>
        </div>
        <div class="form-group"><label>Estimated Time (Optional)</label><input type="text" id="newMatTime" placeholder="e.g. 45 mins"></div>
        <div class="form-group"><label>Tags (Optional)</label><input type="text" id="newMatTags" placeholder="e.g. aerodynamics, basics"></div>
      </div>
      <div class="form-group" id="newMatPriceGroup" style="display:none; margin-top:10px;">
        <label>Unlock Price (₹)</label><input type="number" id="newMatPrice" placeholder="e.g. 49" min="0" step="1">
      </div>
    </div>
  `;
}

async function saveNewMaterialPage() {
  const title = $('newMatTitle').value.trim();
  if (!title) return showToast('Title is required.', 'error');

  const courseId = addingMaterialCourseId;
  const fileInput = $('newMatFile');
  const file = fileInput && fileInput.files ? fileInput.files[0] : null;
  const isPremium = $('newMatPremium').checked;

  const processSave = async (fileData, fileName) => {
    const selectedType = $('newMatType').value;
    const customTypeEl = $('newMatCustomType');
    const resolvedType = resolveMaterialType(selectedType, customTypeEl ? customTypeEl.value : '');
    if (!resolvedType) {
      return showToast('Please enter a name for the custom material type.', 'error');
    }

    const payload = {
      title,
      type: resolvedType,
      description: $('newMatDescription').value.trim(),
      url: $('newMatUrl').value.trim(),
      isPremium: isPremium,
      price: isPremium ? (parseFloat($('newMatPrice').value) || 0) : 0,
      estimatedTime: $('newMatTime').value.trim(),
      tags: $('newMatTags').value.trim(),
      fileData: fileData || '',
      fileName: fileName || ''
    };

    try {
      const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/materials`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        showToast('📎 Material added successfully!', 'success');
        addingMaterialCourseId = null;
        await fetchCoursesFromDB();
        openCourseEditor(courseId);
      } else showToast(data.message || 'Failed to add material.', 'error');
    } catch { showToast('Server error.', 'error'); }
  };

  if (file) {
    if (file.size > 10 * 1024 * 1024) return showToast('File too large (max 10 MB).', 'error');
    const reader = new FileReader();
    reader.onload = ev => processSave(ev.target.result, file.name);
    reader.readAsDataURL(file);
  } else {
    processSave('', '');
  }
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
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifId })
      });
      const data = await res.json();
      if (data.success) {
        currentUser.notifications = data.notifications;
        saveSessionUser(currentUser);
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
      saveSessionUser(currentUser);
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
      saveSessionUser(currentUser);
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
  const pathMap = { courses: '#/courses', saved: '#/saved', analytics: '#/analytics', home: '#/home' };
  pushHash(pathMap[dest] || '#/home');
  studentNav = dest;
  renderApp();
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
  ['loginView', 'adminView', 'adminEditView', 'studentHomeView', 'studentCoursesView', 'studentSavedView', 'studentAnalyticsView', 'courseDetailView', 'adminAddCourseView', 'adminAddProfessorView', 'adminAddMaterialView', 'adminAddStudentView', 'adminQuizEditorView']
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
  if (quizEditingCourseId && quizEditingMaterialId && currentUser && currentUser.role === 'admin') {
    $('adminQuizEditorView').classList.add('active');
    renderQuizEditor();
    return;
  }
  if (addingCourse) {
    $('adminAddCourseView').classList.add('active');
    renderAdminAddCourse();
    return;
  }
  if (addingProfessor) {
    $('adminAddProfessorView').classList.add('active');
    renderAdminAddProfessor();
    return;
  }
  if (addingMaterialCourseId) {
    $('adminAddMaterialView').classList.add('active');
    renderAdminAddMaterial(addingMaterialCourseId);
    return;
  }
  if (addingStudent) {
    $('adminAddStudentView').classList.add('active');
    renderAdminAddStudent();
    return;
  }
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
  else if (studentNav === 'analytics') { $('studentAnalyticsView').classList.add('active'); renderStudentAnalytics(); }
  else { $('studentCoursesView').classList.add('active'); renderStudentCourses(); }
}

function buildNav() {
  if (currentUser.role === 'admin') {
    $('mainNav').innerHTML = `<a href="#" class="active" onclick="event.preventDefault();">Dashboard</a>`;
    return;
  }
  const homeActive      = (studentNav === 'home'      && !currentCourseId) ? 'active' : '';
  const coursesActive   = (studentNav === 'courses'   && !currentCourseId) ? 'active' : '';
  const savedActive     = (studentNav === 'saved'     && !currentCourseId) ? 'active' : '';
  const analyticsActive = (studentNav === 'analytics' && !currentCourseId) ? 'active' : '';
  const savedCount = (currentUser.bookmarks || []).length;
  $('mainNav').innerHTML = `
    <a href="#" class="${homeActive}" onclick="event.preventDefault();navigateStudent('home')"><i class="fas fa-house"></i> Home</a>
    <a href="#" class="${coursesActive}" onclick="event.preventDefault();navigateStudent('courses')"><i class="fas fa-graduation-cap"></i> Courses</a>
    <a href="#" class="${savedActive}" onclick="event.preventDefault();navigateStudent('saved')"><i class="fas fa-bookmark"></i> Saved${savedCount > 0 ? ' <span class="nav-count">' + savedCount + '</span>' : ''}</a>
    <a href="#" class="${analyticsActive}" onclick="event.preventDefault();navigateStudent('analytics')"><i class="fas fa-chart-line"></i> Analytics</a>
  `;
}

/* ============================================================
   ADMIN DASHBOARD
   ============================================================ */
function switchAdminTab(tab) {
  if (adminTab === 'students' && tab !== 'students') {
    _emailSelectedIds.clear();
  }
  adminTab = tab;
  
  // Reset ALL editing/adding states
  addingCourse = false;
  addingProfessor = false;
  addingMaterialCourseId = null;
  addingStudent = false;
  editingCourseId = null;
  currentCourseId = null;
  window.currentSelectedCourseId = null;
  
  pushHash(`#/admin/${tab}`);
  renderApp(); // Use renderApp instead of renderAdminDashboard for a clean slate
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
    overview:      { icon: 'fa-tachometer-alt', text: 'Admin Dashboard' },
    courses:       { icon: 'fa-graduation-cap', text: 'Manage Courses' },
    professors:    { icon: 'fa-user-tie',       text: 'Manage Professors' },
    students:      { icon: 'fa-user-graduate',  text: 'Manage Students' },
    replies:       { icon: 'fa-envelope-open-text', text: 'Email Replies' },
    subscriptions: { icon: 'fa-repeat',         text: 'Subscriptions & Auto-Pay' },
    security:      { icon: 'fa-shield-halved',  text: 'Admin Security' }
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
      <button class="btn btn-success" onclick="openStudentRegModal()"><i class="fas fa-user-plus"></i> <span class="btn-text">Register Student</span></button>`,
    replies: `
      <button class="btn btn-outline" onclick="switchAdminTab('overview')"><i class="fas fa-chart-pie"></i> <span class="btn-text">Overview</span></button>
      <button class="btn btn-primary" onclick="renderAdminEmailReplies()"><i class="fas fa-rotate"></i> <span class="btn-text">Refresh Replies</span></button>`,
    subscriptions: `
      <button class="btn btn-outline" onclick="switchAdminTab('overview')"><i class="fas fa-chart-pie"></i> <span class="btn-text">Overview</span></button>
      <button class="btn btn-primary" onclick="renderAdminSubscriptions()"><i class="fas fa-rotate"></i> <span class="btn-text">Refresh</span></button>`,
    security: `
      <button class="btn btn-outline" onclick="switchAdminTab('overview')"><i class="fas fa-chart-pie"></i> <span class="btn-text">Overview</span></button>`
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
  else if (adminTab === 'replies') renderAdminEmailReplies();
  else if (adminTab === 'subscriptions') renderAdminSubscriptions();
  else if (adminTab === 'security') renderAdminSecurityTab();
}

/* ============================================================
   ADMIN — SECURITY TAB (self-service credential management)
   ============================================================ */
function renderAdminSecurityTab() {
  const container = document.getElementById('adminSecurityContent');
  if (!container) return;

  const me = currentUser || {};
  const maskedEmail = (function mask(e) {
    if (!e) return '—';
    const [l, d] = String(e).split('@');
    if (!d) return e;
    return l.slice(0, 2) + '*'.repeat(Math.max(1, l.length - 2)) + '@' + d;
  })(me.email);

  container.innerHTML = `
    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-user-shield"></i> Account Summary</h3>
      <div class="editor-grid-2" style="margin-bottom:12px;">
        <div class="form-group">
          <label>Current Username</label>
          <input type="text" value="${escapeHtml(me.username || '')}" disabled>
        </div>
        <div class="form-group">
          <label>Registered Email (2FA destination)</label>
          <input type="text" value="${escapeHtml(maskedEmail)}" disabled>
          <span class="hint">All admin 2FA and recovery codes are sent here.</span>
        </div>
      </div>
    </div>

    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-at"></i> Change Username</h3>
      <p class="editor-hint">Your current password is required to confirm this change.</p>
      <div class="editor-grid-2">
        <div class="form-group">
          <label>Current Password *</label>
          <input type="password" id="secCurPwUsername" placeholder="Enter your current password" autocomplete="current-password">
        </div>
        <div class="form-group">
          <label>New Username *</label>
          <input type="text" id="secNewUsername" placeholder="3–30 chars: a-z 0-9 . _ -" autocomplete="off">
        </div>
      </div>
      <div class="editor-footer" style="position:static;box-shadow:none;padding:14px 0 0;border:none;background:none;">
        <div class="editor-footer-left">
          <span class="editor-hint"><i class="fas fa-lock"></i> You'll stay logged in after this change.</span>
        </div>
        <div class="editor-footer-right">
          <button class="btn btn-primary" onclick="updateAdminUsername()">
            <i class="fas fa-save"></i> Change Username
          </button>
        </div>
      </div>
    </div>

    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-key"></i> Change Password</h3>
      <p class="editor-hint">Minimum 8 characters, must contain at least one letter and one number.</p>
      <div class="editor-grid-2">
        <div class="form-group">
          <label>Current Password *</label>
          <input type="password" id="secCurPwPassword" placeholder="Enter your current password" autocomplete="current-password">
        </div>
        <div class="form-group">
          <label>New Password *</label>
          <input type="password" id="secNewPassword" placeholder="Min 8 chars, letter + number" autocomplete="new-password">
        </div>
        <div class="form-group">
          <label>Confirm New Password *</label>
          <input type="password" id="secNewPassword2" placeholder="Re-enter new password" autocomplete="new-password">
        </div>
      </div>
      <div class="editor-footer" style="position:static;box-shadow:none;padding:14px 0 0;border:none;background:none;">
        <div class="editor-footer-left">
          <span class="editor-hint"><i class="fas fa-envelope"></i> You'll receive a security alert email after the change.</span>
        </div>
        <div class="editor-footer-right">
          <button class="btn btn-primary" onclick="updateAdminPassword()">
            <i class="fas fa-shield-halved"></i> Change Password
          </button>
        </div>
      </div>
    </div>

    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-life-ring"></i> Account Recovery</h3>
      <p class="editor-hint">
        If you forget your username or password, use the login page links:
        <strong>Forgot Username?</strong> or <strong>Forgot Password?</strong>.
        Recovery OTPs are sent to <strong>${escapeHtml(maskedEmail)}</strong> only.
      </p>
    </div>
  `;
}

async function updateAdminUsername() {
  const currentPassword = ($('secCurPwUsername')?.value || '').trim();
  const newUsername = ($('secNewUsername')?.value || '').trim().toLowerCase();

  if (!currentPassword) return showToast('Enter your current password.', 'error');
  if (!newUsername) return showToast('Enter a new username.', 'error');
  if (newUsername === currentUser.username) return showToast('That is already your username.', 'info');

  try {
    const data = await fetchJSON(`${API_BASE}/admin/update-credentials`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminId: currentUser._id,
        currentPassword,
        newUsername
      })
    });
    if (data.success) {
      currentUser = data.user;
      saveSessionUser(currentUser);
      showToast('✅ Username changed.', 'success');
      renderAdminSecurityTab();
      renderApp();
    } else showToast(data.message || 'Failed.', 'error');
  } catch (err) {
    showToast(err.message || 'Server error.', 'error');
  }
}

async function updateAdminPassword() {
  const currentPassword = ($('secCurPwPassword')?.value || '').trim();
  const pw1 = ($('secNewPassword')?.value || '');
  const pw2 = ($('secNewPassword2')?.value || '');

  if (!currentPassword) return showToast('Enter your current password.', 'error');
  if (pw1.length < 8) return showToast('New password must be at least 8 characters.', 'error');
  if (!/[A-Za-z]/.test(pw1) || !/[0-9]/.test(pw1)) {
    return showToast('New password must contain at least one letter and one number.', 'error');
  }
  if (pw1 !== pw2) return showToast('New passwords do not match.', 'error');

  try {
    const data = await fetchJSON(`${API_BASE}/admin/update-credentials`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminId: currentUser._id,
        currentPassword,
        newPassword: pw1
      })
    });
    if (data.success) {
      currentUser = data.user;
      saveSessionUser(currentUser);
      ['secCurPwPassword', 'secNewPassword', 'secNewPassword2'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
      });
      showToast('✅ Password changed. Check your email for the security alert.', 'success');
      renderAdminSecurityTab();
    } else showToast(data.message || 'Failed.', 'error');
  } catch (err) {
    showToast(err.message || 'Server error.', 'error');
  }
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
    const plCount = (c.playlists || []).length;
    const statusBadge = c.status === 'draft'
      ? '<span class="status-badge draft">DRAFT — hidden from students</span>'
      : c.status === 'archived'
        ? '<span class="status-badge archived">ARCHIVED</span>'
        : '';
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

    const thumbHtml = c.thumbnail ? `<div class="course-thumb"><img src="${c.thumbnail}" alt="" loading="lazy"></div>` : '';

    html += `
      <div class="course-card ${c.thumbnail ? 'has-thumb' : ''}" style="${accentStyle(c.code || c.name)}">
        ${thumbHtml}
        <button class="delete-course-btn" onclick="event.stopPropagation();deleteCourse('${c.id}')" title="Delete" aria-label="Delete course"><i class="fas fa-trash-alt"></i></button>
        <div class="course-code">${escapeHtml(c.code) || 'N/A'} ${premiumLabel} ${statusBadge} ${featuredBadge}</div>
        <h3>${escapeHtml(c.name)}</h3>
        ${alertHtml}
        <div class="course-meta">
          <span><i class="fas fa-user"></i> ${escapeHtml(c.instructor) || '—'}</span>
          <span><i class="fas fa-calendar-alt"></i> ${escapeHtml(c.semester) || '—'}</span>
          ${c.category ? `<span><i class="fas fa-tag"></i> ${escapeHtml(c.category)}</span>` : ''}
        </div>
        <div class="material-count"><i class="fas fa-layer-group"></i> ${matCount} materials${plCount > 0 ? ` · <i class="fas fa-list"></i> ${plCount} playlist${plCount === 1 ? '' : 's'}` : ''}</div>
        <div class="card-actions">
          <button class="btn btn-warning btn-sm" onclick="event.stopPropagation();openCourseEditor('${c.id}')"><i class="fas fa-edit"></i> Edit</button>
          ${c.status === 'draft'
            ? `<button class="btn btn-success btn-sm" onclick="event.stopPropagation();publishCourse('${c.id}')"><i class="fas fa-rocket"></i> Publish</button>`
            : `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();viewCourseDetail('${c.id}')"><i class="fas fa-eye"></i> View</button>`}
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
      ? `<img src="${p.photo}" alt="${escapeHtml(p.name)}" loading="lazy">`
      : `<div class="avatar-placeholder"><i class="fas fa-user-tie"></i></div>`;

    let contactHtml = '';
    if (p.email) contactHtml += `<div class="prof-contact-item"><i class="fas fa-envelope"></i> ${escapeHtml(p.email)}</div>`;
    if (p.phone) contactHtml += `<div class="prof-contact-item"><i class="fas fa-phone"></i> ${escapeHtml(p.phone)}</div>`;
    if (p.office) contactHtml += `<div class="prof-contact-item"><i class="fas fa-map-marker-alt"></i> ${escapeHtml(p.office)}</div>`;

    html += `
      <div class="admin-professor-item">
        ${photoHtml}
        <div class="info">
          <h4>${escapeHtml(p.name)}</h4>
          <div class="title">${escapeHtml(p.title)}</div>
          <div class="desc">${escapeHtml(p.description) || ''}</div>
          ${contactHtml ? `<div class="prof-contact-block">${contactHtml}</div>` : ''}
        </div>
        <div class="actions">
<button class="btn btn-danger btn-sm" onclick="deleteProfessor('${p._id}')" title="Delete" aria-label="Delete professor">            <i class="fas fa-trash"></i>
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

    if (!data.success) throw new Error('Failed to load students');

    if (countEl) countEl.textContent = `${data.students.length} student${data.students.length === 1 ? '' : 's'}`;

    if (data.students.length === 0) {
      renderStudentSelectionBar(0, 0);
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

    const validIds = new Set(data.students.map(s => String(s._id)));
    Array.from(_emailSelectedIds).forEach(id => {
      if (!validIds.has(id)) _emailSelectedIds.delete(id);
    });

    const withEmail = data.students.filter(s => s.email && s.email.trim()).length;

    renderStudentSelectionBar(_emailSelectedIds.size, withEmail);

    let html = `<div class="student-grid">`;
    data.students.forEach(s => {
      const sid = String(s._id);
      const selected = _emailSelectedIds.has(sid);
      const hasEmail = !!(s.email && s.email.trim());
      const initials = (s.fullName || s.username || '?')
        .split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
      const created = s.createdAt
        ? new Date(s.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
        : '—';

      html += `
        <div class="student-card ${selected ? 'selected' : ''} ${!hasEmail ? 'no-email' : ''}" data-student-id="${sid}">
          <label class="student-select-checkbox" title="${hasEmail ? 'Select for email' : 'No email on file'}" onclick="event.stopPropagation();">
            <input type="checkbox"
                   ${selected ? 'checked' : ''}
                   ${!hasEmail ? 'disabled' : ''}
                   onchange="toggleStudentEmailSelection('${sid}', this.checked)">
            <span class="student-select-box"></span>
          </label>
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
              <span>${hasEmail
                ? escapeHtml(s.email)
                : '<em style="color:var(--text-tertiary);">No email — can\'t receive bulk mail</em>'}</span>
            </div>
            <div class="student-meta-row">
              <i class="fas fa-calendar-plus"></i>
              <span>Joined ${created}</span>
            </div>
          </div>
          <div class="student-card-actions">
            <button class="btn btn-outline btn-sm" onclick="resetStudentPassword('${sid}', '${escapeHtml(s.fullName || s.username).replace(/'/g, "\\'")}')">
              <i class="fas fa-key"></i> Reset Password
            </button>
            <button class="btn btn-danger btn-sm" onclick="deleteStudent('${sid}', '${escapeHtml(s.fullName || s.username).replace(/'/g, "\\'")}')">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </div>`;
    });
    html += `</div>`;
    container.innerHTML = html;
  } catch (err) {
    console.error('renderAdminStudents:', err);
    renderStudentSelectionBar(0, 0);
    container.innerHTML = `<div class="empty-state"><p style="color:var(--rose-500);">Error loading students.</p></div>`;
  }
}

async function renderAdminEmailReplies() {
  const container = $('adminEmailReplyList');
  if (!container) return;
  container.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>Loading replies...</p></div>`;

  try {
    const res = await fetch('https://aerospace-portal.onrender.com/api/admin/email-replies');
    const data = await res.json();
    
    const countEl = $('replyCountLabel');
    if (countEl) countEl.textContent = `${data.replies.length} repl${data.replies.length === 1 ? 'y' : 'ies'}`;

    if (data.replies.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-envelope-open-text"></i>
          <p>No email replies received yet.</p>
          <p style="margin-top:8px;font-size:13px;">When students reply to your bulk emails, they will appear here.</p>
        </div>`;
      return;
    }

    let html = `<div class="email-reply-list">`;
    data.replies.forEach(r => {
      const dateStr = new Date(r.date).toLocaleString('en-IN', { 
        day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' 
      });
      
      html += `
        <div class="email-reply-card">
          <div class="email-reply-header">
            <div class="email-reply-from">
              <i class="fas fa-user-circle"></i> 
              <strong>${escapeHtml(r.from)}</strong>
            </div>
            <div class="email-reply-date">${dateStr}</div>
          </div>
          <div class="email-reply-subject">
            <i class="fas fa-heading"></i> ${escapeHtml(r.subject)}
          </div>
          <div class="email-reply-body">
            ${escapeHtml(r.text).replace(/\n/g, '<br/>')}
          </div>
        </div>`;
    });
    html += `</div>`;
    container.innerHTML = html;

  } catch (err) {
    console.error('renderAdminEmailReplies:', err);
    container.innerHTML = `<div class="empty-state"><p style="color:var(--rose-500);">Error loading replies.</p></div>`;
  }
}
/* ============================================================
   ADMIN — SUBSCRIPTIONS DASHBOARD
   ============================================================ */
async function renderAdminSubscriptions() {
  const container = $('adminSubscriptionsContent');
  if (!container) return;
  container.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>Loading subscriptions…</p></div>`;

  let data;
  try {
    data = await fetchJSON(`${API_BASE}/admin/subscriptions?adminId=${currentUser._id}&t=${Date.now()}`);
  } catch (err) {
    console.error('renderAdminSubscriptions:', err);
    container.innerHTML = `
      <div class="empty-state" style="border-color:var(--rose-500);">
        <i class="fas fa-triangle-exclamation" style="color:var(--rose-500);opacity:.9;"></i>
        <p style="color:var(--rose-500);font-weight:600;">Could not load subscriptions</p>
        <p style="margin-top:8px;font-size:13px;max-width:560px;margin-left:auto;margin-right:auto;line-height:1.55;">${escapeHtml(err.message)}</p>
        <button class="btn btn-outline" style="margin-top:16px;" onclick="renderAdminSubscriptions()">
          <i class="fas fa-rotate"></i> Try Again
        </button>
      </div>`;
    return;
  }

  if (!data.success) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-triangle-exclamation" style="color:var(--rose-500);opacity:.9;"></i>
        <p style="color:var(--rose-500);font-weight:600;">${escapeHtml(data.message || 'Failed to load.')}</p>
      </div>`;
    return;
  }

  try {
    const s = data.settings;
    const subs = data.subscriptions || [];
    const activeCount = subs.filter(x => x.isActive).length;

    let html = `
      <div class="sub-settings-card">
        <h3><i class="fas fa-cog"></i> Global Subscription Settings</h3>
        <div class="sub-settings-grid">
          <div class="form-group">
            <label>Monthly Amount (₹)</label>
            <input type="number" id="subAmountInput" min="0" step="1" value="${s.amount}">
          </div>
          <div class="form-group">
            <label>Plan Title</label>
            <input type="text" id="subTitleInput" value="${escapeHtml(s.title)}" maxlength="60">
          </div>
        </div>
        <div class="form-group">
          <label>Description</label>
          <textarea id="subDescInput" rows="2" maxlength="240">${escapeHtml(s.description)}</textarea>
        </div>
        <div class="sub-toggle-row">
          <label>
            <input type="checkbox" id="subEnabledInput" ${s.enabled ? 'checked' : ''}>
            <span>Enable auto-pay for students</span>
          </label>
          <button class="btn btn-primary" onclick="saveSubscriptionSettings()">
            <i class="fas fa-save"></i> Save Settings
          </button>
        </div>
      </div>

      <div class="dash-header" style="margin-top:8px;">
        <h2 style="font-size:17px;">
          <i class="fas fa-users" style="background:rgba(99,102,241,.15);"></i>
          Subscribers (${activeCount} active / ${subs.length} total)
        </h2>
      </div>
    `;

    if (subs.length === 0) {
      html += `<div class="empty-state">
        <i class="fas fa-repeat"></i>
        <p>No students have subscribed yet.</p>
        <p style="margin-top:8px;font-size:13px;">They'll appear here once they start an auto-pay plan.</p>
      </div>`;
    } else {
      html += `<div class="subscriber-list">`;
      subs.forEach(u => {
        const sub = u.subscription || {};
        const initials = (u.fullName || u.username || '?')
          .split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
        const status = u.isActive ? 'active' :
          sub.status === 'pending' ? 'pending' :
          sub.status === 'halted' ? 'cancelled' : sub.status || 'expired';
        const expiresTxt = sub.expiresAt
          ? new Date(sub.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
          : '—';
        const daysTxt = (u.daysLeft === null || u.daysLeft === undefined)
          ? ''
          : (u.daysLeft > 0 ? `· ${u.daysLeft} day${u.daysLeft === 1 ? '' : 's'} left` : '· expired');

        html += `
          <div class="subscriber-row ${status}">
            <div class="subscriber-avatar">${initials}</div>
            <div class="subscriber-info">
              <h4>${escapeHtml(u.fullName || u.username)}</h4>
              <p>@${escapeHtml(u.username)} ${u.email ? '· ' + escapeHtml(u.email) : ''}</p>
            </div>
            <span class="subscriber-status ${status}">${status}</span>
            <span class="subscriber-meta">Until ${expiresTxt} ${daysTxt}</span>
            <div class="subscriber-actions">
              <button class="btn btn-outline btn-sm" onclick="adminGrantSubscription('${u._id}', 30)" title="Grant 30 days">
                <i class="fas fa-plus"></i> Grant
              </button>
              <button class="btn btn-outline btn-sm" onclick="adminExtendSubscription('${u._id}')" title="Extend">
                <i class="fas fa-clock"></i> Extend
              </button>
              ${u.isActive ? `<button class="btn btn-danger btn-sm" onclick="adminRevokeSubscription('${u._id}')" title="Revoke">
                <i class="fas fa-times"></i> Revoke
              </button>` : ''}
            </div>
          </div>`;
      });
      html += `</div>`;
    }

    container.innerHTML = html;
  } catch (err) {
    console.error('renderAdminSubscriptions:', err);
    container.innerHTML = `<div class="empty-state"><p style="color:var(--rose-500);">Error loading subscriptions: ${escapeHtml(err.message || 'unknown')}</p></div>`;
  }
}

async function saveSubscriptionSettings() {
  const amount = parseFloat($('subAmountInput').value) || 0;
  const title = $('subTitleInput').value.trim();
  const description = $('subDescInput').value.trim();
  const enabled = $('subEnabledInput').checked;

  if (amount <= 0) return showToast('Please enter a monthly amount greater than 0.', 'error');
  if (!title) return showToast('Plan title is required.', 'error');

  try {
    const data = await fetchJSON(`${API_BASE}/admin/settings/subscription`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminId: currentUser._id,
        amount, title, description, enabled
      })
    });
    if (data.success) {
      liveSubscriptionSettings = data.settings;
      showToast('✅ Subscription settings saved.', 'success');
      renderAdminSubscriptions();
    } else showToast(data.message || 'Failed.', 'error');
  } catch (err) {
    showToast(err.message || 'Server error.', 'error');
  }
}

async function adminGrantSubscription(userId, days) {
  if (!confirm(`Grant a ${days}-day subscription to this student?`)) return;
  try {
    const data = await fetchJSON(`${API_BASE}/admin/subscription/${userId}/grant`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: currentUser._id, days })
    });
    if (data.success) { showToast('✓ Subscription granted.', 'success'); renderAdminSubscriptions(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch (err) { showToast(err.message || 'Server error.', 'error'); }
}

async function adminExtendSubscription(userId) {
  const raw = prompt('Extend by how many days?', '30');
  if (raw === null) return;
  const days = parseInt(raw, 10);
  if (!days || days < 1) return showToast('Invalid number of days.', 'error');
  try {
    const data = await fetchJSON(`${API_BASE}/admin/subscription/${userId}/extend`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: currentUser._id, days })
    });
    if (data.success) { showToast('✓ Extended.', 'success'); renderAdminSubscriptions(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch (err) { showToast(err.message || 'Server error.', 'error'); }
}

async function adminRevokeSubscription(userId) {
  if (!confirm('Revoke this student\'s subscription? This will also cancel the Razorpay auto-pay.')) return;
  try {
    const data = await fetchJSON(`${API_BASE}/admin/subscription/${userId}/revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: currentUser._id })
    });
    if (data.success) { showToast('✓ Subscription revoked.', 'info'); renderAdminSubscriptions(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch (err) { showToast(err.message || 'Server error.', 'error'); }
}
/* ---- Selection helpers ---- */
function renderStudentSelectionBar(selectedCount, withEmailCount) {
  const bar = $('adminStudentSelectionBar');
  if (!bar) return;
  const hasSelection = selectedCount > 0;

  bar.innerHTML = `
    <label class="selection-master-checkbox" title="Select all students with an email">
      <input type="checkbox"
             id="selectAllStudentsBox"
             onchange="toggleSelectAllStudents(this.checked)">
      <span class="selection-master-label">Select all</span>
    </label>
    <div class="selection-bar-spacer"></div>
    <span class="selection-count">
      ${hasSelection
        ? `<strong>${selectedCount}</strong> selected`
        : `${withEmailCount} reachable by email`}
    </span>
    <button class="btn btn-primary btn-sm" onclick="openEmailStudentsModal()" ${!hasSelection ? 'disabled' : ''}>
      <i class="fas fa-paper-plane"></i> Send Email${hasSelection ? ' (' + selectedCount + ')' : ''}
    </button>
    ${hasSelection
      ? `<button class="btn btn-outline btn-sm" onclick="clearStudentSelection()">
           <i class="fas fa-times"></i> Clear
         </button>`
      : ''}
  `;

  const master = $('selectAllStudentsBox');
  if (master) {
    const allStudents = document.querySelectorAll('.student-card:not(.no-email)');
    master.checked = allStudents.length > 0 &&
      Array.from(allStudents).every(c => _emailSelectedIds.has(c.dataset.studentId));
    master.indeterminate = hasSelection &&
      !master.checked;
  }
}

function toggleStudentEmailSelection(studentId, isChecked) {
  if (isChecked) _emailSelectedIds.add(String(studentId));
  else _emailSelectedIds.delete(String(studentId));
  updateStudentSelectionUI();
}

function toggleSelectAllStudents(isChecked) {
  const cards = document.querySelectorAll('.student-card:not(.no-email)');
  cards.forEach(c => {
    const sid = c.dataset.studentId;
    if (isChecked) _emailSelectedIds.add(sid);
    else _emailSelectedIds.delete(sid);
  });
  updateStudentSelectionUI();
}

function clearStudentSelection() {
  _emailSelectedIds.clear();
  updateStudentSelectionUI();
}

function updateStudentSelectionUI() {
  document.querySelectorAll('.student-card').forEach(card => {
    const sid = card.dataset.studentId;
    const selected = _emailSelectedIds.has(sid);
    card.classList.toggle('selected', selected);
    const cb = card.querySelector('.student-select-checkbox input');
    if (cb && !cb.disabled) cb.checked = selected;
  });

  const allStudents = document.querySelectorAll('.student-card:not(.no-email)').length;
  renderStudentSelectionBar(_emailSelectedIds.size, allStudents);
}

/* ---- Open / send email modal ---- */
function openEmailStudentsModal() {
  if (_emailSelectedIds.size === 0) {
    return showToast('Select at least one student first.', 'info');
  }

  const modal = $('emailStudentsModal');
  if (!modal) return showToast('Email modal missing.', 'error');

  const selectedCards = Array.from(_emailSelectedIds)
    .map(id => document.querySelector(`.student-card[data-student-id="${id}"]`))
    .filter(Boolean);

  const names = selectedCards.map(card => {
    const h4 = card.querySelector('.student-card-info h4');
    return h4 ? h4.textContent.trim() : 'Student';
  });

  const preview = $('emailRecipientPreview');
  if (preview) {
    const MAX_CHIPS = 12;
    const shown = names.slice(0, MAX_CHIPS);
    const remaining = names.length - shown.length;
    preview.innerHTML =
      shown.map(n => `<span class="email-recipient-chip">${escapeHtml(n)}</span>`).join('') +
      (remaining > 0 ? `<span class="email-recipient-chip more">+ ${remaining} more</span>` : '');
  }

  const summary = $('emailModalRecipientSummary');
  if (summary) {
    summary.textContent = `To: ${_emailSelectedIds.size} student${_emailSelectedIds.size === 1 ? '' : 's'} — individually addressed, no BCC leaks.`;
  }

  const subjectEl = $('emailSubject');
  const bodyEl = $('emailBody');
  const submitBtn = $('emailSubmitBtn');
  const label = $('emailSubmitLabel');
  if (subjectEl) subjectEl.value = '';
  if (bodyEl) bodyEl.value = '';
  if (submitBtn) submitBtn.disabled = false;
  if (label) label.textContent = `Send to ${_emailSelectedIds.size}`;

  openModal('emailStudentsModal');
  setTimeout(() => subjectEl && subjectEl.focus(), 80);
}

async function sendBulkEmail(e) {
  if (e) e.preventDefault();

  const subject = $('emailSubject').value.trim();
  const body = $('emailBody').value.trim();

  if (!subject) return showToast('Subject is required.', 'error');
  if (!body) return showToast('Message body is required.', 'error');

  const recipientIds = Array.from(_emailSelectedIds);
  if (recipientIds.length === 0) return showToast('No recipients selected.', 'error');

  const confirmMsg = `Send this email to ${recipientIds.length} student${recipientIds.length === 1 ? '' : 's'}?\n\nSubject: ${subject}\n\nThis cannot be undone.`;
  if (!confirm(confirmMsg)) return;

  const btn = $('emailSubmitBtn');
  const label = $('emailSubmitLabel');
  const originalLabel = label ? label.textContent : 'Send Email';
  if (btn) btn.disabled = true;
  if (label) label.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Sending ${recipientIds.length} email${recipientIds.length === 1 ? '' : 's'}…`;

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 90000);

  try {
    const res = await fetch('https://aerospace-portal.onrender.com/api/admin/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        adminId: currentUser._id,
        recipientIds,
        subject,
        body
      })
    });

    clearTimeout(abortTimer);

    let data;
    const rawText = await res.text();
    try {
      data = JSON.parse(rawText);
    } catch {
      console.error('[bulk-email] Non-JSON response:', res.status, rawText.slice(0, 300));
      return showToast(`Server error (${res.status}). Try a smaller batch.`, 'error');
    }

    if (data.success) {
      closeModal('emailStudentsModal');
      clearStudentSelection();

      if (data.failed === 0 && data.skipped === 0) {
        showToast(`✅ ${data.message}`, 'success');
        return;
      }

      showEmailReport(data);
    } else {
      showToast(data.message || 'Failed to send email.', 'error');
    }
  } catch (err) {
    clearTimeout(abortTimer);
    if (err.name === 'AbortError') {
      showToast('Request timed out (90s). Try smaller batches.', 'error');
    } else {
      console.error('[bulk-email] Error:', err);
      showToast('Network error while sending.', 'error');
    }
  } finally {
    if (btn) btn.disabled = false;
    if (label) label.textContent = originalLabel;
  }
}

function showEmailReport(data) {
  const { sent, failed, skipped, total, failures } = data;

  const old = document.getElementById('emailReportModal');
  if (old) old.remove();

  const failureRows = (failures || []).map(f => `
    <div class="email-report-row error">
      <div class="email-report-row-icon"><i class="fas fa-circle-xmark"></i></div>
      <div class="email-report-row-body">
        <div class="email-report-row-title">${escapeHtml(f.name || 'Student')}</div>
        <div class="email-report-row-meta">${escapeHtml(f.email)}</div>
        <div class="email-report-row-error">${escapeHtml(f.error || 'Unknown error')}</div>
      </div>
    </div>
  `).join('');

  const el = document.createElement('div');
  el.id = 'emailReportModal';
  el.className = 'modal-overlay active';
  el.innerHTML = `
    <div class="modal-box email-report-modal">
      <div class="email-report-header">
        <div class="email-report-icon ${failed > 0 ? 'warn' : 'ok'}">
          <i class="fas ${failed > 0 ? 'fa-triangle-exclamation' : 'fa-check'}"></i>
        </div>
        <div>
          <h3>${failed > 0 ? 'Email Partially Sent' : 'Email Sent'}</h3>
          <p class="modal-sub" style="margin:4px 0 0;">${escapeHtml(data.message)}</p>
        </div>
      </div>

      <div class="email-report-stats">
        <div class="email-report-stat">
          <div class="num ok">${sent}</div>
          <div class="label">Sent</div>
        </div>
        <div class="email-report-stat">
          <div class="num skip">${skipped || 0}</div>
          <div class="label">Skipped</div>
        </div>
        <div class="email-report-stat">
          <div class="num bad">${failed || 0}</div>
          <div class="label">Failed</div>
        </div>
        <div class="email-report-stat">
          <div class="num">${total}</div>
          <div class="label">Total</div>
        </div>
      </div>

      ${failures && failures.length > 0 ? `
        <div class="email-report-section">
          <div class="email-report-section-title">
            <i class="fas fa-circle-xmark"></i> Which failed and why
          </div>
          <div class="email-report-list">${failureRows}</div>
        </div>
        <div class="email-report-hint">
          <i class="fas fa-lightbulb"></i>
          <div>
            <strong>How to fix:</strong> Check the "error" text on each row above. Common causes:
            <ul style="margin:6px 0 0 18px; padding:0;">
              <li><strong>550 / User unknown</strong> — email address is wrong</li>
              <li><strong>535 / Username and Password not accepted</strong> — server's Gmail App Password is expired</li>
              <li><strong>timed out</strong> — Gmail was slow; just retry</li>
              <li><strong>421 / Service not available</strong> — rate limited; wait 5 min</li>
            </ul>
          </div>
        </div>
      ` : ''}

      ${skipped > 0 ? `
        <div class="email-report-section">
          <div class="email-report-section-title">
            <i class="fas fa-user-slash"></i> Skipped (no email on file)
          </div>
          <p class="email-report-hint-text">${skipped} student${skipped === 1 ? '' : 's'} had no email address. Add their email via Edit → then retry.</p>
        </div>
      ` : ''}

      <div class="modal-actions">
        ${failures && failures.length > 0 ? `
          <button type="button" class="btn btn-outline" onclick="copyEmailFailures()">
            <i class="fas fa-copy"></i> Copy Failure List
          </button>
        ` : ''}
        <button type="button" class="btn btn-primary" onclick="document.getElementById('emailReportModal').remove()">
          <i class="fas fa-check"></i> Done
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(el);
  window.__lastEmailFailures = failures || [];

  el.addEventListener('click', (ev) => {
    if (ev.target === el) el.remove();
  });
}

async function copyEmailFailures() {
  const failures = window.__lastEmailFailures || [];
  if (failures.length === 0) return;
  const text = failures.map(f => `${f.name} <${f.email}> — ${f.error}`).join('\n');
  const ok = await copyToClipboard(text);
  showToast(ok ? '✓ Failure list copied.' : 'Copy failed.', ok ? 'success' : 'error');
}

async function checkEmailStatus() {
  try {
    const res = await fetch('https://aerospace-portal.onrender.com/api/admin/email-status');
    const data = await res.json();
    if (data.ready) {
      showToast(`✅ Email ready — sending as ${data.from}`, 'success');
    } else {
      showToast(`❌ ${data.message}`, 'error');
    }
    console.log('[email-status]', data);
  } catch (e) {
    showToast('Could not check email status.', 'error');
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

function showCredentialsCard(student) {
  const card = $('credentialsCard');
  if (!card) return;

  card.innerHTML = `
    <div class="cred-row">
      <div class="cred-label"><i class="fas fa-id-card"></i> Full Name</div>
      <div class="cred-value-group">
        <span class="cred-value">${escapeHtml(student.fullName)}</span>
        <button type="button" class="cred-copy-btn" onclick="copyCredential('name', '${escapeHtml(student.fullName).replace(/'/g, "\\'")}')" title="Copy" aria-label="Copy name">
          <i class="fas fa-copy"></i>
        </button>
      </div>
    </div>
    <div class="cred-row">
      <div class="cred-label"><i class="fas fa-at"></i> Username</div>
      <div class="cred-value-group">
        <span class="cred-value cred-code">${escapeHtml(student.username)}</span>
        <button type="button" class="cred-copy-btn" onclick="copyCredential('username', '${escapeHtml(student.username)}')" title="Copy" aria-label="Copy username">
          <i class="fas fa-copy"></i>
        </button>
      </div>
    </div>
    <div class="cred-row">
      <div class="cred-label"><i class="fas fa-key"></i> Password</div>
      <div class="cred-value-group">
        <span class="cred-value cred-code">${escapeHtml(student.password)}</span>
        <button type="button" class="cred-copy-btn" onclick="copyCredential('password', '${escapeHtml(student.password)}')" title="Copy" aria-label="Copy password">
          <i class="fas fa-copy"></i>
        </button>
      </div>
    </div>
    ${student.email ? `
    <div class="cred-row">
      <div class="cred-label"><i class="fas fa-envelope"></i> Email</div>
      <div class="cred-value-group">
        <span class="cred-value">${escapeHtml(student.email)}</span>
        <button type="button" class="cred-copy-btn" onclick="copyCredential('email', '${escapeHtml(student.email)}')" title="Copy" aria-label="Copy email">
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
  addingCourse = false;
  addingProfessor = false;
  addingMaterialCourseId = null;
  addingStudent = false;
  currentCourseId = null;
  window.currentSelectedCourseId = null;
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

  // Count total questions across all materials
  const totalQuestions = (course.materials || []).reduce((s, m) => s + ((m.quiz || []).length), 0);
  const quizzesCount = (course.materials || []).filter(m => (m.quiz || []).length > 0).length;

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
          <span><i class="fas fa-file-pen"></i> ${totalQuestions} question${totalQuestions === 1 ? '' : 's'} total</span>
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
      <button class="editor-tab ${editingTab === 'quizzes' ? 'active' : ''}" onclick="switchEditorTab('quizzes')">
        <i class="fas fa-file-pen"></i> Quizzes (${quizzesCount})
      </button>
      <button class="editor-tab ${editingTab === 'playlists' ? 'active' : ''}" onclick="switchEditorTab('playlists')">
        <i class="fas fa-list"></i> Playlists (${(course.playlists || []).length})
      </button>
      <button class="editor-tab ${editingTab === 'announcements' ? 'active' : ''}" onclick="switchEditorTab('announcements')">
        <i class="fas fa-bullhorn"></i> Announcements (${(course.announcements || []).length})
      </button>
    </div>
    <div class="editor-body">
  `;
  if (editingTab === 'details') html += renderEditorDetails(course);
  else if (editingTab === 'materials') html += renderEditorMaterials(course);
  else if (editingTab === 'quizzes') html += renderEditorQuizzes(course);
  else if (editingTab === 'playlists') html += renderEditorPlaylists(course);
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
        <div class="form-group"><label>Semester</label>
  <select id="edSemester">
    <option value="">Select Semester</option>
    ${[1,2,3,4,5,6,7,8,9,10].map(s => `<option value="${s}" ${String(course.semester) === String(s) ? 'selected' : ''}>Semester ${s}</option>`).join('')}
  </select>
</div>
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
        <div class="form-group"><label>Credits (Optional)</label>
          <input type="number" id="edCredits" value="${course.credits || 0}" min="0" step="1">
        </div>
        <div class="form-group"><label>Language (Optional)</label>
          <input type="text" id="edLanguage" value="${escapeHtml(course.language) || ''}" placeholder="e.g. English">
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
        ${course.thumbnail ? `<img src="${course.thumbnail}" class="thumbnail-preview" alt="" loading="lazy">` : '<div class="thumbnail-preview-empty"><i class="fas fa-image"></i><span>No thumbnail</span></div>'}
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
  const customGroupId = 'newMatInlineCustomGroup';

  let html = `
    <div class="editor-section">
      <div class="editor-section-header">
        <h3 class="editor-section-title"><i class="fas fa-layer-group"></i> Materials (${(course.materials || []).length})</h3>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn btn-outline btn-sm" onclick="switchEditorTab('quizzes')">
            <i class="fas fa-file-pen"></i> Manage Question Papers
          </button>
          <button class="btn btn-outline btn-sm" onclick="jumpToNewMaterialCard()">
            <i class="fas fa-arrow-down"></i> Go to Add Form
          </button>
        </div>
      </div>
      <p class="editor-hint">
        Click any material card below to expand and edit it.
        To attach a question paper, click the <strong>"Create Paper" / "Edit Paper"</strong> button right on the material's header row.
      </p>
    </div>

    <details class="material-editor material-editor-new" id="newMaterialInlineCard" open>
      <summary>
        <div class="me-summary-left">
          <span class="me-index">＋</span>
          <span class="mat-type">NEW</span>
          <strong>Add a new material</strong>
        </div>
        <div class="me-summary-right"><i class="fas fa-chevron-down me-chevron"></i></div>
      </summary>
      <div class="me-body">
        <div class="editor-grid-2">
          <div class="form-group">
            <label>Title *</label>
            <input type="text" id="newMatInlineTitle" placeholder="e.g. Lecture 1: Introduction" autocomplete="off">
          </div>
          <div class="form-group">
            <label>Type *</label>
            <select id="newMatInlineType" onchange="handleMaterialTypeChange(this, '${customGroupId}')">
              <option value="video">🎬 Video Lecture</option>
              <option value="pyq">📄 Previous Year Question</option>
              <option value="tutorial">📝 Tutorial Sheet</option>
              <option value="slides">📊 Slides</option>
              <option value="other" selected>📁 Other</option>
              <option value="__custom__">✨ Custom Type…</option>
            </select>
            <div id="${customGroupId}" style="display:none; margin-top:8px;">
              <input type="text" id="newMatInlineCustomType"
                     placeholder="e.g. Lab Manual, Assignment, Notes" maxlength="40" autocomplete="off">
              <span class="hint">Type any name — it becomes its own filter tab on the course page.</span>
            </div>
          </div>
        </div>

        <div class="form-group">
          <label>Description</label>
          <textarea id="newMatInlineDescription" rows="2" placeholder="Brief description of this material…"></textarea>
        </div>

        <div class="form-group">
          <label>External URL / YouTube Link (Optional)</label>
          <input type="text" id="newMatInlineUrl" placeholder="https://... or youtube.com/...">
        </div>

        <div class="me-file-section">
          <label>Or Upload File (PDF, PPT, DOCX) — Optional · max 10 MB</label>
          <input type="file" id="newMatInlineFile">
        </div>

        <div class="editor-grid-2">
          <div class="form-group">
            <label>Access Level</label>
            <label class="toggle-box pro" style="margin-top:6px;">
              <input type="checkbox" id="newMatInlinePremium">
              <span><i class="fas fa-crown"></i> PRO Material</span>
            </label>
          </div>
          <div class="form-group">
            <label>Price (₹) — only if PRO</label>
            <input type="number" id="newMatInlinePrice" value="0" min="0" step="1">
          </div>
        </div>

        <div class="me-actions">
          <button class="btn btn-outline btn-sm" onclick="resetNewMaterialInlineForm()">
            <i class="fas fa-rotate-left"></i> Clear Form
          </button>
          <button class="btn btn-primary" id="newMatInlineSubmitBtn" onclick="saveNewMaterialInline('${course.id}')">
            <i class="fas fa-plus-circle"></i> Add This Material
          </button>
        </div>
      </div>
    </details>
  `;

  if (!course.materials || course.materials.length === 0) {
    html += `<div class="empty-state" style="margin-top:16px;">
      <i class="fas fa-layer-group"></i>
      <p>No materials yet — use the green card above to add your first one.</p>
    </div>`;
    return html;
  }

  course.materials.forEach((m, idx) => {
    html += renderMaterialEditorCard(course.id, m, idx);
  });

  return html;
}
/* ============================================================
   COURSE EDITOR — "Quizzes" tab
   Lists every material with its quiz status + prominent buttons
   ============================================================ */
function renderEditorQuizzes(course) {
  const materials = course.materials || [];

  if (materials.length === 0) {
    return `
      <div class="empty-state">
        <i class="fas fa-file-pen"></i>
        <p>No materials in this course yet.</p>
        <p style="margin-top:8px;font-size:13px;">Add at least one material first, then you can attach a question paper to it.</p>
        <button class="btn btn-primary" style="margin-top:16px;" onclick="switchEditorTab('materials')">
          <i class="fas fa-layer-group"></i> Go to Materials
        </button>
      </div>`;
  }

  let totalQuestions = 0;
  let totalPapers = 0;
  let totalMarks = 0;

  let html = `
    <div class="editor-section">
      <div class="editor-section-header">
        <div class="editor-section-title">
          <i class="fas fa-file-pen"></i> Question Papers &amp; Tests
        </div>
      </div>
      <p class="editor-hint">
        Each material can have its own question paper (test). Click <strong>Create Paper</strong>
        next to any material below to open the full-page editor where you can add
        single-correct, multiple-correct, integer, or matrix-match questions with full LaTeX support.
      </p>
    </div>
  `;

  materials.forEach((m, idx) => {
    const quizCount = (m.quiz || []).length;
    const cfg = m.examConfig || {};
    const paperMarks = (m.quiz || []).reduce((s, q) => s + (Number(q.marks) || 0), 0);

    totalQuestions += quizCount;
    totalMarks += paperMarks;
    if (quizCount > 0) totalPapers++;

    const hasQuiz = quizCount > 0;
    const statusChip = hasQuiz
      ? `<span class="status-badge published">${quizCount} QUESTION${quizCount === 1 ? '' : 'S'}</span>`
      : `<span class="status-badge draft">NO PAPER YET</span>`;

    html += `
      <div class="quiz-overview-card">
        <div class="quiz-overview-left">
          <div class="quiz-overview-icon ${hasQuiz ? 'has-quiz' : 'no-quiz'}">
            <i class="fas ${hasQuiz ? 'fa-file-circle-check' : 'fa-file-circle-plus'}"></i>
          </div>
          <div class="quiz-overview-info">
            <div class="quiz-overview-title">
              <span class="mat-type ${materialTypeSlug(m.type)}" style="margin-right:8px;">${escapeHtml(String(m.type || 'other').toUpperCase())}</span>
              ${escapeHtml(m.title)}
            </div>
            <div class="quiz-overview-meta">
              ${statusChip}
              ${cfg.subject ? `<span class="chip"><i class="fas fa-book"></i> ${escapeHtml(cfg.subject)}</span>` : ''}
              ${cfg.paperCode ? `<span class="chip"><i class="fas fa-hashtag"></i> ${escapeHtml(cfg.paperCode)}</span>` : ''}
              ${cfg.totalTime ? `<span class="chip"><i class="fas fa-clock"></i> ${escapeHtml(cfg.totalTime)}</span>` : ''}
              ${hasQuiz ? `<span class="chip"><i class="fas fa-star"></i> ${paperMarks || cfg.totalMarks || 0} marks</span>` : ''}
            </div>
          </div>
        </div>
        <div class="quiz-overview-actions">
          ${hasQuiz ? `
            <button class="btn btn-outline btn-sm" onclick="openQuizPlayer('${course.id}', '${m.id}')" title="Preview as student">
              <i class="fas fa-eye"></i> Preview
            </button>
          ` : ''}
          <button class="btn ${hasQuiz ? 'btn-warning' : 'btn-success'}" onclick="openQuizEditor('${course.id}', '${m.id}')">
            <i class="fas fa-file-pen"></i>
            ${hasQuiz ? 'Edit Paper' : 'Create Paper'}
          </button>
        </div>
      </div>
    `;
  });

  html += `
    <div class="editor-section" style="margin-top:16px;">
      <div class="quiz-summary-tiles">
        <div class="quiz-summary-tile">
          <div class="quiz-summary-num">${totalPapers}</div>
          <div class="quiz-summary-lbl">Papers Created</div>
        </div>
        <div class="quiz-summary-tile">
          <div class="quiz-summary-num">${totalQuestions}</div>
          <div class="quiz-summary-lbl">Total Questions</div>
        </div>
        <div class="quiz-summary-tile">
          <div class="quiz-summary-num">${totalMarks}</div>
          <div class="quiz-summary-lbl">Total Marks</div>
        </div>
      </div>
    </div>
  `;

  return html;
}

function renderMaterialEditorCard(courseId, m, idx) {
  const quizCount = (m.quiz || []).length;
  const customId = 'meCustom-' + m.id;
  const isCustom = !isKnownMaterialType(m.type);

  return `
    <details class="material-editor" data-mat-id="${m.id}">
      <summary>
        <div class="me-summary-left">
          <span class="me-index">#${idx + 1}</span>
          <span class="mat-type ${materialTypeSlug(m.type)}">${escapeHtml(String(m.type || 'other').toUpperCase())}</span>
          <strong>${escapeHtml(m.title)}</strong>
          ${m.isPremium ? `<span class="mat-badge premium"><i class="fas fa-crown"></i> PRO</span>` : '<span class="mat-badge free">FREE</span>'}
          ${quizCount > 0
            ? `<span class="mat-quiz-badge"><i class="fas fa-file-pen"></i> ${quizCount} question${quizCount === 1 ? '' : 's'}</span>`
            : `<span class="mat-quiz-badge empty"><i class="fas fa-file-circle-plus"></i> No paper</span>`}
        </div>
        <div class="me-summary-right" style="gap:8px;">
          <button type="button"
                  class="btn btn-sm ${quizCount > 0 ? 'btn-warning' : 'btn-success'}"
                  onclick="event.preventDefault(); event.stopPropagation(); openQuizEditor('${courseId}', '${m.id}');"
                  title="${quizCount > 0 ? 'Edit this question paper' : 'Create a question paper for this material'}">
            <i class="fas fa-file-pen"></i> ${quizCount > 0 ? 'Edit Paper' : 'Create Paper'}
          </button>
          <i class="fas fa-chevron-down me-chevron"></i>
        </div>
      </summary>
      <div class="me-body">
        <div class="editor-grid-2">
          <div class="form-group"><label>Title</label><input type="text" class="me-title" value="${escapeHtml(m.title)}"></div>
          <div class="form-group"><label>Type</label>
            <select class="me-type" onchange="handleMaterialTypeChange(this, '${customId}')">
              <option value="video" ${m.type === 'video' ? 'selected' : ''}>🎬 Video</option>
              <option value="pyq" ${m.type === 'pyq' ? 'selected' : ''}>📄 PYQ</option>
              <option value="tutorial" ${m.type === 'tutorial' ? 'selected' : ''}>📝 Tutorial</option>
              <option value="slides" ${m.type === 'slides' ? 'selected' : ''}>📊 Slides</option>
              <option value="other" ${m.type === 'other' ? 'selected' : ''}>📁 Other</option>
              <option value="__custom__" ${isCustom ? 'selected' : ''}>✨ Custom Type…</option>
            </select>
            <div id="${customId}" style="display:${isCustom ? 'block' : 'none'}; margin-top:8px;">
              <input type="text" class="me-custom-type" placeholder="e.g. Lab Manual, Assignment" maxlength="40" autocomplete="off" value="${isCustom ? escapeHtml(m.type) : ''}">
            </div>
          </div>
        </div>
        <div class="form-group"><label>Description</label><textarea class="me-desc" rows="2">${escapeHtml(m.description) || ''}</textarea></div>
        <div class="form-group"><label>Link</label><input type="text" class="me-url" value="${escapeHtml(m.url) || ''}"></div>
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
            <h4><i class="fas fa-file-pen"></i> Question Paper (${quizCount} question${quizCount === 1 ? '' : 's'})</h4>
            <button class="btn ${quizCount > 0 ? 'btn-warning' : 'btn-accent'} btn-sm"
                    onclick="openQuizEditor('${courseId}', '${m.id}')">
              <i class="fas fa-pen"></i> ${quizCount > 0 ? 'Edit Paper' : 'Create Paper'}
            </button>
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
          <button class="ann-delete" onclick="deleteAnnouncement('${course.id}', '${a.id}')" aria-label="Delete announcement"><i class="fas fa-trash-alt"></i></button>
        </div>
        ${a.body ? `<p class="ann-body">${escapeHtml(a.body)}</p>` : ''}
      </div>`;
    });
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

/* ============================================================
   ADMIN — PLAYLIST EDITOR
   ============================================================ */
function renderEditorPlaylists(course) {
  const playlists = course.playlists || [];
  const videoMaterials = (course.materials || []).filter(m => m.type === 'video' && (m.url || m.fileData));

  let html = `
    <div class="editor-section">
      <div class="editor-section-header">
        <h3 class="editor-section-title"><i class="fas fa-list"></i> Playlists (${playlists.length})</h3>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn btn-outline" onclick="autoGeneratePlaylist('${course.id}')">
            <i class="fas fa-wand-magic-sparkles"></i>
            Auto-create from ${videoMaterials.length} video${videoMaterials.length === 1 ? '' : 's'}
          </button>
          <button class="btn btn-success" onclick="openCreatePlaylistModal('${course.id}')">
            <i class="fas fa-plus"></i> New Playlist
          </button>
        </div>
      </div>
      <p class="editor-hint">Group video lectures into named playlists. Students can then watch them in sequence with auto-advance.</p>
    </div>
  `;

  if (playlists.length === 0) {
    html += `
      <div class="empty-state">
        <i class="fas fa-list"></i>
        <p>No playlists yet.</p>
        <p style="margin-top:8px;font-size:13px;">Click <strong>Auto-create from videos</strong> to bundle every video lecture, or <strong>New Playlist</strong> to build one manually.</p>
      </div>`;
    return html;
  }

  playlists.forEach(pl => {
    const items = pl.materialIds
      .map(id => (course.materials || []).find(m => m.id === id))
      .filter(Boolean);

    const availableVideos = videoMaterials.filter(m => !pl.materialIds.includes(m.id));

    html += `
      <div class="playlist-editor-card">
        <div class="playlist-editor-header">
          <div class="playlist-editor-info">
            <h4><i class="fas fa-list"></i> ${escapeHtml(pl.title)}</h4>
            ${pl.description ? `<p class="playlist-editor-desc">${escapeHtml(pl.description)}</p>` : ''}
            <span class="playlist-editor-meta">${items.length} video${items.length === 1 ? '' : 's'}</span>
          </div>
          <div class="playlist-editor-actions">
            <button class="btn btn-outline btn-sm" onclick="renamePlaylist('${course.id}', '${pl.id}')">
              <i class="fas fa-pen"></i> Rename
            </button>
            <button class="btn btn-danger btn-sm" onclick="deletePlaylist('${course.id}', '${pl.id}')">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </div>

        <div class="playlist-items-list">
          ${items.length === 0
            ? '<p class="playlist-empty-note">No videos in this playlist yet.</p>'
            : items.map((m, idx) => `
              <div class="playlist-item-row">
                <span class="playlist-item-index">${idx + 1}</span>
                <span class="playlist-item-title">${escapeHtml(m.title)}</span>
                <button class="playlist-item-remove" onclick="removeVideoFromPlaylist('${course.id}', '${pl.id}', '${m.id}')" title="Remove from playlist" aria-label="Remove from playlist">
                  <i class="fas fa-times"></i>
                </button>
              </div>
            `).join('')}
        </div>

        ${availableVideos.length > 0 ? `
          <div class="playlist-add-row">
            <select class="playlist-add-select" id="playlistAdd-${pl.id}">
              <option value="">— Select a video to add —</option>
              ${availableVideos.map(m => `<option value="${m.id}">${escapeHtml(m.title)}</option>`).join('')}
            </select>
            <button class="btn btn-primary btn-sm" onclick="addSelectedVideoToPlaylist('${course.id}', '${pl.id}')">
              <i class="fas fa-plus"></i> Add
            </button>
          </div>` : ''}
      </div>
    `;
  });
  return html;
}

function openCreatePlaylistModal(courseId) {
  const course = findCourse(courseId);
  if (!course) return;
  const videoMaterials = (course.materials || []).filter(m => m.type === 'video' && (m.url || m.fileData));

  const modal = document.getElementById('playlistModal');
  if (!modal) return showToast('Playlist modal missing.', 'error');

  $('playlistCourseId').value = courseId;
  $('playlistTitle').value = '';
  $('playlistDescription').value = '';

  const checklist = $('playlistVideoChecklist');
  if (checklist) {
    if (videoMaterials.length === 0) {
      checklist.innerHTML = '<p class="playlist-empty-note">No video materials yet. Add videos first.</p>';
    } else {
      checklist.innerHTML = videoMaterials.map(m => `
        <label class="playlist-checkbox-row">
          <input type="checkbox" value="${m.id}" checked>
          <span>${escapeHtml(m.title)}</span>
        </label>
      `).join('');
    }
  }

  openModal('playlistModal');
}

async function savePlaylistFromModal(e) {
  if (e) e.preventDefault();
  const courseId = $('playlistCourseId').value;
  const title = $('playlistTitle').value.trim();
  const description = $('playlistDescription').value.trim();
  if (!title) return showToast('Playlist title is required.', 'error');

  const checkboxes = document.querySelectorAll('#playlistVideoChecklist input[type="checkbox"]:checked');
  const materialIds = Array.from(checkboxes).map(cb => cb.value);

  const btn = $('playlistSubmitBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...'; }

  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/playlists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description, materialIds })
    });
    const data = await res.json();
    if (data.success) {
      showToast('✓ Playlist created!', 'success');
      closeModal('playlistModal');
      await fetchCoursesFromDB();
    } else {
      showToast(data.message || 'Failed.', 'error');
    }
  } catch { showToast('Server error.', 'error'); }
  finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-plus"></i> Create Playlist'; }
  }
}

async function autoGeneratePlaylist(courseId) {
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/playlists/auto-videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'All Video Lectures' })
    });
    const data = await res.json();
    if (data.success) {
      showToast('✓ ' + data.message, 'success');
      await fetchCoursesFromDB();
    } else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

async function renamePlaylist(courseId, playlistId) {
  const course = findCourse(courseId);
  const pl = (course.playlists || []).find(p => p.id === playlistId);
  if (!pl) return;
  const newTitle = prompt('Rename playlist:', pl.title);
  if (newTitle === null) return;
  if (!newTitle.trim()) return showToast('Title cannot be empty.', 'error');
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/playlists/${playlistId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim() })
    });
    const data = await res.json();
    if (data.success) { showToast('✓ Renamed.', 'success'); await fetchCoursesFromDB(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

async function deletePlaylist(courseId, playlistId) {
  if (!confirm('Delete this playlist? The videos in it will NOT be deleted from the course.')) return;
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/playlists/${playlistId}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) { showToast('Playlist deleted.', 'info'); await fetchCoursesFromDB(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

async function addSelectedVideoToPlaylist(courseId, playlistId) {
  const sel = document.getElementById('playlistAdd-' + playlistId);
  if (!sel || !sel.value) return showToast('Pick a video first.', 'info');
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/playlists/${playlistId}/materials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ materialId: sel.value })
    });
    const data = await res.json();
    if (data.success) { showToast('✓ Added.', 'success'); await fetchCoursesFromDB(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

async function removeVideoFromPlaylist(courseId, playlistId, materialId) {
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}/playlists/${playlistId}/materials/${materialId}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) { showToast('Removed.', 'info'); await fetchCoursesFromDB(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

/* ============================================================
   COURSE / MATERIAL CRUD
   ============================================================ */
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
    credits: parseInt($('edCredits').value) || 0,
    language: $('edLanguage').value.trim(),
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

  const selectedType = el.querySelector('.me-type').value;
  const customTypeEl = el.querySelector('.me-custom-type');
  const resolvedType = resolveMaterialType(selectedType, customTypeEl ? customTypeEl.value : '');
  if (!resolvedType) {
    return showToast('Please enter a name for the custom material type.', 'error');
  }

  const payload = {
    title: el.querySelector('.me-title').value.trim(),
    type: resolvedType,
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
/* ============================================================
   INLINE "NEW MATERIAL" — used by the green card in course editor
   ============================================================ */
function jumpToNewMaterialCard() {
  const el = document.getElementById('newMaterialInlineCard');
  if (!el) return;
  el.setAttribute('open', '');
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2200);
  const titleEl = document.getElementById('newMatInlineTitle');
  if (titleEl) setTimeout(() => titleEl.focus(), 350);
}

function resetNewMaterialInlineForm() {
  const ids = [
    'newMatInlineTitle', 'newMatInlineDescription', 'newMatInlineUrl',
    'newMatInlineCustomType'
  ];
  ids.forEach(id => { const el = $(id); if (el) el.value = ''; });

  const priceEl = $('newMatInlinePrice');
  if (priceEl) priceEl.value = '0';
  const premEl = $('newMatInlinePremium');
  if (premEl) premEl.checked = false;
  const fileEl = $('newMatInlineFile');
  if (fileEl) fileEl.value = '';
  const typeEl = $('newMatInlineType');
  if (typeEl) typeEl.value = 'other';

  const grp = $('newMatInlineCustomGroup');
  if (grp) grp.style.display = 'none';
}

async function saveNewMaterialInline(courseId) {
  const titleEl = $('newMatInlineTitle');
  const typeEl = $('newMatInlineType');
  const customEl = $('newMatInlineCustomType');
  const descEl = $('newMatInlineDescription');
  const urlEl = $('newMatInlineUrl');
  const premEl = $('newMatInlinePremium');
  const priceEl = $('newMatInlinePrice');
  const fileEl = $('newMatInlineFile');
  const btn = $('newMatInlineSubmitBtn');

  const title = titleEl ? titleEl.value.trim() : '';
  if (!title) {
    showToast('Please enter a title for the new material.', 'error');
    if (titleEl) titleEl.focus();
    return;
  }

  const resolvedType = resolveMaterialType(
    typeEl ? typeEl.value : 'other',
    customEl ? customEl.value : ''
  );
  if (!resolvedType) {
    showToast('Please enter a name for the custom material type.', 'error');
    if (customEl) customEl.focus();
    return;
  }

  const isPremium = premEl ? premEl.checked : false;
  const price = isPremium ? (parseFloat(priceEl ? priceEl.value : '0') || 0) : 0;
  const file = fileEl && fileEl.files ? fileEl.files[0] : null;

  const doSave = async (fileData, fileName) => {
    const payload = {
      title,
      type: resolvedType,
      description: descEl ? descEl.value.trim() : '',
      url: urlEl ? urlEl.value.trim() : '',
      isPremium,
      price,
      fileData: fileData || '',
      fileName: fileName || ''
    };

    try {
      const res = await fetch(
        `https://aerospace-portal.onrender.com/api/courses/${courseId}/materials`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }
      );
      const data = await res.json();
      if (data.success) {
        showToast('📎 Material added!', 'success');
        resetNewMaterialInlineForm();
        await fetchCoursesFromDB();
      } else {
        showToast(data.message || 'Failed to add material.', 'error');
      }
    } catch {
      showToast('Server error while adding material.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-plus-circle"></i> Add This Material';
      }
    }
  };

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding…';
  }

  if (file) {
    if (file.size > 10 * 1024 * 1024) {
      showToast('File too large (max 10 MB).', 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-plus-circle"></i> Add This Material'; }
      return;
    }
    const reader = new FileReader();
    reader.onload = ev => doSave(ev.target.result, file.name);
    reader.readAsDataURL(file);
  } else {
    doSave('', '');
  }
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
  renderSubscriptionBanner();
  renderStreakCard();
  renderContinueCard();

  const professors = getProfessors();
  if (professors.length === 0) {
    $('professorsGrid').innerHTML = `<p style="color:var(--text-tertiary);">No professors added yet.</p>`;
  } else {
    let html = '';
    professors.forEach(p => {
      const photoHtml = p.photo
        ? `<img src="${p.photo}" alt="${escapeHtml(p.name)}" class="professor-avatar" loading="lazy">`
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
   SUBSCRIPTION — STUDENT UI
   ============================================================ */
function renderSubscriptionBanner() {
  const host = document.getElementById('streakCardContainer');
  // We reuse streakCardContainer's parent area by injecting a sibling right above it.
  // Simpler approach: inject into a dedicated div in index.html if present,
  // otherwise append before the streak container.
  const anchor = document.getElementById('streakCardContainer');
  if (!anchor) return;

  // Remove existing banner if re-rendering
  const existing = document.getElementById('subscribeBannerHost');
  if (existing) existing.remove();

  if (currentUser.role !== 'student') return;
  if (!liveSubscriptionSettings.enabled) return;

  const wrap = document.createElement('div');
  wrap.id = 'subscribeBannerHost';

  if (currentUser.isSubscribed) {
    const exp = currentUser.subscription?.expiresAt
      ? new Date(currentUser.subscription.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : '—';
    wrap.innerHTML = `
      <div class="subscribe-active-banner">
        <div class="subscribe-active-icon"><i class="fas fa-check-circle"></i></div>
        <div class="subscribe-active-info">
          <h4>All-Access subscription active</h4>
          <p>Unlocked every course · Renews on <strong>${exp}</strong> · ₹${currentUser.subscription?.amount || liveSubscriptionSettings.amount}/month</p>
        </div>
        <button class="btn btn-outline btn-sm" onclick="cancelSubscription()">
          <i class="fas fa-times"></i> Cancel Auto-Pay
        </button>
      </div>`;
  } else {
    wrap.innerHTML = `
      <div class="subscribe-banner">
        <div class="subscribe-banner-icon"><i class="fas fa-bolt"></i></div>
        <div class="subscribe-banner-info">
          <h4>${escapeHtml(liveSubscriptionSettings.title)}</h4>
          <p>${escapeHtml(liveSubscriptionSettings.description)} — <strong>₹${liveSubscriptionSettings.amount}/month</strong></p>
        </div>
        <button class="btn btn-primary" onclick="startSubscriptionCheckout()">
          <i class="fas fa-repeat"></i> Subscribe
        </button>
      </div>`;
  }

  anchor.parentNode.insertBefore(wrap, anchor);
}

async function startSubscriptionCheckout() {
  if (!currentUser || currentUser.role !== 'student') {
    return showToast('Please log in as a student first.', 'error');
  }
  if (currentUser.isSubscribed) return showToast('You already have an active subscription.', 'info');
  if (!liveSubscriptionSettings.enabled) return showToast('Subscription is not available right now.', 'error');

  showToast('Preparing subscription…', 'info');
  try {
    const res = await fetch(`${API_BASE}/subscribe/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser._id })
    });
    const data = await res.json();
    if (!data.success) return showToast(data.message || 'Could not start subscription.', 'error');

    const rzp = new Razorpay({
      key: data.key_id,
      subscription_id: data.subscriptionId,
      name: 'Aerospace Department',
      description: data.title + ' — ₹' + data.amount + '/month',
      prefill: {
        name: currentUser.fullName || currentUser.username,
        email: currentUser.email || 'student@aerospace.com',
        contact: '9999999999'
      },
      theme: { color: '#4f46e5' },
      handler: async function (response) {
        showToast('Verifying subscription…', 'info');
        try {
          const vres = await fetch(`${API_BASE}/subscribe/verify`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: currentUser._id,
              razorpay_subscription_id: response.razorpay_subscription_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature
            })
          });
          const vdata = await vres.json();
          if (vdata.success) {
            currentUser = vdata.user;
            saveSessionUser(currentUser);
            showToast('🎉 Subscription activated! All courses unlocked.', 'success');
            renderApp();
          } else {
            showToast(vdata.message || 'Verification failed.', 'error');
          }
        } catch {
          showToast('Verification failed — please contact support.', 'error');
        }
      },
      modal: {
        ondismiss: function () {
          showToast('Subscription cancelled.', 'info');
        }
      }
    });
    rzp.open();
  } catch (e) {
    showToast('Could not start subscription.', 'error');
  }
}

/* ============================================================
   SUBSCRIPTION CANCELLATION — OTP-VERIFIED
   ------------------------------------------------------------
   Step 1: sendCancelOtp()      → ask backend to email a code
   Step 2: submitCancelOtp()    → verify the code and finalize
   Step 3: closeCancelSubscriptionModal() → safe exit, no cancel
   ============================================================ */
async function cancelSubscription() {
  if (!currentUser || !currentUser._id) {
    return showToast('Please log in first.', 'error');
  }
  if (!currentUser.isSubscribed) {
    return showToast('You do not have an active subscription.', 'info');
  }

  const proceed = confirm(
    'To prevent accidental cancellation, we will send a 6-digit verification code to your registered email.\n\n' +
    'Your subscription will only be cancelled AFTER you enter the correct code.\n\n' +
    'Continue?'
  );
  if (!proceed) return;

  showToast('Sending verification code…', 'info');

  try {
    const res = await fetch(`${API_BASE}/subscribe/cancel/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser._id })
    });
    const data = await res.json();

    if (!data.success) {
      return showToast(data.message || 'Could not send verification code.', 'error');
    }

    // Populate the modal
    const maskEl = document.getElementById('cancelOtpEmailMask');
    if (maskEl) maskEl.textContent = data.email || 'your registered email';

    const input = document.getElementById('cancelOtpInput');
    if (input) input.value = '';

    const btn = document.getElementById('cancelOtpSubmitBtn');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-shield-halved"></i> Verify & Cancel';
    }

    openModal('cancelSubscriptionModal');
    setTimeout(() => input && input.focus(), 120);

    showToast('✅ Verification code sent — check your inbox.', 'success');
  } catch (err) {
    console.error('[cancelSubscription]', err);
    showToast('Network error. Please try again.', 'error');
  }
}

function closeCancelSubscriptionModal() {
  closeModal('cancelSubscriptionModal');
  showToast('Cancellation aborted — your subscription is still active.', 'info');
}

async function submitCancelOtp() {
  const input = document.getElementById('cancelOtpInput');
  const btn   = document.getElementById('cancelOtpSubmitBtn');
  if (!input || !currentUser) return;

  const otp = input.value.trim();
  if (!/^\d{6}$/.test(otp)) {
    return showToast('Please enter a valid 6-digit code.', 'error');
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying…';
  }

  try {
    const res = await fetch(`${API_BASE}/subscribe/cancel/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser._id, otp })
    });
    const data = await res.json();

    if (data.success) {
      currentUser = data.user;
      saveSessionUser(currentUser);
      closeModal('cancelSubscriptionModal');
      showToast('✅ Subscription cancelled. Access remains until the end of your billing period.', 'success');
      renderApp();
    } else {
      showToast(data.message || 'Verification failed.', 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-shield-halved"></i> Verify & Cancel';
      }
      if (input) {
        input.value = '';
        input.focus();
      }
    }
  } catch (err) {
    console.error('[submitCancelOtp]', err);
    showToast('Network error. Please try again.', 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-shield-halved"></i> Verify & Cancel';
    }
  }
}
/* ============================================================
   STUDENT COURSES
   ============================================================ */
function clearCourseFilters() {
  const s = $('filterSemester');
  const c = $('filterCategory');
  const d = $('filterDifficulty');
  const p = $('filterPrice');
  if (s) s.value = '';
  if (c) c.value = '';
  if (d) d.value = '';
  if (p) p.value = '';
  renderStudentCourses();
}

function renderStudentCourses() {
  const courses = getCourses().filter(c => c.status !== 'draft' && c.status !== 'archived');
  const searchTerm  = ($('studentCourseSearch')?.value || '').toLowerCase().trim();
  const fSemester   = ($('filterSemester')?.value   || '').trim();
  const fCategory   = ($('filterCategory')?.value   || '').trim();
  const fDifficulty = ($('filterDifficulty')?.value || '').trim();
  const fPrice      = ($('filterPrice')?.value      || '').trim();

  // Normalizes any semester value to just its first number as a string.
  // "1" → "1" | 1 → "1" | "Semester 1" → "1" | "Sem 1" → "1" | "1st" → "1"
  function normalizeSemester(v) {
    if (v === null || v === undefined) return '';
    const s = String(v).trim();
    const m = s.match(/\d+/);
    return m ? m[0] : s.toLowerCase();
  }

  const filtered = courses.filter(c => {
    // Search
    if (searchTerm) {
      const hit = (c.name || '').toLowerCase().includes(searchTerm) ||
                  (c.code && c.code.toLowerCase().includes(searchTerm)) ||
                  (c.instructor && c.instructor.toLowerCase().includes(searchTerm));
      if (!hit) return false;
    }

    // Semester — normalized comparison
    if (fSemester) {
      const courseSem = normalizeSemester(c.semester);
      const filterSem = normalizeSemester(fSemester);
      if (courseSem !== filterSem) return false;
    }

    // Category
    if (fCategory && c.category !== fCategory) return false;

    // Difficulty
    if (fDifficulty && c.difficulty !== fDifficulty) return false;

    // Price
    if (fPrice === 'free'    &&  c.isPremium) return false;
    if (fPrice === 'premium' && !c.isPremium) return false;

    return true;
  });

  filtered.sort((a, b) => {
    if (a.featured && !b.featured) return -1;
    if (!a.featured && b.featured) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  if (filtered.length === 0) {
    $('studentCourseList').innerHTML = `
      <div class="empty-state">
        <i class="fas fa-graduation-cap"></i>
        <p>No courses match your filters.</p>
        ${fSemester ? `<p style="margin-top:8px;font-size:13px;">No courses found for Semester ${fSemester}.</p>` : ''}
      </div>`;
    return;
  }

  let html = `<div class="course-grid">`;
  filtered.forEach(c => { html += renderStudentCourseCard(c); });
  html += `</div>`;
  $('studentCourseList').innerHTML = html;
}

function renderStudentCourseCard(c) {
  const isPurchased  = currentUser.purchases && currentUser.purchases.includes(c.id);
  const isSubscribed = !!currentUser?.isSubscribed;
  const unlocked     = isPurchased || isSubscribed;

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

  // Premium badge: Locked OR Unlocked depending on purchase / subscription
  let badge = '';
  if (c.isPremium) {
    const statusBadge = unlocked
      ? ` <span class="premium-badge premium-unlocked"><i class="fas fa-unlock"></i> Unlocked</span>`
      : ` <span class="premium-badge premium-locked"><i class="fas fa-lock"></i> Locked</span>`;
    badge = `<span class="premium-badge"><i class="fas fa-crown"></i> Premium</span>${statusBadge}`;
  }

  const thumbHtml = c.thumbnail ? `<div class="course-thumb"><img src="${c.thumbnail}" alt="" loading="lazy"></div>` : '';
  const plCount = (c.playlists || []).length;

  return `
    <div class="course-card ${c.thumbnail ? 'has-thumb' : ''}" style="${accentStyle(c.code || c.name)}" onclick="viewCourseDetail('${c.id}')">
      ${thumbHtml}
      <button class="bookmark-btn ${saved ? 'saved' : ''}" onclick="toggleBookmark(event, '${c.id}')" title="${saved ? 'Remove' : 'Save'}" aria-label="${saved ? 'Remove bookmark' : 'Save course'}">
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
        ${plCount > 0 ? `<span class="chip"><i class="fas fa-list"></i> ${plCount} playlist${plCount === 1 ? '' : 's'}</span>` : ''}
      </div>
      <p class="course-desc">${escapeHtml(c.description) || ''}</p>
      <div class="material-count"><i class="fas fa-layer-group"></i> ${totalMats} materials</div>
      ${progressHtml}
      ${c.isPremium && !unlocked
        ? `<div style="margin-top:10px;"><button class="btn btn-primary btn-sm" onclick="event.stopPropagation();showPaymentModal('${c.id}')"><i class="fas fa-shopping-cart"></i> Buy Now</button></div>`
        : ''}
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
  const isSubscribed = !!currentUser?.isSubscribed;   // ← NEW LINE (moved up)
  const acc = accentStyle(course.code || course.name);
  const diff = difficultyColor(course.difficulty);

  let html = `
    <div class="course-detail-header" style="${acc}">
      ${course.thumbnail ? `<img src="${course.thumbnail}" class="cd-thumb" alt="" loading="lazy">` : ''}
      <div class="cd-content">
        <h2>${escapeHtml(course.name)} ${isPremiumCourse
  ? (isPurchased || isSubscribed
      ? '<span class="premium-badge"><i class="fas fa-crown"></i> Premium</span> <span class="premium-badge premium-unlocked"><i class="fas fa-unlock"></i> Unlocked</span>'
      : '<span class="premium-badge"><i class="fas fa-crown"></i> Premium</span> <span class="premium-badge premium-locked"><i class="fas fa-lock"></i> Locked</span>')
  : ''}</h2>
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

  if (isPremiumCourse && currentUser.role === 'student' && !isPurchased && !isSubscribed) {
    html += `<div class="premium-notice">
      <div><i class="fas fa-info-circle"></i> Premium materials locked.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-warning btn-sm" onclick="showPaymentModal('${course.id}')"><i class="fas fa-shopping-cart"></i> Buy this course (₹${course.price})</button>
      </div>
    </div>`;
  }

  if (liveSubscriptionSettings.enabled && currentUser.role === 'student' && !isSubscribed) {
    html += `<div class="subscribe-cta">
      <div class="subscribe-cta-text">
        <i class="fas fa-repeat"></i>
        <span>${escapeHtml(liveSubscriptionSettings.title)} — unlock <strong>every</strong> course for ₹${liveSubscriptionSettings.amount}/month</span>
      </div>
      <button class="btn btn-primary btn-sm" onclick="startSubscriptionCheckout()">
        <i class="fas fa-bolt"></i> Subscribe Now
      </button>
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
  const hasPlaylists = (course.playlists || []).length > 0;
  const filtered = currentMaterialFilter === 'all'
    ? materials
    : materials.filter(m => String(m.type || '').toLowerCase() === String(currentMaterialFilter).toLowerCase());

  let types = hasPlaylists
    ? ['all', 'playlists', 'video', 'pyq', 'tutorial', 'slides', 'qa', 'other']
    : ['all', 'video', 'pyq', 'tutorial', 'slides', 'qa', 'other'];

  const typeLabels = {
    all: 'All',
    playlists: '▶️ Playlists',
    video: '🎬 Video',
    pyq: '📄 PYQ',
    tutorial: '📝 Tutorial',
    slides: '📊 Slides',
    qa: '❓ Q&A',
    other: '📁 Other'
  };

  // NEW: detect custom (non-known) types used by materials in this course
  const presentTypes = new Set(
    materials.map(m => String(m.type || '').toLowerCase()).filter(Boolean)
  );
  const customTypes = Array.from(presentTypes)
    .filter(t => !KNOWN_MAT_TYPES.includes(t))
    .sort();

  // Insert custom tabs just before "other"
  const otherIdx = types.indexOf('other');
  customTypes.forEach((ct, i) => {
    const display = ct.replace(/[-_]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
    typeLabels[ct] = `📎 ${display}`;
    types.splice(otherIdx + i, 0, ct);
  });

  if (hasPlaylists && currentMaterialFilter !== 'playlists') {
    const totalVids = (course.playlists || []).reduce((sum, p) => sum + (p.materialIds || []).length, 0);
    html += `
      <div class="playlist-banner">
        <div class="playlist-banner-icon"><i class="fas fa-list"></i></div>
        <div class="playlist-banner-info">
          <h4>🎬 ${(course.playlists || []).length} Playlist${(course.playlists || []).length === 1 ? '' : 's'} available</h4>
          <p>Watch lectures in sequence — ${totalVids} video${totalVids === 1 ? '' : 's'} in total</p>
        </div>
        <button class="btn btn-accent" onclick="setMaterialFilter('playlists')">
          <i class="fas fa-play"></i> Browse Playlists
        </button>
      </div>`;
  }

  html += `<div class="material-tabs">`;
  types.forEach(t => {
    let count = 0;
    if (t === 'all') count = materials.length;
    else if (t === 'qa') count = course.doubts ? course.doubts.length : 0;
    else if (t === 'playlists') count = (course.playlists || []).length;
    else count = materials.filter(m => String(m.type || '').toLowerCase() === String(t).toLowerCase()).length;
    html += `<button class="${currentMaterialFilter === t ? 'active' : ''}" onclick="setMaterialFilter('${t}')">${typeLabels[t]} (${count})</button>`;
  });
  html += `</div>`;

  if (currentMaterialFilter === 'qa') {
    html += renderQASection(course);
    $('courseDetailContent').innerHTML = html;
    return;
  }

  if (currentMaterialFilter === 'playlists') {
    html += renderCoursePlaylists(course);
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
  const isSubscribed = !!currentUser?.isSubscribed;
  const canAccess = (currentUser.role === 'admin') || isPurchased || isMatPurchased || isSubscribed || !isMatPremium;
  const viewed = isMaterialViewed(course.id, m.id);
  const quizCount = (m.quiz || []).length;
  let fileActionHtml = '';
  if (!canAccess) {
    fileActionHtml = `<button class="btn btn-warning btn-sm" onclick="showPaymentModal('${course.id}', '${m.id}')"><i class="fas fa-lock"></i> Unlock ₹${matPrice}</button>`;
  } else {
    if (m.type === 'video' && hasUrl) {
      fileActionHtml += `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openMaterialVideo('${course.id}', '${m.id}')"><i class="fas fa-play"></i> Watch</button>`;
    } else if (hasUrl) {
      fileActionHtml += ` <a href="${escapeHtml(m.url)}" target="_blank" rel="noopener" class="btn btn-primary btn-sm"><i class="fas fa-external-link-alt"></i> Open Link</a>`;
    }

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
        <div class="mat-type ${materialTypeSlug(m.type)}">${escapeHtml(String(m.type || 'other').toUpperCase())}</div>
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
   STUDENT — PLAYLIST VIEW
   ============================================================ */
function renderCoursePlaylists(course) {
  const playlists = course.playlists || [];
  const validPlaylists = playlists.filter(pl => (pl.materialIds || []).length > 0);

  if (validPlaylists.length === 0) {
    return `<div class="empty-state"><i class="fas fa-list"></i><p>No playlists available yet.</p></div>`;
  }

  let html = `<div class="playlist-grid">`;
  validPlaylists.forEach(pl => {
    const items = pl.materialIds
      .map(id => (course.materials || []).find(m => m.id === id))
      .filter(Boolean);

    const firstThree = items.slice(0, 3).map(m => `<li>${escapeHtml(m.title)}</li>`).join('');
    const more = items.length > 3 ? `<li class="playlist-more">+ ${items.length - 3} more</li>` : '';

    html += `
      <div class="playlist-card">
        <div class="playlist-card-cover">
          <i class="fas fa-play-circle"></i>
          <span class="playlist-card-count">${items.length} video${items.length === 1 ? '' : 's'}</span>
        </div>
        <div class="playlist-card-body">
          <h3>${escapeHtml(pl.title)}</h3>
          ${pl.description ? `<p class="playlist-card-desc">${escapeHtml(pl.description)}</p>` : ''}
          <ul class="playlist-card-preview">
            ${firstThree}
            ${more}
          </ul>
          <button class="btn btn-primary btn-block" onclick="openPlaylistPlayer('${course.id}', '${pl.id}', 0)">
            <i class="fas fa-play"></i> Play Playlist
          </button>
        </div>
      </div>
    `;
  });
  html += `</div>`;
  return html;
}

async function openPlaylistPlayer(courseId, playlistId, startIndex = 0) {
  if (!currentUser) return showToast('Please log in first.', 'error');
  const course = findCourse(courseId);
  if (!course) return;
  const playlist = (course.playlists || []).find(p => p.id === playlistId);
  if (!playlist) return showToast('Playlist not found.', 'error');
  if (playlist.materialIds.length === 0) return showToast('This playlist is empty.', 'info');

  showToast('Loading playlist…', 'info');

  const items = [];
  for (const matId of playlist.materialIds) {
    const mat = (course.materials || []).find(m => m.id === matId);
    if (!mat || mat.type !== 'video' || !mat.url) continue;

    try {
      const res = await fetch(
        `https://aerospace-portal.onrender.com/api/materials/${courseId}/${mat.id}/video-session`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: currentUser._id })
        }
      );
      const data = await res.json();
      if (!data.success) continue;

      items.push({
        materialId: mat.id,
        title: mat.title,
        kind: data.kind,
        videoId: data.videoId || null,
        directUrl: data.directUrl || null
      });
    } catch (e) { /* skip */ }
  }

  if (items.length === 0) return showToast('No playable videos in this playlist.', 'error');

  const safeStart = Math.max(0, Math.min(startIndex, items.length - 1));

  window.VideoPlayer.open({
    playlist: items,
    playlistIndex: safeStart,
    playlistTitle: playlist.title,
    username: currentUser.fullName || currentUser.username || 'Student'
  });
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
/* ============================================================
   QUIZ / PAPER EDITOR STATE
   ============================================================ */
let quizEditingCourseId   = null;
let quizEditingMaterialId = null;
let quizPaperConfig = { subject: '', paperCode: '', totalTime: '', totalMarks: 0 };
let quizDraft = [];

/* ============================================================
   MathJax v3 renderer — Overleaf-parity LaTeX
   ============================================================ */
window.__mathjaxReady = false;
window.__mathjaxQueue = [];

function renderMathIn(el) {
  if (!el) return;
  if (!window.__mathjaxReady || !window.MathJax || !window.MathJax.typesetPromise) {
    if (!window.__mathjaxQueue.includes(el)) window.__mathjaxQueue.push(el);
    return;
  }
  try { window.MathJax.typesetClear([el]); } catch (e) {}
  window.MathJax.typesetPromise([el]).catch(err => {
    console.warn('[MathJax]', err && err.message ? err.message : err);
  });
}

(function waitForMathJax() {
  if (window.MathJax && window.MathJax.startup && window.MathJax.startup.promise) {
    window.MathJax.startup.promise.then(() => {
      window.__mathjaxReady = true;
      const q = window.__mathjaxQueue.splice(0);
      q.forEach(el => renderMathIn(el));
    }).catch(() => {});
  } else {
    setTimeout(waitForMathJax, 120);
  }
})();

/* ---------- Debounced live LaTeX preview ---------- */
const _latexPreviewTimers = new WeakMap();
function scheduleLatexPreview(sourceEl) {
  const pid = sourceEl.dataset.previewId;
  if (!pid) return;
  const target = document.getElementById('latex-preview-' + pid);
  if (!target) return;

  const prev = _latexPreviewTimers.get(sourceEl);
  if (prev) clearTimeout(prev);

  _latexPreviewTimers.set(sourceEl, setTimeout(() => {
    const value = sourceEl.value || '';
    if (!value.trim()) {
      target.innerHTML = '';
      target.classList.add('is-empty');
      return;
    }
    target.classList.remove('is-empty');
    target.textContent = value;
    renderMathIn(target);
  }, 400));
}

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t && t.classList && t.classList.contains('latex-source')) {
    scheduleLatexPreview(t);
  }
});

/* ---------- Live mark totals ---------- */
function updateQuizTotals() {
  const total = quizDraft.reduce((s, q) => s + (Number(q.marks) || 0), 0);
  const count = quizDraft.length;
  ['quizHeaderCount', 'quizDraftCount'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = count;
  });
  ['quizHeaderMarks', 'quizDraftMarks'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = total;
  });
  const auto = document.getElementById('qpAutoHint');
  if (auto) auto.textContent = total;
}

/* ---------- Preview toggle ---------- */
let _previewsVisible = true;
function toggleLatexPreviews() {
  _previewsVisible = !_previewsVisible;
  document.body.classList.toggle('hide-latex-previews', !_previewsVisible);
  const btn = document.getElementById('previewToggleBtn');
  if (btn) {
    btn.innerHTML = _previewsVisible
      ? '<i class="fas fa-eye"></i> Hide Previews'
      : '<i class="fas fa-eye-slash"></i> Show Previews';
  }
}

/* ---------- Autosave ---------- */
let _quizAutosaveTimer = null;
function startQuizAutosave() {
  stopQuizAutosave();
  _quizAutosaveTimer = setInterval(() => {
    if (!quizEditingCourseId || !quizEditingMaterialId) return;
    try {
      const payload = {
        courseId:   quizEditingCourseId,
        materialId: quizEditingMaterialId,
        config: {
          subject:    ($('qpSubject')?.value || ''),
          paperCode:  ($('qpCode')?.value    || ''),
          totalTime:  ($('qpTime')?.value    || ''),
          totalMarks: parseInt($('qpMarks')?.value, 10) || 0
        },
        quiz: quizDraft,
        savedAt: Date.now()
      };
      localStorage.setItem('aero_quiz_draft_' + quizEditingMaterialId, JSON.stringify(payload));
    } catch (e) {}
  }, 15000);
}
function stopQuizAutosave() {
  if (_quizAutosaveTimer) { clearInterval(_quizAutosaveTimer); _quizAutosaveTimer = null; }
}
function getSavedQuizDraft(materialId) {
  try {
    const raw = localStorage.getItem('aero_quiz_draft_' + materialId);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.savedAt) return null;
    if (Date.now() - data.savedAt > 24 * 60 * 60 * 1000) {
      localStorage.removeItem('aero_quiz_draft_' + materialId);
      return null;
    }
    return data;
  } catch { return null; }
}
function clearSavedQuizDraft(materialId) {
  try { localStorage.removeItem('aero_quiz_draft_' + materialId); } catch {}
}

/* ---------- Student answer persistence ---------- */
function persistQuizAnswers() {
  const st = quizPlayerState;
  if (!st || st.previewMode || st.submitted) return;
  try {
    localStorage.setItem('aero_quiz_answers_' + st.materialId, JSON.stringify(st.answers));
  } catch {}
}
function restoreQuizAnswers(materialId) {
  try {
    const raw = localStorage.getItem('aero_quiz_answers_' + materialId);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function clearQuizAnswers(materialId) {
  try { localStorage.removeItem('aero_quiz_answers_' + materialId); } catch {}
}

/* ---------- Student test timer ---------- */
let _quizTimerHandle = null;
function parseQuizTime(s) {
  if (!s) return 0;
  s = String(s).toLowerCase().trim();
  const hm = s.match(/(\d+)\s*h(?:our|r)?s?/);
  const mm = s.match(/(\d+)\s*m(?:in(?:ute)?)?s?/);
  let sec = 0;
  if (hm) sec += parseInt(hm[1], 10) * 3600;
  if (mm) sec += parseInt(mm[1], 10) * 60;
  if (!sec) {
    const justN = s.match(/^(\d+)$/);
    if (justN) sec = parseInt(justN[1], 10) * 60;
  }
  return sec;
}
function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h > 0 ? String(h).padStart(2, '0') + ':' : '')
       + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
function startQuizTimer() {
  stopQuizTimer();
  const st = quizPlayerState;
  if (!st || st.previewMode || st.submitted) return;
  const duration = parseQuizTime(st.paperConfig && st.paperConfig.totalTime);
  if (!duration) return;

  const startKey = 'aero_quiz_start_' + st.materialId;
  let startedAt = parseInt(localStorage.getItem(startKey), 10);
  if (!startedAt) {
    startedAt = Date.now();
    localStorage.setItem(startKey, String(startedAt));
  }

  const tick = () => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const remaining = Math.max(0, duration - elapsed);
    const el = document.getElementById('quizTimerDisplay');
    if (el) {
      el.textContent = formatDuration(remaining);
      el.classList.toggle('warning', remaining < 60 && remaining > 0);
      el.classList.toggle('expired', remaining === 0);
    }
    if (remaining === 0) {
      stopQuizTimer();
      try { showToast('⏰ Time is up!', 'error'); } catch (e) {}
      submitQuiz();
    }
  };
  tick();
  _quizTimerHandle = setInterval(tick, 1000);
}
function stopQuizTimer() {
  if (_quizTimerHandle) { clearInterval(_quizTimerHandle); _quizTimerHandle = null; }
  const el = document.getElementById('quizTimerDisplay');
  if (el) el.classList.remove('warning', 'expired');
}

/* ---------- Preview HTML escaper ---------- */
function escapeForPreview(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ---------- Preview box helper ---------- */
function latexPreviewBox(id, initialValue) {
  const isEmpty = !initialValue || !String(initialValue).trim();
  return `<div class="latex-preview ${isEmpty ? 'is-empty' : ''}" id="latex-preview-${id}">${escapeForPreview(initialValue || '')}</div>`;
}

/* ---------- Keyboard Ctrl+S for quiz editor ---------- */
document.addEventListener('keydown', (e) => {
  if (!quizEditingCourseId) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveQuizPaper();
  }
});
/* ============================================================
   QUIZ EDITOR — Full-page open / close / render
   ============================================================ */
function openQuizEditor(courseId, materialId) {
  const course = findCourse(courseId);
  if (!course) return showToast('Course not found.', 'error');
  const mat = (course.materials || []).find(m => m.id === materialId);
  if (!mat) return showToast('Material not found.', 'error');

  quizEditingCourseId = courseId;
  quizEditingMaterialId = materialId;

  const saved = getSavedQuizDraft(materialId);
  let useSaved = false;
  if (saved && Array.isArray(saved.quiz) && saved.quiz.length > 0) {
    const ageMin = Math.round((Date.now() - saved.savedAt) / 60000);
    useSaved = confirm(
      `An unsaved draft was autosaved ${ageMin} minute${ageMin === 1 ? '' : 's'} ago.\n\n` +
      `Restore it?\n\n[OK] Restore draft\n[Cancel] Discard and use the last SAVED version`
    );
  }

  if (useSaved) {
    quizDraft = saved.quiz.map(q => normalizeQuestion(q));
    quizPaperConfig = saved.config || { subject: '', paperCode: '', totalTime: '', totalMarks: 0 };
  } else {
    const rawQuiz = Array.isArray(mat.quiz) ? mat.quiz : [];
    quizDraft = rawQuiz.map(q => normalizeQuestion(q));
    const cfg = mat.examConfig || {};
    quizPaperConfig = {
      subject:    cfg.subject    || course.name    || '',
      paperCode:  cfg.paperCode  || (course.code ? course.code + '-' + (mat.title || '') : ''),
      totalTime:  cfg.totalTime  || '',
      totalMarks: Number(cfg.totalMarks) || quizDraft.reduce((s, q) => s + (q.marks || 0), 0)
    };
  }

  addingCourse = false; addingProfessor = false;
  addingMaterialCourseId = null; addingStudent = false;
  editingCourseId = null; currentCourseId = null;
  window.currentSelectedCourseId = null;

  pushHash(`#/admin/quiz/${courseId}/${materialId}`);
  renderApp();
}

function closeQuizEditor() {
  const hasDraft = quizDraft.length > 0;
  if (hasDraft) {
    const ok = confirm('Close the paper editor?\n\nYour unsaved changes are autosaved locally and will be offered for restore next time.');
    if (!ok) return;
  }
  stopQuizAutosave();
  const cid = quizEditingCourseId;
  quizEditingCourseId = null;
  quizEditingMaterialId = null;
  quizDraft = [];
  if (cid) openCourseEditor(cid);
  else { pushHash('#/admin/courses'); pushHash; renderApp(); }
}

function normalizeQuestion(q) {
  const type = q.type || (Array.isArray(q.correctIndexes) && q.correctIndexes.length > 1
    ? 'multiple' : 'single');

  let correctIndexes = Array.isArray(q.correctIndexes) ? [...q.correctIndexes]
    : (typeof q.correctIndex === 'number' ? [q.correctIndex] : []);

  return {
    type,
    question:    q.question    || '',
    explanation: q.explanation || '',

    options:        (q.options && q.options.length) ? [...q.options] : ['', '', '', ''],
    correctIndexes,

    integerAnswer:    (q.integerAnswer === null || q.integerAnswer === undefined) ? null : Number(q.integerAnswer),
    integerTolerance: Number(q.integerTolerance) || 0,

    matrixLeftItems:  (q.matrixLeftItems && q.matrixLeftItems.length) ? [...q.matrixLeftItems] : ['', '', '', ''],
    matrixRightItems: (q.matrixRightItems && q.matrixRightItems.length) ? [...q.matrixRightItems] : ['', '', '', ''],
    matrixRows:       Array.isArray(q.matrixRows) && q.matrixRows.length
      ? q.matrixRows.map(r => ({ text: r.text || '', correctIndex: Number(r.correctIndex) || 0 }))
      : [ { text: '', correctIndex: 0 }, { text: '', correctIndex: 1 },
          { text: '', correctIndex: 2 }, { text: '', correctIndex: 3 } ],

    marks:         typeof q.marks === 'number' ? q.marks : 4,
    negativeMarks: typeof q.negativeMarks === 'number' ? q.negativeMarks : -1
  };
}

/* ============================================================
   QUIZ EDITOR — Render (with live preview + reorder + autosave)
   ============================================================ */
function renderQuizEditor() {
  const container = document.getElementById('quizEditorContent');
  if (!container) return;
  const course = findCourse(quizEditingCourseId);
  if (!course) { container.innerHTML = '<p>Course not found.</p>'; return; }
  const mat = (course.materials || []).find(m => m.id === quizEditingMaterialId);
  if (!mat) { container.innerHTML = '<p>Material not found.</p>'; return; }

  const autoTotal = quizDraft.reduce((s, q) => s + (Number(q.marks) || 0), 0);

  container.innerHTML = `
    <button class="back-link" onclick="closeQuizEditor()">
      <i class="fas fa-arrow-left"></i> Back to Course Editor
    </button>

    <div class="dash-header">
      <h2><i class="fas fa-file-pen"></i> Question Paper Editor</h2>
      <div class="actions">
        <button class="btn btn-outline" onclick="toggleLatexPreviews()" id="previewToggleBtn">
          <i class="fas fa-eye"></i> Hide Previews
        </button>
        <button class="btn btn-outline" onclick="previewQuizPaper()">
          <i class="fas fa-eye"></i> Preview as Student
        </button>
        <button class="btn btn-primary" onclick="saveQuizPaper()" id="quizSaveBtn">
          <i class="fas fa-save"></i> Save Paper
          <span style="opacity:.7;font-size:11px;margin-left:6px;">(Ctrl+S)</span>
        </button>
      </div>
    </div>

    <div class="editor-section">
      <div class="editor-section-title">
        <i class="fas fa-info-circle"></i> Paper Details
        <span style="font-size:12px;color:var(--text-tertiary);font-weight:500;margin-left:8px;">
          ${escapeHtml(course.name)} · ${escapeHtml(mat.title)}
        </span>
      </div>
      <div class="editor-grid-2">
        <div class="form-group">
          <label>Subject Name</label>
          <input type="text" id="qpSubject" value="${escapeHtml(quizPaperConfig.subject)}" placeholder="e.g. Aerodynamics">
        </div>
        <div class="form-group">
          <label>Paper Code</label>
          <input type="text" id="qpCode" value="${escapeHtml(quizPaperConfig.paperCode)}" placeholder="e.g. AE101-MID">
        </div>
        <div class="form-group">
          <label>Total Time Duration</label>
          <input type="text" id="qpTime" value="${escapeHtml(quizPaperConfig.totalTime)}" placeholder="e.g. 3 hours or 90 min">
          <span class="hint">Auto-parsed for countdown timer (e.g. "1.5 hours", "90 min", "120").</span>
        </div>
        <div class="form-group">
          <label>Total Marks</label>
          <input type="number" id="qpMarks" value="${quizPaperConfig.totalMarks || autoTotal}" min="0" step="1" placeholder="e.g. 100">
          <span class="hint">Auto-computed from questions: <strong id="qpAutoHint">${autoTotal}</strong></span>
        </div>
      </div>
    </div>

    <div class="editor-section">
      <div class="editor-section-header">
        <div class="editor-section-title">
          <i class="fas fa-list-ol"></i> Questions (<span id="quizHeaderCount">${quizDraft.length}</span>)
          <span style="font-size:12px;color:var(--text-tertiary);font-weight:500;margin-left:8px;">
            Total marks: <span id="quizHeaderMarks">${autoTotal}</span>
          </span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-outline btn-sm" onclick="addQuizQuestion('single')"><i class="fas fa-plus"></i> Single Correct</button>
          <button class="btn btn-outline btn-sm" onclick="addQuizQuestion('multiple')"><i class="fas fa-plus"></i> Multiple Correct</button>
          <button class="btn btn-outline btn-sm" onclick="addQuizQuestion('integer')"><i class="fas fa-plus"></i> Integer</button>
          <button class="btn btn-outline btn-sm" onclick="addQuizQuestion('matrix')"><i class="fas fa-plus"></i> Matrix Match</button>
        </div>
      </div>

      <p class="editor-hint">
        <strong>Overleaf-standard LaTeX is supported.</strong>
        Inline math: <code>$E = mc^2$</code> · Display math: <code>$$\\int_0^1 x^2\\,dx$$</code> ·
        Also supports <code>\\begin{align}</code>, <code>\\begin{pmatrix}</code>, <code>\\ce{H2O}</code>, <code>\\textcolor</code>, and all amsmath/physics macros.
        Live preview appears below every input.
      </p>

      <div id="quizDraftList"></div>

      <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:16px;"
              onclick="addQuizQuestion('single')">
        <i class="fas fa-plus"></i> Add Question
      </button>
    </div>
  `;

  renderQuizDraft();
  renderMathIn(container);
  startQuizAutosave();
}

function renderQuizDraft() {
  const list = document.getElementById('quizDraftList');
  if (!list) return;

  if (quizDraft.length === 0) {
    list.innerHTML = `<div class="empty-state"><i class="fas fa-question-circle"></i><p>No questions yet. Add your first question below.</p></div>`;
    updateQuizTotals();
    return;
  }

  let html = '';
  quizDraft.forEach((q, qi) => {
    html += `<div class="quiz-edit-card" data-qid="${qi}">
      <div class="quiz-edit-head">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <strong>Question ${qi + 1}</strong>
          <span class="mat-type">${questionTypeLabel(q.type)}</span>
          <span class="quiz-question-marks-badge">+${q.marks} / ${q.negativeMarks}</span>
        </div>
        <div class="quiz-question-controls">
          <button type="button" class="quiz-icon-btn" onclick="moveQuizQuestion(${qi}, -1)" title="Move up" ${qi === 0 ? 'disabled' : ''}>
            <i class="fas fa-arrow-up"></i>
          </button>
          <button type="button" class="quiz-icon-btn" onclick="moveQuizQuestion(${qi}, 1)" title="Move down" ${qi === quizDraft.length - 1 ? 'disabled' : ''}>
            <i class="fas fa-arrow-down"></i>
          </button>
          <button type="button" class="quiz-icon-btn" onclick="duplicateQuizQuestion(${qi})" title="Duplicate">
            <i class="fas fa-copy"></i>
          </button>
          <button type="button" class="quiz-icon-btn danger" onclick="removeQuizQuestion(${qi})" title="Delete">
            <i class="fas fa-trash-alt"></i>
          </button>
        </div>
      </div>

      <div class="editor-grid-3" style="margin-bottom:12px;">
        <div class="form-group">
          <label>Question Type</label>
          <select onchange="updateQuizType(${qi}, this.value)">
            <option value="single"   ${q.type === 'single'   ? 'selected' : ''}>Single Correct (MCQ)</option>
            <option value="multiple" ${q.type === 'multiple' ? 'selected' : ''}>Multiple Correct (MSQ)</option>
            <option value="integer"  ${q.type === 'integer'  ? 'selected' : ''}>Integer / Numerical</option>
            <option value="matrix"   ${q.type === 'matrix'   ? 'selected' : ''}>Matrix Match</option>
          </select>
        </div>
        <div class="form-group">
          <label>Marks (+)</label>
          <input type="number" value="${q.marks}" min="0" step="0.5"
                 oninput="updateQuizField(${qi}, 'marks', parseFloat(this.value) || 0)">
        </div>
        <div class="form-group">
          <label>Negative Marks (−)</label>
          <input type="number" value="${q.negativeMarks}" step="0.5"
                 oninput="updateQuizField(${qi}, 'negativeMarks', parseFloat(this.value) || 0)">
        </div>
      </div>

      <div class="form-group" style="margin-bottom:14px;">
        <label>Question Text <span class="hint" style="display:inline;">· LaTeX supported</span></label>
        <textarea rows="3" class="latex-source" data-preview-id="q${qi}-question"
                  placeholder="e.g. Find $\\int_0^1 x^2 \\, dx$"
                  oninput="updateQuizField(${qi}, 'question', this.value)">${escapeHtml(q.question)}</textarea>
        ${latexPreviewBox(`q${qi}-question`, q.question)}
      </div>

      ${renderAnswerArea(q, qi)}

      <div class="form-group" style="margin-top:12px;">
        <label>Explanation / Solution (optional · LaTeX supported)</label>
        <textarea rows="2" class="latex-source" data-preview-id="q${qi}-explanation"
                  placeholder="e.g. Using power rule: $\\frac{x^3}{3}\\Big|_0^1 = \\frac{1}{3}$"
                  oninput="updateQuizField(${qi}, 'explanation', this.value)">${escapeHtml(q.explanation || '')}</textarea>
        ${latexPreviewBox(`q${qi}-explanation`, q.explanation || '')}
      </div>
    </div>`;
  });

  list.innerHTML = html;
  renderMathIn(list);
  updateQuizTotals();
}

function questionTypeLabel(t) {
  return ({ single: 'SINGLE', multiple: 'MULTIPLE', integer: 'INTEGER', matrix: 'MATRIX' })[t] || 'SINGLE';
}

function renderAnswerArea(q, qi) {
  if (q.type === 'single' || q.type === 'multiple') {
    const inputType = q.type === 'single' ? 'radio' : 'checkbox';
    const inputName = `q-${qi}-${q.type}`;

    return `
      <div class="quiz-options-block">
        <label style="font-size:12.5px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:8px;">
          Options ${q.type === 'multiple' ? '(check ALL correct)' : '(select ONE correct)'}
        </label>
        ${(q.options || []).map((opt, oi) => {
          const checked = (q.correctIndexes || []).includes(oi);
          return `
            <div class="quiz-option-row">
              <label class="quiz-radio">
                <input type="${inputType}" name="${inputName}"
                       ${checked ? 'checked' : ''}
                       onchange="updateQuizCorrect(${qi}, ${oi}, this.checked, '${q.type}')">
                <span class="quiz-radio-dot"></span>
              </label>
              <div class="quiz-option-input-wrap">
                <input type="text" class="latex-source" data-preview-id="q${qi}-opt${oi}"
                       placeholder="Option ${String.fromCharCode(65 + oi)} · LaTeX ok"
                       value="${escapeHtml(opt)}"
                       oninput="updateQuizOption(${qi}, ${oi}, this.value)">
                ${latexPreviewBox(`q${qi}-opt${oi}`, opt)}
              </div>
              <button type="button" class="quiz-remove" style="width:24px;height:24px;"
                      onclick="removeQuizOption(${qi}, ${oi})" title="Remove option">
                <i class="fas fa-times" style="font-size:10px;"></i>
              </button>
            </div>`;
        }).join('')}
        <button type="button" class="btn btn-outline btn-sm" style="margin-top:8px;"
                onclick="addQuizOption(${qi})">
          <i class="fas fa-plus"></i> Add Option
        </button>
      </div>`;
  }

  if (q.type === 'integer') {
    return `
      <div class="editor-grid-2">
        <div class="form-group">
          <label>Correct Integer / Numeric Answer</label>
          <input type="number" step="any"
                 value="${q.integerAnswer === null ? '' : q.integerAnswer}"
                 placeholder="e.g. 42"
                 oninput="updateQuizField(${qi}, 'integerAnswer', this.value === '' ? null : parseFloat(this.value))">
        </div>
        <div class="form-group">
          <label>Tolerance (±)</label>
          <input type="number" step="any" min="0"
                 value="${q.integerTolerance || 0}"
                 placeholder="0 = exact match"
                 oninput="updateQuizField(${qi}, 'integerTolerance', parseFloat(this.value) || 0)">
          <span class="hint">If set to 0.5, answers within ±0.5 are accepted.</span>
        </div>
      </div>`;
  }

  if (q.type === 'matrix') {
    const leftItems  = q.matrixLeftItems  || [];
    const rightItems = q.matrixRightItems || [];
    const rows       = q.matrixRows       || [];

    return `
      <div class="matrix-match-block">
        <div class="editor-grid-2">
          <div>
            <label style="font-size:12.5px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:8px;">
              List-I (Left Column · items to be matched)
            </label>
            ${leftItems.map((item, li) => `
              <div class="quiz-option-row" style="margin-bottom:10px;">
                <span class="quiz-play-letter">${String.fromCharCode(65 + li)}</span>
                <div class="quiz-option-input-wrap">
                  <input type="text" class="latex-source" data-preview-id="q${qi}-L${li}"
                         placeholder="Item ${String.fromCharCode(65 + li)} · LaTeX ok"
                         value="${escapeHtml(item)}"
                         oninput="updateMatrixItem(${qi}, 'left', ${li}, this.value)">
                  ${latexPreviewBox(`q${qi}-L${li}`, item)}
                </div>
                <button type="button" class="quiz-remove" style="width:24px;height:24px;"
                        onclick="removeMatrixItem(${qi}, 'left', ${li})" title="Remove">
                  <i class="fas fa-times" style="font-size:10px;"></i>
                </button>
              </div>`).join('')}
            <button type="button" class="btn btn-outline btn-sm" onclick="addMatrixItem(${qi}, 'left')">
              <i class="fas fa-plus"></i> Add Left Item
            </button>
          </div>
          <div>
            <label style="font-size:12.5px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:8px;">
              List-II (Right Column · items to match to)
            </label>
            ${rightItems.map((item, ri) => `
              <div class="quiz-option-row" style="margin-bottom:10px;">
                <span class="quiz-play-letter">${['P','Q','R','S','T','U','V','W'][ri] || (ri + 1)}</span>
                <div class="quiz-option-input-wrap">
                  <input type="text" class="latex-source" data-preview-id="q${qi}-R${ri}"
                         placeholder="Item ${['P','Q','R','S','T','U','V','W'][ri] || (ri + 1)} · LaTeX ok"
                         value="${escapeHtml(item)}"
                         oninput="updateMatrixItem(${qi}, 'right', ${ri}, this.value)">
                  ${latexPreviewBox(`q${qi}-R${ri}`, item)}
                </div>
                <button type="button" class="quiz-remove" style="width:24px;height:24px;"
                        onclick="removeMatrixItem(${qi}, 'right', ${ri})" title="Remove">
                  <i class="fas fa-times" style="font-size:10px;"></i>
                </button>
              </div>`).join('')}
            <button type="button" class="btn btn-outline btn-sm" onclick="addMatrixItem(${qi}, 'right')">
              <i class="fas fa-plus"></i> Add Right Item
            </button>
          </div>
        </div>

        <div style="margin-top:16px;">
          <label style="font-size:12.5px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:8px;">
            Correct Matching (for each List-I item, choose the List-II match)
          </label>
          ${rows.map((r, ri) => `
            <div class="quiz-option-row" style="margin-bottom:8px;">
              <span class="quiz-play-letter">${String.fromCharCode(65 + ri)}</span>
              <input type="text" style="flex:1;" class="latex-source" data-preview-id="q${qi}-row${ri}"
                     placeholder="Row ${String.fromCharCode(65 + ri)} text (LaTeX ok)"
                     value="${escapeHtml(r.text)}"
                     oninput="updateMatrixRow(${qi}, ${ri}, 'text', this.value)">
              <span style="font-size:12px;color:var(--text-tertiary);padding:0 8px;">→</span>
              <select style="min-width:120px;" onchange="updateMatrixRow(${qi}, ${ri}, 'correctIndex', parseInt(this.value,10) || 0)">
                ${(rightItems.length ? rightItems : ['P','Q','R','S']).map((_, x) => {
                  const label = ['P','Q','R','S','T','U','V','W'][x] || (x + 1);
                  return `<option value="${x}" ${Number(r.correctIndex) === x ? 'selected' : ''}>${label}</option>`;
                }).join('')}
              </select>
              <button type="button" class="quiz-remove" style="width:24px;height:24px;"
                      onclick="removeMatrixRow(${qi}, ${ri})" title="Remove row">
                <i class="fas fa-times" style="font-size:10px;"></i>
              </button>
            </div>
          `).join('')}
          <button type="button" class="btn btn-outline btn-sm" onclick="addMatrixRow(${qi})">
            <i class="fas fa-plus"></i> Add Row
          </button>
        </div>
      </div>`;
  }

  return '';
}

/* ============================================================
   QUIZ EDITOR — Question mutators
   ============================================================ */
function addQuizQuestion(type = 'single') {
  const base = {
    type,
    question: '',
    explanation: '',
    marks: 4,
    negativeMarks: -1
  };
  if (type === 'single' || type === 'multiple') {
    base.options = ['', '', '', ''];
    base.correctIndexes = [];
  } else if (type === 'integer') {
    base.integerAnswer = null;
    base.integerTolerance = 0;
  } else if (type === 'matrix') {
    base.matrixLeftItems  = ['', '', '', ''];
    base.matrixRightItems = ['', '', '', ''];
    base.matrixRows = [0, 1, 2, 3].map(i => ({ text: '', correctIndex: i }));
  }
  quizDraft.push(base);
  renderQuizDraft();
}

function removeQuizQuestion(qi) {
  if (!confirm(`Delete Question ${qi + 1}?`)) return;
  quizDraft.splice(qi, 1);
  renderQuizDraft();
}

function duplicateQuizQuestion(qi) {
  const clone = JSON.parse(JSON.stringify(quizDraft[qi]));
  quizDraft.splice(qi + 1, 0, clone);
  renderQuizDraft();
  showToast(`Question ${qi + 1} duplicated.`, 'success');
}

function moveQuizQuestion(qi, delta) {
  const target = qi + delta;
  if (target < 0 || target >= quizDraft.length) return;
  const [item] = quizDraft.splice(qi, 1);
  quizDraft.splice(target, 0, item);
  renderQuizDraft();
}

function updateQuizType(qi, newType) {
  const q = quizDraft[qi];
  if (!q) return;
  q.type = newType;

  if ((newType === 'single' || newType === 'multiple') && (!q.options || q.options.length === 0)) {
    q.options = ['', '', '', ''];
    q.correctIndexes = [];
  }
  if (newType === 'single' && Array.isArray(q.correctIndexes) && q.correctIndexes.length > 1) {
    q.correctIndexes = [q.correctIndexes[0]];
  }
  if (newType === 'integer' && (q.integerAnswer === undefined)) q.integerAnswer = null;
  if (newType === 'matrix' && (!q.matrixLeftItems || q.matrixLeftItems.length === 0)) {
    q.matrixLeftItems  = ['', '', '', ''];
    q.matrixRightItems = ['', '', '', ''];
    q.matrixRows = [0, 1, 2, 3].map(i => ({ text: '', correctIndex: i }));
  }
  renderQuizDraft();
}

function updateQuizField(qi, field, value) {
  if (quizDraft[qi]) quizDraft[qi][field] = value;
  if (field === 'marks' || field === 'negativeMarks') updateQuizTotals();
}

function updateQuizOption(qi, oi, value) {
  if (quizDraft[qi] && quizDraft[qi].options) quizDraft[qi].options[oi] = value;
}

function addQuizOption(qi) {
  const q = quizDraft[qi];
  if (!q || !q.options) return;
  if (q.options.length >= 8) return showToast('Max 8 options.', 'info');
  q.options.push('');
  renderQuizDraft();
}

function removeQuizOption(qi, oi) {
  const q = quizDraft[qi];
  if (!q || !q.options) return;
  if (q.options.length <= 2) return showToast('At least 2 options required.', 'info');
  q.options.splice(oi, 1);
  q.correctIndexes = (q.correctIndexes || [])
    .filter(x => x !== oi)
    .map(x => x > oi ? x - 1 : x);
  renderQuizDraft();
}

function updateQuizCorrect(qi, oi, isChecked, type) {
  const q = quizDraft[qi];
  if (!q) return;
  if (!Array.isArray(q.correctIndexes)) q.correctIndexes = [];
  if (type === 'single') {
    q.correctIndexes = [oi];
  } else {
    if (isChecked) {
      if (!q.correctIndexes.includes(oi)) q.correctIndexes.push(oi);
    } else {
      q.correctIndexes = q.correctIndexes.filter(x => x !== oi);
    }
  }
}

function updateMatrixItem(qi, side, idx, value) {
  const q = quizDraft[qi];
  if (!q) return;
  const key = side === 'left' ? 'matrixLeftItems' : 'matrixRightItems';
  if (!Array.isArray(q[key])) q[key] = [];
  q[key][idx] = value;
}

function addMatrixItem(qi, side) {
  const q = quizDraft[qi];
  if (!q) return;
  const key = side === 'left' ? 'matrixLeftItems' : 'matrixRightItems';
  if (!Array.isArray(q[key])) q[key] = [];
  if (q[key].length >= 8) return showToast('Max 8 items per column.', 'info');
  q[key].push('');
  if (side === 'left') {
    if (!Array.isArray(q.matrixRows)) q.matrixRows = [];
    q.matrixRows.push({ text: '', correctIndex: 0 });
  }
  renderQuizDraft();
}

function removeMatrixItem(qi, side, idx) {
  const q = quizDraft[qi];
  if (!q) return;
  const key = side === 'left' ? 'matrixLeftItems' : 'matrixRightItems';
  if (!Array.isArray(q[key]) || q[key].length <= 2) {
    return showToast('At least 2 items required per column.', 'info');
  }
  q[key].splice(idx, 1);
  if (side === 'left' && Array.isArray(q.matrixRows)) q.matrixRows.splice(idx, 1);
  if (side === 'right' && Array.isArray(q.matrixRows)) {
    q.matrixRows.forEach(r => {
      if (Number(r.correctIndex) >= q.matrixRightItems.length) {
        r.correctIndex = q.matrixRightItems.length - 1;
      }
    });
  }
  renderQuizDraft();
}

function updateMatrixRow(qi, ri, field, value) {
  const q = quizDraft[qi];
  if (!q || !Array.isArray(q.matrixRows) || !q.matrixRows[ri]) return;
  q.matrixRows[ri][field] = value;
}

function addMatrixRow(qi) {
  const q = quizDraft[qi];
  if (!q) return;
  if (!Array.isArray(q.matrixRows)) q.matrixRows = [];
  if (q.matrixRows.length >= 8) return showToast('Max 8 rows.', 'info');
  q.matrixRows.push({ text: '', correctIndex: 0 });
  renderQuizDraft();
}

function removeMatrixRow(qi, ri) {
  const q = quizDraft[qi];
  if (!q || !Array.isArray(q.matrixRows)) return;
  if (q.matrixRows.length <= 2) return showToast('At least 2 rows required.', 'info');
  q.matrixRows.splice(ri, 1);
  renderQuizDraft();
}

/* ============================================================
   QUIZ EDITOR — Save / Validate
   ============================================================ */
async function saveQuizPaper() {
  if (!quizEditingCourseId || !quizEditingMaterialId) return;

  quizPaperConfig = {
    subject:    ($('qpSubject')?.value || '').trim(),
    paperCode:  ($('qpCode')?.value    || '').trim(),
    totalTime:  ($('qpTime')?.value    || '').trim(),
    totalMarks: parseInt($('qpMarks')?.value, 10) || 0
  };

  for (let i = 0; i < quizDraft.length; i++) {
    const q = quizDraft[i];
    if (!q.question || !q.question.trim()) {
      return showToast(`Question ${i + 1} has no text.`, 'error');
    }
    if (q.type === 'single' || q.type === 'multiple') {
      const filled = (q.options || []).filter(o => o && o.trim());
      if (filled.length < 2) return showToast(`Question ${i + 1} needs at least 2 filled options.`, 'error');
      if (!Array.isArray(q.correctIndexes) || q.correctIndexes.length === 0) {
        return showToast(`Question ${i + 1} has no correct answer selected.`, 'error');
      }
      if (q.correctIndexes.some(x => !q.options[x] || !q.options[x].trim())) {
        return showToast(`Question ${i + 1}: a chosen correct option is empty.`, 'error');
      }
      if (q.type === 'single' && q.correctIndexes.length !== 1) {
        return showToast(`Question ${i + 1}: single correct must have exactly ONE correct option.`, 'error');
      }
    }
    if (q.type === 'integer') {
      if (q.integerAnswer === null || q.integerAnswer === undefined || isNaN(q.integerAnswer)) {
        return showToast(`Question ${i + 1}: integer answer required.`, 'error');
      }
    }
    if (q.type === 'matrix') {
      const left  = (q.matrixLeftItems  || []).filter(x => x && x.trim());
      const right = (q.matrixRightItems || []).filter(x => x && x.trim());
      if (left.length < 2)  return showToast(`Question ${i + 1}: at least 2 List-I items required.`, 'error');
      if (right.length < 2) return showToast(`Question ${i + 1}: at least 2 List-II items required.`, 'error');
      if ((q.matrixRows || []).length < 2) return showToast(`Question ${i + 1}: at least 2 rows required.`, 'error');
    }
  }

  const btn = $('quizSaveBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }

  if (!quizPaperConfig.totalMarks) {
    quizPaperConfig.totalMarks = quizDraft.reduce((s, q) => s + (Number(q.marks) || 0), 0);
  }

  try {
    const res = await fetch(
      `https://aerospace-portal.onrender.com/api/courses/${quizEditingCourseId}/materials/${quizEditingMaterialId}/quiz`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quiz: quizDraft, examConfig: quizPaperConfig })
      }
    );
    const data = await res.json();
    if (data.success) {
      showToast('✅ Paper saved!', 'success');
      await fetchCoursesFromDB();
    } else {
      showToast(data.message || 'Failed to save.', 'error');
    }
  } catch (e) {
    console.error(e);
    showToast('Server error while saving.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Save Paper'; }
  }
}

function previewQuizPaper() {
  quizPaperConfig = {
    subject:    ($('qpSubject')?.value || '').trim(),
    paperCode:  ($('qpCode')?.value    || '').trim(),
    totalTime:  ($('qpTime')?.value    || '').trim(),
    totalMarks: parseInt($('qpMarks')?.value, 10) || 0
  };
  if (quizDraft.length === 0) return showToast('Add at least one question first.', 'info');

  const course = findCourse(quizEditingCourseId);
  const mat = (course.materials || []).find(m => m.id === quizEditingMaterialId);

  const emptyAnswer = q => q.type === 'integer' ? '' : [];
  quizPlayerState = {
    courseId: quizEditingCourseId,
    materialId: quizEditingMaterialId,
    materialTitle: mat ? mat.title : 'Preview',
    quiz: JSON.parse(JSON.stringify(quizDraft)),
    answers: quizDraft.map(emptyAnswer),
    submitted: false,
    response: null,
    previewMode: true,
    paperConfig: { ...quizPaperConfig }
  };
  renderQuizPlayer();
  openModal('quizPlayerModal');
}

let quizPlayerState = null;

function openQuizPlayer(courseId, materialId) {
  const course = findCourse(courseId); if (!course) return;
  const mat = course.materials.find(m => m.id === materialId); if (!mat) return;
  const quiz = mat.quiz || [];
  if (quiz.length === 0) return showToast('This test has no questions yet.', 'info');

  const normalized = quiz.map(q => normalizeQuestion(q));
  const emptyAnswer = q => q.type === 'integer' ? '' : [];

  const saved = restoreQuizAnswers(materialId);
  const initialAnswers = (saved && Array.isArray(saved) && saved.length === normalized.length)
    ? saved
    : normalized.map(emptyAnswer);

  quizPlayerState = {
    courseId, materialId,
    materialTitle: mat.title,
    quiz: normalized,
    answers: initialAnswers,
    submitted: false,
    response: null,
    paperConfig: mat.examConfig || {}
  };
  renderQuizPlayer();
  openModal('quizPlayerModal');
  startQuizTimer();
}

function renderQuizPlayer() {
  const st = quizPlayerState; if (!st) return;
  const cfg = st.paperConfig || {};
  const course = findCourse(st.courseId);
  const mat = course && (course.materials || []).find(m => m.id === st.materialId);
  const examCfg = cfg.subject ? cfg : (mat && mat.examConfig) || {};

  $('quizPlayerTitle').innerHTML =
    `<i class="fas fa-file-pen"></i> ${escapeHtml(examCfg.subject || st.materialTitle)}`;

  const headerInfo = `
    <div class="quiz-paper-header">
      ${examCfg.paperCode  ? `<span><i class="fas fa-hashtag"></i> ${escapeHtml(examCfg.paperCode)}</span>` : ''}
      ${examCfg.totalTime  ? `<span><i class="fas fa-clock"></i> ${escapeHtml(examCfg.totalTime)} <span id="quizTimerDisplay">--:--</span></span>` : ''}
      <span><i class="fas fa-list-ol"></i> ${st.quiz.length} question${st.quiz.length === 1 ? '' : 's'}</span>
      ${examCfg.totalMarks ? `<span><i class="fas fa-star"></i> Max Marks: ${examCfg.totalMarks}</span>` : ''}
    </div>`;

  if (!st.submitted) {
    const answered = st.quiz.reduce((s, q, i) => {
      const a = st.answers[i];
      if (q.type === 'integer') return s + (a !== '' && a !== null && a !== undefined && !isNaN(Number(a)) ? 1 : 0);
      if (q.type === 'matrix') {
        const rows = q.matrixRows || [];
        const filled = Array.isArray(a) ? a.filter(x => x !== undefined && x !== '').length : 0;
        return s + (filled >= rows.length ? 1 : 0);
      }
      return s + (Array.isArray(a) ? (a.length > 0 ? 1 : 0) : (a >= 0 ? 1 : 0));
    }, 0);

    $('quizPlayerSub').innerHTML = headerInfo;
    $('quizPlayerActions').innerHTML = `
      <span class="quiz-progress-indicator">${answered} / ${st.quiz.length} answered</span>
      <button type="button" class="btn btn-outline" onclick="closeModal('quizPlayerModal')">
        <i class="fas fa-times"></i> Cancel
      </button>
      <button type="button" class="btn btn-primary btn-lg" onclick="submitQuiz()" ${st.previewMode ? 'disabled title="Preview mode"' : ''}>
        <i class="fas fa-paper-plane"></i> Submit Test
      </button>`;

    let html = '';
    st.quiz.forEach((q, qi) => {
      const qType = q.type || 'single';
      const a = st.answers[qi];
      const isAnswered =
        qType === 'integer' ? (a !== '' && a !== null && a !== undefined && !isNaN(Number(a))) :
        qType === 'matrix'  ? (Array.isArray(a) && a.filter(x => x !== undefined && x !== '').length >= (q.matrixRows || []).length) :
                              (Array.isArray(a) ? a.length > 0 : (a >= 0));

      html += `<div class="quiz-play-card ${isAnswered ? 'answered' : ''}">
        <div class="quiz-play-qnum">
          Question ${qi + 1} of ${st.quiz.length}
          <span class="quiz-qtype-tag">${questionTypeLabel(qType)}</span>
          <span class="quiz-qmark-tag">+${q.marks || 4}${q.negativeMarks ? ' / ' + q.negativeMarks : ''}</span>
          ${isAnswered ? '<span class="quiz-answered-tag"><i class="fas fa-check-circle"></i> Answered</span>' : ''}
        </div>
        <h4 class="quiz-play-question latex-content">${escapeHtml(q.question)}</h4>
        ${renderStudentAnswerArea(q, qi)}
      </div>`;
    });
    $('quizPlayerBody').innerHTML = html;
    renderMathIn($('quizPlayerBody'));
    return;
  }

  const { score, total, percent, results, attempts, marksEarned, marksPossible } = st.response;
  const isPerfect = score === total;
  const isPass = percent >= 60;
  const emoji = isPerfect ? '🏆' : isPass ? '🎉' : '📚';
  const headline = isPerfect ? 'Perfect Score!' : isPass ? 'Well done!' : 'Keep practicing!';

  $('quizPlayerSub').innerHTML = `${headerInfo}<div style="margin-top:6px;">Attempt #${attempts}</div>`;
  $('quizPlayerActions').innerHTML = `
    <button type="button" class="btn btn-outline" onclick="retakeQuiz()"><i class="fas fa-redo"></i> Retake</button>
    <button type="button" class="btn btn-primary" onclick="closeModal('quizPlayerModal')"><i class="fas fa-check"></i> Done</button>`;

  let html = `<div class="quiz-result-hero ${isPass ? 'pass' : 'fail'}">
    <div class="quiz-result-emoji">${emoji}</div>
    <div class="quiz-result-score">${score} / ${total}</div>
    <div class="quiz-result-pct">${percent}%${marksPossible ? ` · ${marksEarned} / ${marksPossible} marks` : ''}</div>
    <div class="quiz-result-headline">${headline}</div>
  </div>`;

  st.quiz.forEach((q, qi) => {
    const r = results[qi]; const ok = r.correct;
    html += `<div class="quiz-result-item ${ok ? 'ok' : 'bad'}">
      <div class="quiz-result-head">
        <span class="quiz-result-badge ${ok ? 'ok' : 'bad'}">
          <i class="fas ${ok ? 'fa-check' : 'fa-times'}"></i>
        </span>
        <strong>Q${qi + 1}.</strong>
        <span class="latex-content">${escapeHtml(q.question)}</span>
      </div>
      <div class="quiz-result-body">
        ${renderResultDetail(q, r)}
        ${r.explanation ? `<div class="quiz-explain"><i class="fas fa-lightbulb"></i> <span class="latex-content">${escapeHtml(r.explanation)}</span></div>` : ''}
      </div>
    </div>`;
  });
  $('quizPlayerBody').innerHTML = html;
  renderMathIn($('quizPlayerBody'));
  stopQuizTimer();
}

function renderStudentAnswerArea(q, qi) {
  const st = quizPlayerState;
  const ans = st.answers[qi];
  const qType = q.type || 'single';

  if (qType === 'single' || qType === 'multiple') {
    const inputType = qType === 'single' ? 'radio' : 'checkbox';
    const name = `pq-${qi}`;
    return `<div class="quiz-play-options">
      ${(q.options || []).map((opt, oi) => {
        const checked = qType === 'single'
          ? (ans === oi || (Array.isArray(ans) && ans[0] === oi))
          : (Array.isArray(ans) && ans.includes(oi));
        return `<label class="quiz-play-option ${checked ? 'selected' : ''}">
          <input type="${inputType}" name="${name}" ${checked ? 'checked' : ''} style="display:none;"
                 onchange="selectQuizAnswerMulti(${qi}, ${oi}, this.checked, '${qType}')">
          <span class="quiz-play-letter">${String.fromCharCode(65 + oi)}</span>
          <span class="quiz-play-text latex-content">${escapeHtml(opt)}</span>
        </label>`;
      }).join('')}
    </div>`;
  }

  if (qType === 'integer') {
    return `<div class="form-group" style="margin-top:8px;">
      <label>Your Answer</label>
      <input type="number" step="any" placeholder="Enter a number"
             value="${ans === '' ? '' : (ans ?? '')}"
             oninput="selectQuizAnswerInteger(${qi}, this.value)">
    </div>`;
  }

  if (qType === 'matrix') {
    const left  = q.matrixLeftItems  || [];
    const right = q.matrixRightItems || [];
    const chosen = Array.isArray(ans) ? ans : [];
    return `
      <div class="matrix-match-student">
        ${left.map((item, li) => `
          <div class="matrix-match-row">
            <div class="matrix-match-item latex-content">
              <span class="quiz-play-letter">${String.fromCharCode(65 + li)}</span>
              <span>${escapeHtml(item)}</span>
            </div>
            <span class="matrix-arrow">→</span>
            <select onchange="selectQuizAnswerMatrix(${qi}, ${li}, this.value)">
              <option value="">— Select match —</option>
              ${right.map((rItem, ri) => {
                const label = ['P','Q','R','S','T','U','V','W'][ri] || (ri + 1);
                return `<option value="${ri}" ${Number(chosen[li]) === ri ? 'selected' : ''}>${label}. ${escapeHtml(rItem).slice(0, 60)}</option>`;
              }).join('')}
            </select>
          </div>
        `).join('')}
      </div>`;
  }
  return '';
}

function renderResultDetail(q, r) {
  const qType = q.type || 'single';

  if (qType === 'single' || qType === 'multiple') {
    const chosenIdx = Array.isArray(r.chosen) ? r.chosen : (r.chosen != null ? [r.chosen] : []);
    const correctIdx = r.correctIndexes || [];
    const fmt = idxs => idxs.length === 0
      ? '<em>Not answered</em>'
      : idxs.map(i => `<span class="latex-content">${escapeHtml(q.options[i] || '—')}</span>`).join(', ');
    return `
      <div class="quiz-answer-row"><span class="quiz-answer-label">Your answer:</span>
        <span class="${r.correct ? 'ok-text' : 'bad-text'}">${fmt(chosenIdx)}</span>
      </div>
      ${!r.correct ? `<div class="quiz-answer-row"><span class="quiz-answer-label">Correct:</span>
        <span class="ok-text">${fmt(correctIdx)}</span></div>` : ''}
    `;
  }

  if (qType === 'integer') {
    const tol = Number(r.integerTolerance) || 0;
    const tolStr = tol > 0 ? ` (±${tol})` : '';
    return `
      <div class="quiz-answer-row"><span class="quiz-answer-label">Your answer:</span>
        <span class="${r.correct ? 'ok-text' : 'bad-text'}">${r.chosen ?? '—'}</span>
      </div>
      ${!r.correct ? `<div class="quiz-answer-row"><span class="quiz-answer-label">Correct:</span>
        <span class="ok-text">${r.integerAnswer}${tolStr}</span></div>` : ''}
    `;
  }

  if (qType === 'matrix') {
    const rows = r.matrixRows || [];
    const chosen = Array.isArray(r.chosen) ? r.chosen : [];
    const rightLabels = ['P','Q','R','S','T','U','V','W'];
    return `
      <table class="matrix-result-table">
        <thead><tr><th>List-I</th><th>Your Match</th><th>Correct</th></tr></thead>
        <tbody>
          ${rows.map((row, ri) => {
            const ok = Number(chosen[ri]) === Number(row.correctIndex);
            return `<tr class="${ok ? 'ok-row' : 'bad-row'}">
              <td class="latex-content">${String.fromCharCode(65 + ri)}. ${escapeHtml(row.text)}</td>
              <td>${chosen[ri] != null && chosen[ri] !== '' ? (rightLabels[chosen[ri]] || '—') : '—'}</td>
              <td>${rightLabels[row.correctIndex] || '—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }
  return '';
}

function selectQuizAnswerMulti(qi, oi, isChecked, type) {
  const st = quizPlayerState; if (!st || st.submitted) return;
  if (type === 'single') st.answers[qi] = oi;
  else {
    let arr = Array.isArray(st.answers[qi]) ? st.answers[qi].slice() : [];
    if (isChecked) { if (!arr.includes(oi)) arr.push(oi); }
    else arr = arr.filter(x => x !== oi);
    st.answers[qi] = arr;
  }
  persistQuizAnswers();
  renderQuizPlayer();
}
function selectQuizAnswerInteger(qi, val) {
  const st = quizPlayerState; if (!st || st.submitted) return;
  st.answers[qi] = val;
  persistQuizAnswers();
}
function selectQuizAnswerMatrix(qi, li, val) {
  const st = quizPlayerState; if (!st || st.submitted) return;
  let arr = Array.isArray(st.answers[qi]) ? st.answers[qi].slice() : [];
  if (val === '') delete arr[li]; else arr[li] = parseInt(val, 10);
  st.answers[qi] = arr;
  persistQuizAnswers();
}
function selectQuizAnswer(qi, oi) { selectQuizAnswerMulti(qi, oi, true, 'single'); }

function retakeQuiz() {
  const st = quizPlayerState; if (!st) return;
  clearQuizAnswers(st.materialId);
  try { localStorage.removeItem('aero_quiz_start_' + st.materialId); } catch (e) {}
  openQuizPlayer(st.courseId, st.materialId);
}

async function submitQuiz() {
  const st = quizPlayerState; if (!st) return;
  if (st.previewMode) return showToast('Preview mode — nothing submitted.', 'info');

  for (let i = 0; i < st.quiz.length; i++) {
    const q = st.quiz[i];
    const a = st.answers[i];
    if (q.type === 'integer') {
      if (a === '' || a === null || a === undefined || isNaN(Number(a))) return showToast(`Please answer Q${i + 1}.`, 'error');
    } else if (q.type === 'matrix') {
      const rows = q.matrixRows || [];
      if (!Array.isArray(a) || a.filter(x => x !== undefined && x !== '').length < rows.length) return showToast(`Please match all items in Q${i + 1}.`, 'error');
    } else {
      if (Array.isArray(a) ? a.length === 0 : (a === null || a === undefined || a === -1)) return showToast(`Please answer Q${i + 1}.`, 'error');
    }
  }

  try {
    const res = await fetch(
      `https://aerospace-portal.onrender.com/api/user/quiz/${st.courseId}/${st.materialId}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser._id, answers: st.answers }) }
    );
    const data = await res.json();
    if (data.success) {
      st.submitted = true; st.response = data;
      stopQuizTimer();
      clearQuizAnswers(st.materialId);
      try { localStorage.removeItem('aero_quiz_start_' + st.materialId); } catch (e) {}
      if (!currentUser.quizResults) currentUser.quizResults = {};
      currentUser.quizResults[st.materialId] = {
        score: data.score, total: data.total, percent: data.percent,
        marksEarned: data.marksEarned, marksPossible: data.marksPossible,
        attempts: data.attempts, lastAttemptAt: new Date().toISOString()
      };
      saveSessionUser(currentUser);
      _analyticsCacheAt = 0;
      renderQuizPlayer();
      const pct = data.percent;
      if (pct === 100) showToast('🏆 Perfect!', 'success');
      else if (pct >= 60) showToast(`🎉 Scored ${data.score}/${data.total}!`, 'success');
      else showToast(`📚 Scored ${data.score}/${data.total}.`, 'info');
    } else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

/* ============================================================
   FILE VIEWER / VIDEO / BOOKMARK / PROGRESS
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

async function openMaterialVideo(courseId, materialId) {
  if (!currentUser) return showToast('Please log in first.', 'error');
  const course = findCourse(courseId);
  if (!course) return;
  const mat = course.materials.find(m => m.id === materialId);
  if (!mat || !mat.url) return showToast('No video URL set for this material.', 'error');

  try {
    const res = await fetch(
      `https://aerospace-portal.onrender.com/api/materials/${courseId}/${materialId}/video-session`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser._id })
      }
    );
    const data = await res.json();
    if (!data.success) return showToast(data.message || 'Could not load video.', 'error');

    const baseOpts = {
      materialId: mat.id,
      courseId: course.id,
      title: mat.title,
      username: currentUser.fullName || currentUser.username || 'Student'
    };

    if (data.kind === 'youtube' && data.videoId) {
      window.VideoPlayer.open({ ...baseOpts, videoId: data.videoId });
    } else if (data.kind === 'direct' && data.directUrl) {
      window.VideoPlayer.open({ ...baseOpts, src: data.directUrl });
    } else {
      showToast('Unsupported video response from server.', 'error');
    }
  } catch {
    showToast('Server error loading video.', 'error');
  }
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
      saveSessionUser(currentUser);
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
      saveSessionUser(currentUser);
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
      saveSessionUser(currentUser);
    }
  } catch {}
}

/* ============================================================
   COURSE MODAL
   ============================================================ */
function openAddCourseModal() {
  addingCourse = true;
  addingProfessor = false;
  addingMaterialCourseId = null;
  addingStudent = false;
  pushHash('#/admin/course/new');
  renderApp();
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
    status: 'published'
  };
  if (!payload.name || !payload.code) return showToast('Name and code required.', 'error');
  try {
    const response = await fetch('https://aerospace-portal.onrender.com/api/courses', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (data.success) {
      showToast('🎉 Course created & published!', 'success');
      closeModal('courseModal');
      await fetchCoursesFromDB();
      if (data.course && data.course._id) openCourseEditor(data.course._id);
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

async function publishCourse(courseId) {
  try {
    const res = await fetch(`https://aerospace-portal.onrender.com/api/courses/${courseId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'published' })
    });
    const data = await res.json();
    if (data.success) {
      showToast('🚀 Course published!', 'success');
      fetchCoursesFromDB();
    } else {
      showToast(data.message || 'Failed to publish.', 'error');
    }
  } catch {
    showToast('Server error.', 'error');
  }
}

/* ============================================================
   PROFESSORS
   ============================================================ */
function openAddProfessorModal() {
  addingProfessor = true;
  addingCourse = false;
  addingMaterialCourseId = null;
  addingStudent = false;
  pushHash('#/admin/professor/new');
  renderApp();
}
async function saveProfessor(e) {
  e.preventDefault();
  const name = $('professorName').value.trim();
  const title = $('professorTitle').value.trim();
  if (!name || !title) return showToast('Name and Title are required.', 'error');

  const processSave = async (photoData) => {
    const payload = {
      name, title,
      description: $('professorDescription').value.trim(),
      photo: photoData || ''
    };
    try {
      const res = await fetch(`${API_BASE}/professors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        showToast('✓ Professor added!', 'success');
        closeModal('professorModal');
        await fetchProfessorsFromDB();
        renderApp();
      } else {
        showToast(data.message || 'Failed.', 'error');
      }
    } catch { showToast('Server error.', 'error'); }
  };

  const photoFile = $('professorPhoto').files ? $('professorPhoto').files[0] : null;
  if (photoFile) {
    const reader = new FileReader();
    reader.onload = ev => processSave(ev.target.result);
    reader.readAsDataURL(photoFile);
  } else processSave(null);
}
async function deleteProfessor(professorId) {
  if (!confirm('Delete this professor?')) return;
  try {
    const res = await fetch(`${API_BASE}/professors/${professorId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('Deleted.', 'info');
      await fetchProfessorsFromDB();
      renderApp();
    } else {
      showToast(data.message || 'Failed.', 'error');
    }
  } catch { showToast('Server error.', 'error'); }
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
  addingMaterialCourseId = courseId;
  addingCourse = false;
  addingProfessor = false;
  addingStudent = false;
  pushHash(`#/admin/course/${courseId}/material/new`);
  renderApp();
}

function goBackToCourseEditorFromMaterial() {
  const courseId = addingMaterialCourseId;
  addingMaterialCourseId = null;
  openCourseEditor(courseId);
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
      key: data.key_id, // <-- FIXED: Use the key sent from the backend
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
          saveSessionUser(currentUser);
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
  const savedUser = loadSessionUser();
  if (savedUser) {
    currentUser = savedUser;
    if (currentUser.role === 'admin') adminTab = 'overview';
  }
  updateThemeIcon();
  syncHashToState();
  renderApp();
  await fetchCoursesFromDB();
  await fetchProfessorsFromDB();
  await fetchSubscriptionSettings();
  await refreshUserData();
  await loadNotifications();
  renderApp();
}
/* ============================================================
   STUDENT ANALYTICS DASHBOARD
   ============================================================ */
let _analyticsCharts = [];
let _analyticsCache = null;
let _analyticsCacheAt = 0;
const ANALYTICS_CACHE_MS = 60 * 1000;

function destroyAnalyticsCharts() {
  while (_analyticsCharts.length) {
    try { _analyticsCharts.pop().destroy(); } catch (e) {}
  }
}

function toDateKeyLocal(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

async function renderStudentAnalytics() {
  const container = document.getElementById('analyticsContent');
  if (!container) return;

  destroyAnalyticsCharts();
  container.innerHTML = '';

  const now = Date.now();
  const fresh = _analyticsCache && (now - _analyticsCacheAt < ANALYTICS_CACHE_MS);

  if (!fresh) {
    container.innerHTML = `
      <div class="analytics-loading">
        <div class="pdfv-spinner"></div>
        <p>Crunching your data…</p>
      </div>`;
    try {
      const res = await fetch(
        `https://aerospace-portal.onrender.com/api/user/analytics/${currentUser._id}?t=${now}`
      );
      const data = await res.json();
      if (!data.success) {
        container.innerHTML = `
          <div class="analytics-empty">
            <i class="fas fa-triangle-exclamation"></i>
            <h3>Could not load analytics</h3>
            <p>${escapeHtml(data.message || 'Server error')}</p>
          </div>`;
        return;
      }
      _analyticsCache = data.analytics;
      _analyticsCacheAt = now;
    } catch (err) {
      container.innerHTML = `
        <div class="analytics-empty">
          <i class="fas fa-triangle-exclamation"></i>
          <h3>Network error</h3>
          <p>Could not reach the server. Check your connection and try again.</p>
        </div>`;
      return;
    }
  }

  renderAnalyticsUI(_analyticsCache);
}

function renderAnalyticsUI(a) {
  const container = document.getElementById('analyticsContent');
  if (!container) return;

  container.innerHTML = '';
  destroyAnalyticsCharts();

  const { summary, heatmap, weekly, quizTrend, courseProgress } = a;

  if (summary.studyDays === 0 && summary.totalQuizzes === 0 && summary.totalMaterialsCompleted === 0) {
    container.innerHTML = `
      <div class="analytics-empty">
        <i class="fas fa-chart-line"></i>
        <h3>No activity yet</h3>
        <p>Start watching lectures, reading PDFs, and taking quizzes — your progress will show up here.</p>
        <button class="btn btn-primary" style="margin-top:18px;" onclick="navigateStudent('courses')">
          <i class="fas fa-graduation-cap"></i> Browse Courses
        </button>
      </div>`;
    return;
  }

  const heatmapCells = buildHeatmapCells(heatmap);
  const firstDay = heatmapCells[0]?.date || '';
  const lastDay = heatmapCells[heatmapCells.length - 1]?.date || '';

  container.innerHTML = `
    <div class="analytics-summary">
      <div class="analytics-stat">
        <div class="analytics-stat-icon tone-brand"><i class="fas fa-calendar-check"></i></div>
        <div class="analytics-stat-body">
          <div class="analytics-stat-num">${summary.studyDays}</div>
          <div class="analytics-stat-label">Study Days</div>
        </div>
      </div>
      <div class="analytics-stat">
        <div class="analytics-stat-icon tone-emerald"><i class="fas fa-circle-check"></i></div>
        <div class="analytics-stat-body">
          <div class="analytics-stat-num">${summary.totalMaterialsCompleted}</div>
          <div class="analytics-stat-label">Materials Done</div>
        </div>
      </div>
      <div class="analytics-stat">
        <div class="analytics-stat-icon tone-cyan"><i class="fas fa-question-circle"></i></div>
        <div class="analytics-stat-body">
          <div class="analytics-stat-num">${summary.totalQuizzes}</div>
          <div class="analytics-stat-label">Quizzes Taken</div>
        </div>
      </div>
      <div class="analytics-stat">
        <div class="analytics-stat-icon tone-gold"><i class="fas fa-bullseye"></i></div>
        <div class="analytics-stat-body">
          <div class="analytics-stat-num">${summary.avgQuizScore}%</div>
          <div class="analytics-stat-label">Avg Quiz Score</div>
        </div>
      </div>
      <div class="analytics-stat">
        <div class="analytics-stat-icon tone-rose"><i class="fas fa-fire"></i></div>
        <div class="analytics-stat-body">
          <div class="analytics-stat-num">${summary.currentStreak}</div>
          <div class="analytics-stat-label">Current Streak${summary.currentStreak === 1 ? '' : 's'}</div>
        </div>
      </div>
    </div>

    <div class="analytics-card">
      <div class="analytics-card-header">
        <div>
          <div class="analytics-card-title"><i class="fas fa-fire"></i> Activity Heatmap</div>
          <div class="analytics-card-sub">
            ${summary.studyDays} active day${summary.studyDays === 1 ? '' : 's'} in the last 12 months
            · Longest streak: ${summary.longestStreak} day${summary.longestStreak === 1 ? '' : 's'}
          </div>
        </div>
      </div>
      <div class="heatmap-scroll">
        <div class="heatmap-grid">
          ${heatmapCells.map(c => `
            <div class="heatmap-cell"
                 data-level="${c.level}"
                 title="${c.title}"></div>
          `).join('')}
        </div>
      </div>
      <div class="heatmap-footer">
        <span>${firstDay ? formatShortDate(firstDay) : ''} — ${lastDay ? formatShortDate(lastDay) : 'today'}</span>
        <div class="heatmap-legend">
          <span>Less</span>
          <div class="heatmap-legend-swatches">
            <span style="background:var(--bg-surface-3);"></span>
            <span style="background:#a7f3d0;"></span>
            <span style="background:#6ee7b7;"></span>
            <span style="background:#34d399;"></span>
            <span style="background:#059669;"></span>
          </div>
          <span>More</span>
        </div>
      </div>
    </div>

    <div class="analytics-charts-row">
      <div class="chart-card">
        <div class="chart-card-title"><i class="fas fa-chart-column"></i> Weekly Activity — Last 12 Weeks</div>
        <div class="chart-wrap"><canvas id="chartWeekly"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-title"><i class="fas fa-chart-line"></i> Quiz Score Trend</div>
        <div class="chart-wrap">
          ${quizTrend.length === 0
            ? `<div class="analytics-empty" style="padding:40px 20px;height:100%;display:flex;flex-direction:column;justify-content:center;">
                 <i class="fas fa-clipboard-question"></i>
                 <p>No quizzes taken yet — take a quiz to see your score trend.</p>
               </div>`
            : `<canvas id="chartQuizTrend"></canvas>`}
        </div>
      </div>
    </div>

    <div class="analytics-card">
      <div class="analytics-card-header">
        <div>
          <div class="analytics-card-title"><i class="fas fa-book-open"></i> Course Progress</div>
          <div class="analytics-card-sub">${courseProgress.length} course${courseProgress.length === 1 ? '' : 's'} with materials</div>
        </div>
      </div>
      ${courseProgress.length === 0
        ? `<div class="analytics-empty" style="padding:40px 20px;">
             <i class="fas fa-book-open"></i>
             <p>No course materials available yet.</p>
           </div>`
        : `<div class="course-progress-list">
             ${courseProgress.map(cp => `
               <div class="course-progress-row">
                 <div class="course-progress-top">
                   <span class="course-progress-name" title="${escapeHtml(cp.courseName)}">
                     ${escapeHtml(cp.courseName)}
                     ${cp.courseCode ? `<span style="color:var(--text-tertiary);font-weight:500;"> · ${escapeHtml(cp.courseCode)}</span>` : ''}
                   </span>
                   <span class="course-progress-pct">${cp.percent}%</span>
                 </div>
                 <div class="course-progress-track">
                   <div class="course-progress-fill" style="width:${cp.percent}%;"></div>
                 </div>
                 <div class="course-progress-meta">${cp.completed} of ${cp.total} materials completed</div>
               </div>
             `).join('')}
           </div>`}
    </div>
  `;

  const _buildCharts = () => {
    if (typeof Chart === 'undefined') {
      console.warn('Chart.js not loaded — charts skipped.');
      return;
    }
    try { buildWeeklyChart(weekly); } catch (e) { console.warn('Weekly chart error:', e); }
    if (quizTrend.length > 0) {
      try { buildQuizTrendChart(quizTrend); } catch (e) { console.warn('Quiz trend chart error:', e); }
    }
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(_buildCharts));
  } else {
    setTimeout(_buildCharts, 50);
  }
}

function buildHeatmapCells(heatmapArr) {
  const counts = {};
  (heatmapArr || []).forEach(h => { counts[h.date] = h.count; });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  const startDow = start.getDay();
  start.setDate(start.getDate() - startDow);

  const cells = [];
  const cur = new Date(start);
  while (cur <= today) {
    const key = toDateKeyLocal(cur);
    const count = counts[key] || 0;
    let level = 0;
    if (count >= 8) level = 4;
    else if (count >= 5) level = 3;
    else if (count >= 3) level = 2;
    else if (count >= 1) level = 1;

    const pretty = cur.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const label = count === 0
      ? `No activity · ${pretty}`
      : `${count} activit${count === 1 ? 'y' : 'ies'} · ${pretty}`;

    cells.push({ date: key, count, level, title: label });
    cur.setDate(cur.getDate() + 1);
  }
  return cells;
}

function formatShortDate(key) {
  try {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  } catch { return key; }
}

function _chartTheme() {
  const s = getComputedStyle(document.documentElement);
  return {
    text: s.getPropertyValue('--text-secondary').trim() || '#475569',
    textMuted: s.getPropertyValue('--text-tertiary').trim() || '#8896a8',
    grid: s.getPropertyValue('--border-subtle').trim() || '#e8ecf4',
    brand: s.getPropertyValue('--brand-500').trim() || '#6366f1',
    brandLight: s.getPropertyValue('--brand-300').trim() || '#a5b4fc',
    accent: s.getPropertyValue('--accent-500').trim() || '#06b6d4',
    gold: s.getPropertyValue('--gold-500').trim() || '#f59e0b',
    emerald: s.getPropertyValue('--emerald-500').trim() || '#10b981'
  };
}

function buildWeeklyChart(weekly) {
  const el = document.getElementById('chartWeekly');
  if (!el) return;
  const th = _chartTheme();
  const ctx = el.getContext('2d');

  const chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: weekly.map(w => w.label),
      datasets: [
        {
          label: 'Materials viewed',
          data: weekly.map(w => w.views),
          backgroundColor: th.brand,
          borderRadius: 4,
          borderSkipped: false,
          barPercentage: 0.7,
          categoryPercentage: 0.7
        },
        {
          label: 'Quizzes taken',
          data: weekly.map(w => w.quizzes),
          backgroundColor: th.emerald,
          borderRadius: 4,
          borderSkipped: false,
          barPercentage: 0.7,
          categoryPercentage: 0.7
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: th.text,
            font: { size: 11, family: 'Inter' },
            boxWidth: 12,
            boxHeight: 12,
            padding: 12,
            usePointStyle: true,
            pointStyle: 'rectRounded'
          }
        },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,.95)',
          titleColor: '#fff',
          bodyColor: '#e2e8f0',
          borderColor: 'rgba(255,255,255,.12)',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
          titleFont: { size: 12, family: 'Inter', weight: '700' },
          bodyFont: { size: 12, family: 'Inter' }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: th.textMuted, font: { size: 10, family: 'Inter' } }
        },
        y: {
          beginAtZero: true,
          grid: { color: th.grid, drawBorder: false },
          ticks: { color: th.textMuted, font: { size: 10, family: 'Inter' }, precision: 0 }
        }
      }
    }
  });
  _analyticsCharts.push(chart);
}

function buildQuizTrendChart(quizTrend) {
  const el = document.getElementById('chartQuizTrend');
  if (!el) return;
  const th = _chartTheme();
  const ctx = el.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, 0, 240);
  gradient.addColorStop(0, 'rgba(99,102,241,0.35)');
  gradient.addColorStop(1, 'rgba(99,102,241,0.02)');

  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: quizTrend.map(q => formatShortDate(q.date)),
      datasets: [{
        label: 'Score %',
        data: quizTrend.map(q => q.percent),
        borderColor: th.brand,
        backgroundColor: gradient,
        fill: true,
        tension: 0.35,
        borderWidth: 2.5,
        pointRadius: 4,
        pointBackgroundColor: th.brand,
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
        pointHoverRadius: 6,
        pointHoverBackgroundColor: th.brand,
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,.95)',
          titleColor: '#fff',
          bodyColor: '#e2e8f0',
          borderColor: 'rgba(255,255,255,.12)',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
          titleFont: { size: 12, family: 'Inter', weight: '700' },
          bodyFont: { size: 12, family: 'Inter' },
          callbacks: {
            label: function (ctx2) {
              const item = quizTrend[ctx2.dataIndex];
              return `  ${item.score}/${item.total} correct (${item.percent}%)`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: th.textMuted,
            font: { size: 10, family: 'Inter' },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8
          }
        },
        y: {
          beginAtZero: true,
          max: 100,
          grid: { color: th.grid, drawBorder: false },
          ticks: {
            color: th.textMuted,
            font: { size: 10, family: 'Inter' },
            callback: v => v + '%',
            stepSize: 25
          }
        }
      }
    }
  });
  _analyticsCharts.push(chart);
}

const _origToggleMaterialViewed = window.toggleMaterialViewed;
const _origApplyTheme = window.applyTheme;
document.addEventListener('click', (e) => {
  if (e.target.closest('#themeToggle')) {
    _analyticsCacheAt = 0;
  }
});

// Listen for both hash changes and browser back/forward buttons
window.addEventListener('hashchange', () => { syncHashToState(); renderApp(); });
window.addEventListener('popstate', () => { syncHashToState(); renderApp(); });
// Auto-switch role based on username input
document.getElementById('loginUsername')?.addEventListener('input', (e) => {
  const val = e.target.value.trim().toLowerCase();
  if (val === 'admin') {
    setLoginRole('admin');
  } else if (loginRole === 'admin' && val !== 'admin') {
    setLoginRole('student');
  }
});
initApp();