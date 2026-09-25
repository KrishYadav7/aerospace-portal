/* ============================================================
   API CONFIGURATION
   ============================================================ */
const API_BASE = '/api';

/* ============================================================
   ONE-TIME CACHE WIPE (v2)
   ------------------------------------------------------------
   Nukes the Service Worker cache and forces an SW update ONCE
   per bundle version. This clears any PDF the student had cached
   from when the file was still free — so the very next request
   goes back to the server and hits the premium gate.
   ============================================================ */
(function bustStalePdfCache() {
  try {
    const KEY = 'aero_cache_bust_v2';
    if (localStorage.getItem(KEY)) return;
    localStorage.setItem(KEY, '1');

    if (window.caches && caches.keys) {
      caches.keys().then(keys => keys.forEach(k => caches.delete(k))).catch(() => {});
    }
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      navigator.serviceWorker.getRegistrations().then(regs =>
        regs.forEach(r => r.update().catch(() => {}))
      ).catch(() => {});
    }
    console.log('[cache] One-time cache wipe complete.');
  } catch (e) {}
})();

/* ============================================================
   withAuthToken — append ?auth=<jwt> to same-origin protected URLs
   ------------------------------------------------------------
   PDF.js and <video> elements make RAW fetches that do NOT pass
   through the global fetch interceptor. Without the token, the
   server treats every /uploads/* request as a guest — which made
   the premium gate fall through and serve paid files for free.
   ============================================================ */
function withAuthToken(url) {
  if (!url || typeof url !== 'string') return url;
  if (!url.startsWith('/uploads/') && !url.startsWith('/api/')) return url;
  try {
    const token = sessionStorage.getItem('aero_token');
    if (!token) return url;
    if (/[?&]auth=/.test(url)) return url;          // already has it
    const sep = url.includes('?') ? '&' : '?';
    return url + sep + 'auth=' + encodeURIComponent(token);
  } catch (e) {
    return url;
  }
}
/* ============================================================
   GLOBAL FETCH INTERCEPTOR — auto-attach Authorization header
   ------------------------------------------------------------
   Every /api/* call gets the session token (if available) so
   the backend can enforce single-device login server-side.
   This wrapper is installed ONCE and is completely transparent:
   it only adds a header, it never blocks or alters requests.
   ============================================================ */
/* ============================================================
   GLOBAL FETCH INTERCEPTOR — v2 (with stale-session recovery)
   ------------------------------------------------------------
   • Attaches the session token to every /api/* call
   • Detects 401 on PROTECTED endpoints and forces a clean
     re-login (prevents the "silent 401 retry loop")
   • Whitelists auth endpoints so bad credentials don't nuke
     a valid session
   ============================================================ */
(function installFetchAuthInterceptor() {
  if (window.__aeroFetchInterceptorInstalled) return;
  window.__aeroFetchInterceptorInstalled = true;

  const _originalFetch = window.fetch.bind(window);

  const AUTH_ENDPOINTS = [
    '/api/login',
    '/api/register',
    '/api/send-otp',
    '/api/admin/login/verify-otp',
    '/api/admin/login/resend-otp',
    '/api/forgot-username/send-otp',
    '/api/forgot-username/verify',
    '/api/forgot-password/send-otp',
    '/api/forgot-password/verify',
    '/api/forgot-password/reset',
    '/api/auth/logout',
    '/api/auth/session-check'
  ];

  function isAuthEndpoint(url) {
    for (let i = 0; i < AUTH_ENDPOINTS.length; i++) {
      if (url.indexOf(AUTH_ENDPOINTS[i]) !== -1) return true;
    }
    return false;
  }

  window.fetch = function (input, init) {
    let url = '';
    try {
      url = typeof input === 'string'
        ? input
        : (input && input.url) ? input.url : '';
    } catch (e) { url = ''; }

    const isApiCall = url && url.indexOf('/api/') !== -1;

    // ── Attach Authorization header ──
    if (isApiCall) {
      try {
        let token = null;
        try { token = sessionStorage.getItem('aero_token'); } catch (e) {}
        if (token) {
          init = init || {};
          const baseHeaders = init.headers || {};
          const hasAuth = baseHeaders['Authorization'] || baseHeaders['authorization'];
          if (!hasAuth) {
            init.headers = Object.assign({}, baseHeaders, {
              'Authorization': 'Bearer ' + token
            });
          }
        }
      } catch (e) { /* fail-safe: never break a request */ }
    }

    const responsePromise = _originalFetch(input, init);

    // ── Detect stale session (401 on a protected endpoint) ──
    if (isApiCall && !isAuthEndpoint(url)) {
      responsePromise.then(function (res) {
        if (res.status !== 401) return;

        let hasUser = false;
        try { hasUser = !!sessionStorage.getItem('aero_user'); } catch (e) {}
        if (!hasUser) return;
        if (window.__aeroHandlingStaleSession) return;

        window.__aeroHandlingStaleSession = true;
        console.warn('[fetch] 401 on protected endpoint — stale session:', url);

        try { sessionStorage.removeItem('aero_user');  } catch (e) {}
        try { sessionStorage.removeItem('aero_token'); } catch (e) {}

        setTimeout(function () {
          if (typeof window.__aeroHandleStaleSession === 'function') {
            window.__aeroHandleStaleSession(
              'Your session has expired. Please log in again.'
            );
          } else {
            location.reload();
          }
        }, 50);
      }).catch(function () { /* network error — ignore */ });
    }

    return responsePromise;
  };
})();

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
   File Upload Helper
   ------------------------------------------------------------
   • Small files (< 6 MB) → single POST /api/upload
   • Large files (≥ 6 MB) → chunked upload (bypasses Hostinger's
     10 MB proxy limit)
   ============================================================ */
const CHUNKED_THRESHOLD = 6 * 1024 * 1024; // 6 MB

async function uploadFileToServer(file, onProgress) {
  if (file.size >= CHUNKED_THRESHOLD) {
    return uploadFileChunked(file, onProgress);
  }
  return uploadFileDirect(file, onProgress);
}

/* ---- Direct single-shot upload (small files) ---- */
function uploadFileDirect(file, onProgress) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/upload`);
    xhr.timeout = 1800000;

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.success) resolve(data);
          else reject(new Error(data.message || 'Upload failed'));
        } catch (e) {
          reject(new Error('Invalid response from server'));
        }
      } else {
        reject(new Error(`Upload failed (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror   = () => reject(new Error('Network error during upload'));
    xhr.ontimeout = () => reject(new Error('Upload timed out'));

    xhr.send(formData);
  });
}

/* ---- Chunked upload (large files) ---- */
async function uploadFileChunked(file, onProgress) {
  // 1) Init session
  const initRes = await fetchJSON(`${API_BASE}/upload/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || 'application/octet-stream'
    })
  });
  if (!initRes.success) throw new Error(initRes.message || 'Could not start upload.');

  const { uploadId, chunkSize, totalChunks } = initRes;

  // 2) Upload chunks in parallel (3 at a time) — 3x faster
  let completedChunks = 0;
  const CONCURRENCY = 3;

  const uploadOneChunk = async (i) => {
    const start = i * chunkSize;
    const end   = Math.min(start + chunkSize, file.size);
    const blob  = file.slice(start, end);

    const fd = new FormData();
    fd.append('uploadId',   uploadId);
    fd.append('chunkIndex', i);
    fd.append('chunk',      blob, `${file.name}.part${i}`);

    const chunkRes = await fetchJSON(`${API_BASE}/upload/chunk`, {
      method: 'POST',
      body: fd
    });
    if (!chunkRes.success) throw new Error(chunkRes.message || `Chunk ${i + 1} failed.`);

    completedChunks++;
    if (onProgress) {
      onProgress(Math.round((completedChunks / totalChunks) * 100));
    }
  };

  // Batch parallel uploads — keeps server memory bounded
  for (let i = 0; i < totalChunks; i += CONCURRENCY) {
    const batch = [];
    for (let j = 0; j < CONCURRENCY && (i + j) < totalChunks; j++) {
      batch.push(uploadOneChunk(i + j));
    }
    await Promise.all(batch);
  }

  // 3) Ask server to assemble
  const doneRes = await fetchJSON(`${API_BASE}/upload/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId })
  });
  if (!doneRes.success) throw new Error(doneRes.message || 'Assembly failed.');

  return doneRes;
}
/* ============================================================
   PROFESSORS (MongoDB — centralized database)
   ============================================================ */
let liveProfessors = [];
let _professorsCacheAt = 0;
const PROFESSORS_CACHE_MS = 30 * 1000;   // 30s — short enough for live hide/show

function getProfessors() { return liveProfessors; }
function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

async function fetchProfessorsFromDB(force = false) {
  // Reuse the in-memory list if it's still fresh (unless force=true)
  if (!force && liveProfessors.length > 0 &&
      (Date.now() - _professorsCacheAt) < PROFESSORS_CACHE_MS) {
    return;
  }

  try {
    // ?_t= cache-buster + cache:'no-store' → guaranteed fresh network read
    const response = await fetch(
      `${API_BASE}/professors?_t=${Date.now()}`,
      { cache: 'no-store' }
    );
    const data = await response.json();
    if (data.success) {
      liveProfessors = data.professors.map(p => ({
        ...p,
        id: p._id || p.id
      }));
      _professorsCacheAt = Date.now();
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
  try {
    if (user)  sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(user));
    if (token) sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch (e) {
    // Private-browsing / quota / disabled-storage — never block login
    console.warn('[session] saveSession failed (non-fatal):', e);
  }
}
function saveSessionUser(user) {
  try {
    if (user) sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(user));
  } catch (e) {
    console.warn('[session] saveSessionUser failed (non-fatal):', e);
  }
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
/* ============================================================
   COURSE LOADING STATE
   ------------------------------------------------------------
   Two extra guards added to fix the "blank courses until refresh"
   bug that survived the earlier _coursesLoading fix:

     1. _coursesFetchGeneration — a monotonic counter. Only the
        LATEST fetch chain is allowed to write to liveCourses or
        clear _coursesLoading. Stale responses from an older
        chain (e.g. login's fetch vs. the navigate fetch that
        raced against it) are dropped on the floor.

     2. _coursesLoadingWatchdog — a hard 15s timeout. If any
        chain ever leaves _coursesLoading stuck `true` (network
        hang, unhandled throw, page-2+ failure), the watchdog
        force-resets the flag and re-renders. This makes the
        "stuck on skeleton forever" state physically impossible.
   ============================================================ */
let _coursesLoading = false;
let _coursesFetchGeneration = 0;
let _coursesLoadingWatchdog = null;
const COURSES_LOADING_MAX_MS = 15000;

function _startCoursesLoading() {
  _coursesLoading = true;
  if (_coursesLoadingWatchdog) clearTimeout(_coursesLoadingWatchdog);
  _coursesLoadingWatchdog = setTimeout(() => {
    if (_coursesLoading) {
      console.warn('[courses] ⚠️ Loading watchdog fired — force-resetting flag');
      _coursesLoading = false;
      _coursesLoadingWatchdog = null;
      try { renderApp(); } catch (e) {}
    }
  }, COURSES_LOADING_MAX_MS);
}

function _stopCoursesLoading() {
  _coursesLoading = false;
  if (_coursesLoadingWatchdog) {
    clearTimeout(_coursesLoadingWatchdog);
    _coursesLoadingWatchdog = null;
  }
}

function renderCoursesLoadingSkeleton(message) {
  const skelCards = Array.from({ length: 6 }).map(() => `
    <div class="course-skeleton-card">
      <div class="skel-line chip"></div>
      <div class="skel-line tall w-80"></div>
      <div class="skel-line w-60"></div>
      <div class="skel-line w-40"></div>
      <div class="skel-line w-100"></div>
      <div class="skel-row">
        <div class="skel-btn"></div>
        <div class="skel-btn"></div>
      </div>
    </div>
  `).join('');

  return `
    <div class="courses-loading">
      <div class="pdfv-spinner"></div>
      <p>${escapeHtml(message || 'Loading courses…')}</p>
    </div>
    <div class="courses-skeleton-grid">${skelCards}</div>
  `;
}
function getCourses() { return liveCourses; }
function findCourse(id) { return getCourses().find(c => c.id === id) || null; }

/* Client-side course catalog cache.
   - Students: cached for 60s → instant navigation between pages.
   - Admins:   always fresh → no risk of stale admin dashboard.
   - Manual refresh: call fetchCoursesFromDB(true). */
let _courseCacheAt = 0;
const COURSE_CACHE_MS = 5*60 * 1000;

let _coursePagination = { page: 1, hasMore: false, total: 0 };

async function fetchCoursesFromDB(force = false, page = 1) {
  const isAdmin = currentUser && currentUser.role === 'admin';

  if (!force && !isAdmin && page === 1 && liveCourses.length > 0
      && (Date.now() - _courseCacheAt) < COURSE_CACHE_MS) {
    renderApp();
    return;
  }

  // ⭐ Generation guard — bumped ONLY on the first page of a fresh
  //    chain. Any page-1 call racing against an existing chain will
  //    invalidate that older chain so it stops writing state.
  let myGeneration = _coursesFetchGeneration;
  if (page === 1) {
    myGeneration = ++_coursesFetchGeneration;
    _startCoursesLoading();

    if (currentUser) {
      const isAdminUser = String(currentUser.role || '').toLowerCase() === 'admin';
      if (isAdminUser && adminTab === 'courses') {
        const el = $('adminCourseList');
        if (el) el.innerHTML = renderCoursesLoadingSkeleton('Loading courses…');
      } else if (!isAdminUser && studentNav === 'courses') {
        const el = $('studentCourseList');
        if (el) el.innerHTML = renderCoursesLoadingSkeleton('Loading courses…');
      }
    }
  }

  let pageFailed = false;

  try {
    const PER_PAGE = 80;
    const data = await fetchJSON(
      `${API_BASE}/courses?limit=${PER_PAGE}&page=${page}&_t=${Date.now()}`
    );

    // ⭐ Stale-response bail-out. If a newer chain started while we
    //    were awaiting the network, drop this response completely —
    //    do NOT overwrite liveCourses, do NOT touch pagination.
    if (myGeneration !== _coursesFetchGeneration) {
      console.log(
        `[courses] stale response (gen ${myGeneration} ≠ ${_coursesFetchGeneration}) — dropped`
      );
      return;
    }

    const list = Array.isArray(data) ? data : (data.courses || []);
    const pagination = data.pagination || { page, hasMore: false, total: list.length };

    const normalized = list.map(course => ({
      ...course,
      id: course._id,
      materials: (course.materials || []).map(m => ({ ...m, id: m._id })),
      playlists: course.playlists || []
    }));

    if (page === 1) {
      liveCourses = normalized;
    } else {
      liveCourses = [...liveCourses, ...normalized];
    }

    _coursePagination = pagination;
    _courseCacheAt = Date.now();

    console.log(
      `[courses] page ${page}: fetched ${list.length}, total ${pagination.total}, hasMore=${pagination.hasMore}`
    );

    if (pagination.hasMore && page < 20) {
      return await fetchCoursesFromDB(force, page + 1);
    }
  } catch (error) {
    pageFailed = true;
    console.error('Error fetching courses:', error);
    if (page === 1) {
      const errHtml = `
        <div class="empty-state" style="border-color:var(--rose-500);">
          <i class="fas fa-triangle-exclamation" style="color:var(--rose-500);opacity:.9;"></i>
          <p style="color:var(--rose-500);font-weight:600;">Could not load courses</p>
          <p style="margin-top:8px;font-size:13px;max-width:520px;margin-left:auto;margin-right:auto;line-height:1.5;">
            ${escapeHtml(error.message || 'Network error.')}
          </p>
          <button class="btn btn-outline" style="margin-top:16px;" onclick="fetchCoursesFromDB(true)">
            <i class="fas fa-rotate"></i> Try Again
          </button>
        </div>`;
      const isAdminUser = String(currentUser?.role || '').toLowerCase() === 'admin';
      if (isAdminUser) {
        const el = $('adminCourseList'); if (el) el.innerHTML = errHtml;
      } else {
        const el = $('studentCourseList'); if (el) el.innerHTML = errHtml;
      }
    }
  } finally {
    // Clear the loading flag whenever the chain terminates — but ONLY
    // if this chain is still the latest generation. The watchdog set
    // by _startCoursesLoading is our ultimate safety net.
    if (pageFailed || !_coursePagination.hasMore || page >= 20) {
      if (myGeneration === _coursesFetchGeneration) {
        _stopCoursesLoading();
      }
    }
    // Always repaint after any fetch terminal — even a stale one,
    // because the UI might be sitting on a skeleton right now.
    try { renderApp(); } catch (e) {}
  }
}

// Naya helper — on-demand full course (with all data)
async function fetchSingleCourse(courseId) {
  try {
    const data = await fetchJSON(`${API_BASE}/courses/${courseId}?_t=${Date.now()}`);
    if (data && data.success && data.course) {
      const c = data.course;
      const normalized = {
        ...c,
        id: c._id,
        materials: (c.materials || []).map(m => ({ ...m, id: m._id })),
        playlists: c.playlists || []
      };
      const idx = liveCourses.findIndex(x => x.id === normalized.id);
      if (idx >= 0) liveCourses[idx] = normalized;
      else liveCourses.push(normalized);
      return normalized;
    }
  } catch (e) {
    console.warn('[fetchSingleCourse]', e);
  }
  return null;
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
/* ============================================================
   SESSION HEARTBEAT — single-device login enforcement (client)
   ------------------------------------------------------------
   Polls /api/auth/session-check every 20s. If the server says
   our sessionId was replaced by a newer login, we immediately
   wipe local state and show a clear "session ended" modal.
   ============================================================ */
let _sessionHeartbeatTimer = null;
let _sessionKilled = false;
// 60s is plenty for single-device enforcement and cuts DB traffic by 3×
const SESSION_HEARTBEAT_MS = 60000;
const SESSION_FIRST_CHECK_MS = 5000;
// Pause heartbeats when the tab is hidden — saves battery + DB hits
let _heartbeatPaused = false;
document.addEventListener('visibilitychange', () => {
  _heartbeatPaused = document.hidden;
  if (!document.hidden && currentUser && !_sessionKilled) {
    // Immediate check when user comes back
    checkSessionAlive();
  }
});

function startSessionHeartbeat() {
  stopSessionHeartbeat();
  _sessionKilled = false;
  setTimeout(() => { if (!_sessionKilled) checkSessionAlive(); }, SESSION_FIRST_CHECK_MS);
  _sessionHeartbeatTimer = setInterval(checkSessionAlive, SESSION_HEARTBEAT_MS);
}

function stopSessionHeartbeat() {
  if (_sessionHeartbeatTimer) {
    clearInterval(_sessionHeartbeatTimer);
    _sessionHeartbeatTimer = null;
  }
}

async function checkSessionAlive() {
  if (_sessionKilled) return;
  if (_heartbeatPaused) return;
  if (!currentUser) return;

  let token = null;
  try { token = sessionStorage.getItem('aero_token'); } catch (e) {}
  if (!token) return;

  try {
    const res = await fetch(`${API_BASE}/auth/session-check`, {
      method: 'GET',
      cache: 'no-store'
    });

    if (res.status === 401) {
      let data = {};
      try { data = await res.json(); } catch (e) {}
      _sessionKilled = true;
      stopSessionHeartbeat();
      forceLogoutDueToNewLogin(
        data.message || 'Your session has ended. Please log in again.'
      );
    }
  } catch (e) {
    console.warn('[session-heartbeat]', e && e.message);
  }
}
/* ============================================================
   STALE SESSION HANDLER
   Called by the fetch interceptor when a protected /api/ call
   returns 401. Clears all app state, returns to the login screen,
   and resets the guard so a fresh login works normally.
   ============================================================ */
window.__aeroHandleStaleSession = function (message) {
  try { stopSessionHeartbeat(); } catch (e) {}
  _sessionKilled = false;

  currentUser = null;
  currentCourseId = null;
  editingCourseId = null;
  window.currentSelectedCourseId = null;
  currentMaterialFilter = 'all';
  studentNav = 'home';
  adminTab = 'overview';

  clearSession();
  try { _emailSelectedIds.clear(); } catch (e) {}
  _analyticsCache = null;
  _analyticsCacheAt = 0;
  try { destroyAnalyticsCharts(); } catch (e) {}

  try { setLoginRole('student'); } catch (e) {}
  try { quizEditingCourseId = null; } catch (e) {}
  try { quizEditingMaterialId = null; } catch (e) {}
  try { quizDraft = []; } catch (e) {}
  try { quizPlayerState = null; } catch (e) {}
  try { stopQuizAutosave(); } catch (e) {}
  try { stopQuizTimer(); } catch (e) {}
  try { exitFullscreenNow(); } catch (e) {}

  pushHash('#/home');
  renderApp();

  if (typeof showToast === 'function') {
    showToast(message || 'Session expired. Please log in again.', 'error');
  }

  window.__aeroHandlingStaleSession = false;
};

function forceLogoutDueToNewLogin(message) {
  // Wipe ALL local state (mirrors logout() but doesn't call server logout)
  currentUser = null;
  currentCourseId = null;
  editingCourseId = null;
  window.currentSelectedCourseId = null;
  currentMaterialFilter = 'all';
  studentNav = 'home';
  adminTab = 'overview';
  clearSession();
  try { _emailSelectedIds.clear(); } catch (e) {}
  _analyticsCache = null;
  _analyticsCacheAt = 0;
  try { destroyAnalyticsCharts(); } catch (e) {}
  try { setLoginRole('student'); } catch (e) {}
  try { quizEditingCourseId = null; } catch (e) {}
  try { quizEditingMaterialId = null; } catch (e) {}
  try { quizDraft = []; } catch (e) {}
  try { quizPlayerState = null; } catch (e) {}
  try { stopQuizAutosave(); } catch (e) {}
  try { stopQuizTimer(); } catch (e) {}
  try { exitFullscreenNow(); } catch (e) {}

  pushHash('#/home');
  renderApp();
  showSessionKilledModal(message);
}

function showSessionKilledModal(message) {
  const old = document.getElementById('sessionKilledModal');
  if (old) old.remove();

  const el = document.createElement('div');
  el.id = 'sessionKilledModal';
  el.className = 'modal-overlay active';
  el.innerHTML = `
    <div class="modal-box" style="max-width:480px;text-align:center;">
      <div style="
        display:inline-flex; align-items:center; justify-content:center;
        width:72px; height:72px; border-radius:50%;
        background:linear-gradient(135deg,#f59e0b,#ef4444);
        color:#fff; font-size:32px;
        box-shadow:0 12px 32px rgba(239,68,68,.35);
        margin-bottom:18px;">
        <i class="fas fa-shield-halved"></i>
      </div>
      <h3 style="justify-content:center;margin-bottom:10px;">
        <i class="fas fa-triangle-exclamation" style="color:var(--rose-500);"></i>
        Session Ended
      </h3>
      <p style="font-size:14px;line-height:1.65;color:var(--text-secondary);margin-bottom:8px;">
        ${escapeHtml(message || 'You were signed out because this account was just signed in on another device.')}
      </p>
      <p style="font-size:12.5px;color:var(--text-tertiary);margin-bottom:20px;">
        For security, only one device can be signed in at a time.
      </p>
      <div class="modal-actions" style="justify-content:center;padding-top:16px;">
        <button class="btn btn-primary btn-lg" onclick="closeSessionKilledModal()" style="width:100%;">
          <i class="fas fa-sign-in-alt"></i> Log In Again
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  // Prevent overlay-click from dismissing (must click the button)
  el.addEventListener('click', (ev) => {
    if (ev.target === el) ev.stopPropagation();
  });

  setTimeout(() => {
    const btn = el.querySelector('button');
    if (btn) btn.focus();
  }, 120);
}

function closeSessionKilledModal() {
  const el = document.getElementById('sessionKilledModal');
  if (el) el.remove();
  pushHash('#/home');
  renderApp();
}

// ---- Subscription settings (global, fetched on boot) ----
let liveSubscriptionSettings = { enabled: false, amount: 0, title: '', description: '' };

// ---- Organization owner profile (global, fetched on boot) ----
// IMPORTANT: starts EMPTY. The pre-written bio that used to live here
// was being rendered on first paint (before the real fetch completed),
// then swapped out a moment later — causing a visible "flash" of stale
// hard-coded content. Now we start blank and only render once
// fetchOwnerProfile() has confirmed real values (or failed).
let liveOwnerProfile = {
  name:  '',
  title: '',
  role:  '',
  bio:   '',
  email: '',
  phone: '',
  photo: '',
  visible: true   // ⭐ admin can hide the founder section
};
let _ownerProfileLoaded = false;

let _ownerProfileCacheAt = 0;
const OWNER_PROFILE_CACHE_MS = 30 * 1000;   // 30s — short enough for live hide/show

async function fetchOwnerProfile(force = false) {
  // Reuse the in-memory value if it's still fresh (unless force=true)
  if (!force && _ownerProfileLoaded &&
      (Date.now() - _ownerProfileCacheAt) < OWNER_PROFILE_CACHE_MS) {
    return;
  }

  try {
    // ?_t= cache-buster + cache:'no-store' → guaranteed fresh network read
    const res = await fetch(
      `${API_BASE}/settings/owner?_t=${Date.now()}`,
      { cache: 'no-store' }
    );
    const data = await res.json();
    if (data.success && data.owner) {
      liveOwnerProfile = data.owner;
      _ownerProfileCacheAt = Date.now();
    }
  } catch (e) { /* silent */ }

  // Flip the flag so renderOwnerProfile() can stop showing the skeleton
  _ownerProfileLoaded = true;
}

async function fetchSubscriptionSettings() {
  try {
    const res = await fetch(`${API_BASE}/settings/subscription`);
    const data = await res.json();
    if (data.success && data.settings) {
      liveSubscriptionSettings = data.settings;
    }
  } catch (e) { /* silent */ }
}

const $ = id => document.getElementById(id);

/* ============================================================
   DEBOUNCE — prevents firing expensive renders on every keystroke
   ============================================================ */
function debounce(fn, wait = 220) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

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
   PDF THUMBNAIL SYSTEM
   ------------------------------------------------------------
   • Placeholder = beautiful CSS cover (instant)
   • Real thumbnail = generated from page 1 when student opens PDF
   • Cached in localStorage (max 80, LRU eviction)
   ============================================================ */
const PDF_THUMB_CACHE_KEY = 'aero_pdf_thumbs_v1';
const PDF_THUMB_MAX_ENTRIES = 80;

function _pdfThumbCacheGet() {
  try {
    const raw = localStorage.getItem(PDF_THUMB_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function _pdfThumbCacheSet(cache) {
  try {
    const entries = Object.entries(cache);
    if (entries.length > PDF_THUMB_MAX_ENTRIES) {
      entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
      cache = Object.fromEntries(entries.slice(0, PDF_THUMB_MAX_ENTRIES));
    }
    localStorage.setItem(PDF_THUMB_CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    try {
      const entries = Object.entries(cache).sort((a,b) => (b[1].at||0) - (a[1].at||0));
      const trimmed = Object.fromEntries(entries.slice(0, Math.floor(entries.length / 2)));
      localStorage.setItem(PDF_THUMB_CACHE_KEY, JSON.stringify(trimmed));
    } catch { /* give up silently */ }
  }
}

function getPDFThumbnail(materialId) {
  const cache = _pdfThumbCacheGet();
  return cache[materialId] ? cache[materialId].url : null;
}

function savePDFThumbnail(materialId, dataUrl) {
  const cache = _pdfThumbCacheGet();
  cache[materialId] = { url: dataUrl, at: Date.now() };
  _pdfThumbCacheSet(cache);
}

async function generateThumbnailFromPDFDoc(pdfDoc, maxWidth = 220) {
  try {
    const page = await pdfDoc.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = maxWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch (e) {
    console.warn('[thumbnail]', e.message);
    return null;
  }
}

function hydrateMaterialThumbs() {
  document.querySelectorAll('.material-thumb[data-material-id]').forEach(el => {
    const mid = el.dataset.materialId;
    if (el.classList.contains('has-thumb')) return;
    const cached = getPDFThumbnail(mid);
    if (cached) {
      el.innerHTML = `<img src="${cached}" alt="" loading="lazy" decoding="async">`;
      el.classList.add('has-thumb');
    }
  });
}
/* ============================================================
   Role helpers — case/whitespace-tolerant admin check
   ============================================================ */
function isAdmin(u) {
  return String((u && u.role) || '').trim().toLowerCase() === 'admin';
}
/* Safely embed a value as a JS string literal inside an HTML attribute.
   Handles ', ", <, >, & and any unicode without breaking out of the string.
   NOTE: the output already includes surrounding double-quotes. */
function jsStr(value) {
  return escapeHtml(JSON.stringify(String(value == null ? '' : value)));
}

/* ============================================================
   getMaterialAccessInfo — client mirror of server-side evaluator
   ------------------------------------------------------------
   Returns everything the UI needs to decide what to show:
     • hasFullAccess  → user paid / subscribed / is admin
     • canPreview     → material is premium AND previewPercent > 0
     • previewPercent → % of pages free (0 = no preview)
     • flags for building the right CTA (course vs material unlock)
   ============================================================ */
function getMaterialAccessInfo(course, mat) {
  const isCoursePremium = course.isPremium === true || course.isPremium === 'true';
  const isMatPremium    = mat.isPremium    === true || mat.isPremium    === 'true';
  const previewPercent  = Math.max(0, Math.min(100, Number(mat.previewPercent) || 0));

  /* Guests */
  if (!currentUser) {
    return {
      hasFullAccess: false,
      canPreview: false,
      previewPercent: 0,
      isCoursePremium,
      isMatPremium,
      reason: 'login-required'
    };
  }

  /* Admins always get full access */
  if (isAdmin(currentUser)) {
    return {
      hasFullAccess: true,
      canPreview: false,
      previewPercent: 0,
      isCoursePremium,
      isMatPremium
    };
  }

  const purchases    = Array.isArray(currentUser.purchases) ? currentUser.purchases : [];
  const ownsCourse   = purchases.includes(String(course.id));
  const ownsMaterial = purchases.includes(String(mat.id));
  const subscribed   = !!currentUser.isSubscribed;

  const hasFullAccess = ownsCourse || ownsMaterial || subscribed;

  const canPreview =
    !hasFullAccess &&
    isMatPremium && !isCoursePremium &&
    previewPercent > 0;

  return {
    hasFullAccess,
    canPreview,
    previewPercent: canPreview ? previewPercent : 0,
    isCoursePremium,
    isMatPremium,
    ownsCourse,
    ownsMaterial,
    subscribed
  };
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
  } else if (parts[0] === 'ai') {
    studentNav = 'ai';
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
   LANDING INTENT — read ?intent=register and stash it
   ============================================================ */
(function parseLandingIntent() {
  try {
    const params = new URLSearchParams(location.search);
    const intent = params.get('intent');
    if (intent) {
      sessionStorage.setItem('aero_landing_intent', intent);
      const clean = location.pathname + (location.hash || '');
      history.replaceState(null, '', clean);
    }
  } catch (e) {}
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
    viewCourseDetail(r.courseId, 'qa');   // <-- pass filter as arg
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

  const userEl = $('loginUsername');
  const passEl = $('loginPassword');
  if (!userEl || !passEl) return;

  const username = userEl.value.trim();
  const password = passEl.value.trim();
  if (!username || !password) {
    return showToast('Please enter both username and password.', 'error');
  }

  const btn = e.target.querySelector('button[type="submit"]');
  const originalBtnText = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing in...';
  }

  const resetBtn = () => {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalBtnText;
    }
  };

  const attemptLogin = async (retries = 2) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      console.log('[login] POST /api/login', { username, role: loginRole });

      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role: loginRole }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const rawText = await response.text();
      let data;
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch (parseErr) {
        console.error('[login] non-JSON response:', response.status, rawText.slice(0, 300));
        if (response.status === 502 || response.status === 504) {
          if (retries > 0) {
            showToast(`Server is starting up... Retrying (${3 - retries}/2)`, 'info');
            await new Promise(r => setTimeout(r, 5000));
            return attemptLogin(retries - 1);
          }
          showToast('Server is not responding yet. Please wait a moment and try again.', 'error');
        } else {
          showToast(
            `Server returned HTTP ${response.status}. ` +
            (rawText.startsWith('<') ? 'Backend route may be missing.' : 'Unexpected response.'),
            'error'
          );
        }
        resetBtn();
        return;
      }

      console.log('[login] response:', data);

      if (data.requires2FA && data.pendingToken) {
        _adminPendingToken = data.pendingToken;
        openOtpModal({
          title: 'Admin 2FA Verification',
          subtitle: `We've sent a 6-digit code to ${data.maskedEmail || 'your registered email'}. Enter it to finish logging in.`,
          type: 'admin-login',
          data: { pendingToken: data.pendingToken }
        });
        showToast('OTP sent — check your inbox (and spam).', 'info');
        resetBtn();
        return;
      }

      if (data.success && data.user) {
        currentUser = data.user;
        saveSession(data.user, data.token);

        // Reset ALL routing / editor state
        editingCourseId = null;
        currentCourseId = null;
        window.currentSelectedCourseId = null;
        addingCourse = false;
        addingProfessor = false;
        addingMaterialCourseId = null;
        addingStudent = false;
        quizEditingCourseId = null;
        quizEditingMaterialId = null;

        // Normalize role (trim + lowercase) so "Admin" / " admin " still
        // route correctly — this defends against legacy DB values.
        const serverRole = String(data.user.role || '').trim().toLowerCase();

        // If the user explicitly clicked the Admin tab but the server
        // returned a student, surface that clearly (self-diagnosis).
        if (loginRole === 'admin' && serverRole !== 'admin') {
          showToast(
            'This account is a student account. Logging you in as a student.',
            'info'
          );
        }

        // Route STRICTLY by the role the server returned.
        if (serverRole === 'admin') {
          adminTab = 'overview';
          studentNav = 'home';
          try { history.replaceState(null, '', '#/admin/overview'); }
          catch (e) { location.hash = '#/admin/overview'; }
        } else {
          studentNav = 'home';
          adminTab = 'overview';
          try { ensureStudentAIHomeView(); } catch (e) {}   // ✅ ensure DOM
          try { history.replaceState(null, '', '#/home'); }
          catch (e) { location.hash = '#/home'; }

          // 🎯 Landing intent — route new registrations to free content
          const _landingIntent = sessionStorage.getItem('aero_landing_intent');
          if (_landingIntent === 'register') {
            sessionStorage.removeItem('aero_landing_intent');
            setTimeout(() => {
              showToast('🎉 Welcome! Your free PYQs are ready — pick a subject.', 'success');
              navigateStudent('courses');
              setTimeout(() => {
                const pf = document.getElementById('filterPrice');
                if (pf) { pf.value = 'free'; renderStudentCourses(); }
              }, 400);
            }, 1400);
          }
        }

        // ⭐ Force-fresh course list on every login — kills stale premium flags
        _courseCacheAt = 0;
        liveCourses = [];
        _coursesLoading = false;                 // ⭐ reset so skeleton logic works
        try { _coursePagination = { page: 1, hasMore: false, total: 0 }; } catch (e) {}

        showToast(data.message || 'Login successful!', 'success');
        _sessionKilled = false;
        startSessionHeartbeat();

        // ⭐ FIX: fetch ALL critical data in parallel — same set initApp uses.
        //    Previously only courses were fetched, so professors, owner
        //    profile and subscription settings were missing until refresh.
        const _initialDataPromise = Promise.allSettled([
          fetchCoursesFromDB(true),
          fetchProfessorsFromDB(),
          fetchSubscriptionSettings(),
          fetchOwnerProfile()
        ]);

        // Immediate first paint (skeleton / dashboard).
        renderApp();

        // ⭐ FIX: guaranteed second render AFTER all data has settled.
        //    This is the render that finally shows the real course list.
        _initialDataPromise.then(() => {
          console.log('[login] ✅ initial data loaded — final render');
          renderApp();
        }).catch(err => {
          console.warn('[login] initial data fetch issue:', err);
          renderApp();
        });

        return;
      }

      showToast(data.message || 'Login failed. Please try again.', 'error');
      resetBtn();

    } catch (err) {
      clearTimeout(timeoutId);
      console.error('[login] fetch error:', err);

      if (err.name === 'AbortError') {
        showToast('Request timed out. The server may be cold-starting — retrying…', 'error');
        if (retries > 0) {
          await new Promise(r => setTimeout(r, 5000));
          return attemptLogin(retries - 1);
        }
      } else if (
        err.name === 'TypeError' ||
        /Failed to fetch|NetworkError|Load failed/i.test(err.message || '')
      ) {
        if (retries > 0) {
          showToast(`Server is waking up... Retrying (${3 - retries}/2)`, 'info');
          await new Promise(r => setTimeout(r, 5000));
          return attemptLogin(retries - 1);
        }
        showToast('Server is taking too long to respond. Please try again.', 'error');
      } else {
        showToast('Login failed: ' + (err.message || 'Unknown error'), 'error');
      }
      resetBtn();
    }
  };

  await attemptLogin();
}


function logout() {
  // Fire-and-forget server-side logout — clears activeSession on the server
  // so this session's token can never be reused again.
  try {
    const token = sessionStorage.getItem('aero_token');
    if (token) {
      fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token }
      }).catch(() => {});
    }
  } catch (e) {}

  stopSessionHeartbeat();
  _sessionKilled = false;

  _courseCacheAt = 0;
  liveCourses = [];

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

  // ─── HARD-ENFORCE ADMIN ROLE ────────────────────────────────
  // The user only reached this code path AFTER the server issued an admin
  // 2FA challenge. Even if the server ever returned the wrong role, we
  // force it here so the UI can never land on the student dashboard.
  if (data.user) data.user.role = 'admin';

  currentUser = data.user;
  saveSession(data.user, data.token);
  _adminPendingToken = null;
  _otpContext = null;
  try { ensureStudentAIHomeView(); } catch (e) {}   // ✅ ensure DOM

  // Reset ALL routing / editor state — nothing from a previous
  // session must be able to leak into this fresh admin session.
  editingCourseId = null;
  currentCourseId = null;
  window.currentSelectedCourseId = null;
  addingCourse = false;
  addingProfessor = false;
  addingMaterialCourseId = null;
  addingStudent = false;
  quizEditingCourseId = null;
  quizEditingMaterialId = null;
  studentNav = 'home';
  adminTab = 'overview';

  closeModal('otpVerificationModal');

  // Force URL into the admin namespace (replaceState so back-button
  // doesn't drop us onto the login page).
  try {
    history.replaceState(null, '', '#/admin/overview');
  } catch (e) {
    location.hash = '#/admin/overview';
  }

  // ⭐ Force-fresh course list on admin login
  _courseCacheAt = 0;
  liveCourses = [];
  _coursesLoading = false;                 // ⭐ reset for skeleton logic
  try { _coursePagination = { page: 1, hasMore: false, total: 0 }; } catch (e) {}

  showToast('🎉 Admin login successful.', 'success');
  _sessionKilled = false;
  startSessionHeartbeat();

  // ⭐ FIX: fetch ALL critical data (was courses-only before)
  const _initialDataPromise = Promise.allSettled([
    fetchCoursesFromDB(true),
    fetchProfessorsFromDB(),
    fetchSubscriptionSettings(),
    fetchOwnerProfile()
  ]);

  renderApp();

  _initialDataPromise.then(() => {
    console.log('[admin login] ✅ initial data loaded — final render');
    renderApp();
  }).catch(err => {
    console.warn('[admin login] initial fetch issue:', err);
    renderApp();
  });
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
    const res = await fetch('/api/admin/create-student', {
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
    const res = await fetch('/api/courses', {
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
        <span class="hint">Max file size: 500 MB. Uploading a file will override the URL.</span>
      </div>
    </div>

    <div class="editor-section">
      <h3 class="editor-section-title"><i class="fas fa-cog"></i> Access & Settings</h3>
      <div class="editor-grid-3">
        <div class="form-group"><label>Access Level</label>
          <label class="toggle-box pro" style="margin-top:6px;">
            <input type="checkbox" id="newMatPremium"
                   onchange="document.getElementById('newMatPriceGroup').style.display=this.checked?'block':'none';document.getElementById('newMatPreviewGroup').style.display=this.checked?'block':'none';">
            <span><i class="fas fa-crown"></i> PRO Material</span>
          </label>
        </div>
        <div class="form-group"><label>Estimated Time (Optional)</label><input type="text" id="newMatTime" placeholder="e.g. 45 mins"></div>
        <div class="form-group"><label>Tags (Optional)</label><input type="text" id="newMatTags" placeholder="e.g. aerodynamics, basics"></div>
      </div>
      <div class="form-group" id="newMatPriceGroup" style="display:none; margin-top:10px;">
        <label>Unlock Price (₹)</label><input type="number" id="newMatPrice" placeholder="e.g. 49" min="0" step="1">
      </div>
      <div class="form-group" id="newMatPreviewGroup" style="display:none; margin-top:10px;">
        <label><i class="fas fa-eye"></i> Free Preview Percentage</label>
        <input type="number" id="newMatPreview" value="0" min="0" max="100" step="1" placeholder="e.g. 10">
        <span class="hint">Percentage of PDF pages free to read. <strong>0 = no preview.</strong> 10 = first 10% of pages.</span>
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

  const processSave = async (fileUrl, fileName) => {
    const selectedType = $('newMatType').value;
    const customTypeEl = $('newMatCustomType');
    const resolvedType = resolveMaterialType(selectedType, customTypeEl ? customTypeEl.value : '');
    if (!resolvedType) {
      return showToast('Please enter a name for the custom material type.', 'error');
    }

    const previewRaw = parseInt($('newMatPreview')?.value, 10);
    const previewPercent = isPremium
      ? Math.max(0, Math.min(100, Number.isFinite(previewRaw) ? previewRaw : 0))
      : 0;

    const payload = {
      title,
      type: resolvedType,
      description: $('newMatDescription').value.trim(),
      url: fileUrl || $('newMatUrl').value.trim(),
      isPremium: isPremium,
      price: isPremium ? (parseFloat($('newMatPrice').value) || 0) : 0,
      previewPercent: previewPercent,
      estimatedTime: $('newMatTime').value.trim(),
      tags: $('newMatTags').value.trim(),
      fileName: fileName || ''
    };

    try {
      const res = await fetch(`/api/courses/${courseId}/materials`, {
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
    if (file.size > 500 * 1024 * 1024) return showToast('File too large (max 500 MB).', 'error');
    try {
      showToast(`Uploading ${file.name}…`, 'info');
      const result = await uploadFileToServer(file);
      await processSave(result.url, result.fileName);
      // (processSave only needs `url` + `fileName` — cloudUrl is optional,
      //  but if you want cloudUrl stored when creating from the full-page
      //  material form, modify processSave's payload the same way as doSave.)
    } catch (err) {
      showToast('Upload failed: ' + err.message, 'error');
    }
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
      const res = await fetch(`/api/user/notifications/${currentUser._id}/mark-read`, {
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
    const res = await fetch(`/api/user/notifications/${currentUser._id}/mark-read`, {
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
    const res = await fetch(`/api/user/notifications/${currentUser._id}`);
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
  currentCourseId = null;
  window.currentSelectedCourseId = null;
  editingCourseId = null;
  currentMaterialFilter = 'all';
  const pathMap = { courses: '#/courses', saved: '#/saved', analytics: '#/analytics', home: '#/home', ai: '#/ai' };
  pushHash(pathMap[dest] || '#/home');
  studentNav = dest;

  // ⚡ Auto-load course data when navigating to a view that needs it.
  //
  // FIX (auto-load race): The old code only fired a fetch when
  // `liveCourses.length === 0`. If the initApp()/login fetch was still
  // in-flight, this started a SECOND fetch. The generation guard in
  // fetchCoursesFromDB() then dropped the first response and skipped
  // its `_stopCoursesLoading()` call — leaving the UI stuck on a
  // skeleton until a manual refresh reset all in-memory state.
  //
  // Now we respect an in-flight fetch: if one is already running, its
  // own finally-block will call renderApp() and paint the courses.
  // Only fire a new fetch when nothing is running. Force-fresh when
  // we have no data; respect the cache when we do.
  const needsCourses = (dest === 'courses' || dest === 'saved' || dest === 'home');
  if (needsCourses && !_coursesLoading) {
    fetchCoursesFromDB(liveCourses.length === 0).catch(function (err) {
      console.warn('[navigateStudent] auto-fetch failed:', err);
    });
  }

  renderApp();
}
function viewCourseDetail(courseId, filter = 'all') {
  currentCourseId = courseId; window.currentSelectedCourseId = courseId;
  editingCourseId = null;
  currentMaterialFilter = filter;
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
/* ============================================================
   RENDER APP — rAF-batched, debounced to prevent thrash
   ------------------------------------------------------------
   Multiple synchronous calls (e.g. from initApp + hashchange)
   collapse into ONE paint per animation frame.
   ============================================================ */
/* ============================================================
   RENDER APP — rAF-batched, debounced to prevent thrash
   ------------------------------------------------------------
   Multiple synchronous calls collapse into ONE paint per frame.

   ⭐ FIX: added a watchdog timer. requestAnimationFrame is
   throttled (sometimes indefinitely) when the tab is hidden or
   blurred — which is exactly the state right after a login /
   OTP-modal submit. Without the watchdog, the post-fetch render
   could be silently dropped, forcing a manual page refresh.
   ============================================================ */
let _renderScheduled = false;
let _renderWatchdog = null;

function renderApp() {
  if (_renderScheduled) return;
  _renderScheduled = true;

  const run = () => {
    if (_renderWatchdog) {
      clearTimeout(_renderWatchdog);
      _renderWatchdog = null;
    }
    _renderScheduled = false;
    _renderAppNow();
  };

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(run);
    // Watchdog: if RAF never fires (hidden/blurred tab), force it.
    _renderWatchdog = setTimeout(run, 100);
  } else {
    _renderWatchdog = setTimeout(run, 16);
  }
}

function _renderAppNow() {
  ['loginView', 'adminView', 'adminEditView', 'studentAIHomeView', 'studentHomeView', 'studentCoursesView', 'studentSavedView', 'studentAnalyticsView', 'courseDetailView', 'adminAddCourseView', 'adminAddProfessorView', 'adminAddMaterialView', 'adminAddStudentView', 'adminQuizEditorView']
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
  if (quizEditingCourseId && quizEditingMaterialId && isAdmin(currentUser)) {
    $('adminQuizEditorView').classList.add('active');
    renderQuizEditor();
    return;
  }
  if (addingCourse)          { $('adminAddCourseView').classList.add('active');    renderAdminAddCourse(); return; }
  if (addingProfessor)       { $('adminAddProfessorView').classList.add('active'); renderAdminAddProfessor(); return; }
  if (addingMaterialCourseId){ $('adminAddMaterialView').classList.add('active');  renderAdminAddMaterial(addingMaterialCourseId); return; }
  if (addingStudent)         { $('adminAddStudentView').classList.add('active');   renderAdminAddStudent(); return; }
  if (editingCourseId && isAdmin(currentUser)) {
    $('adminEditView').classList.add('active');
    renderCourseEditor(editingCourseId); return;
  }
  if (currentCourseId) { $('courseDetailView').classList.add('active'); renderCourseDetail(currentCourseId); return; }
  // Case-insensitive role check — defends against legacy "Admin" values
  const _isAdminRole = String(currentUser.role || '').trim().toLowerCase() === 'admin';
  if (_isAdminRole) { $('adminView').classList.add('active'); renderAdminDashboard(); return; }

  // ─── AI DOUBT SOLVER (default landing page for students) ───
  if (studentNav === 'ai') {
    // ensureStudentAIHomeView() runs once in initApp(); no need to
    // re-check on every render.
    const aiHome = $('studentAIHomeView');
    if (aiHome) {
      aiHome.classList.add('active');
      renderStudentAIHome();
    } else {
      console.warn('[nav] studentAIHomeView missing — falling back to home');
      const fallback = $('studentHomeView');
      if (fallback) fallback.classList.add('active');
      renderStudentHome();
    }
    return;
  }

  if (studentNav === 'home') {
    const homeView = $('studentHomeView');
    if (homeView) homeView.classList.add('active');
    renderStudentHome();
  }
  else if (studentNav === 'saved') {
    const savedView = $('studentSavedView');
    if (savedView) savedView.classList.add('active');
    renderSavedCourses();
  }
  else if (studentNav === 'analytics') {
    const analyticsView = $('studentAnalyticsView');
    if (analyticsView) analyticsView.classList.add('active');
    renderStudentAnalytics();
  }
  else {
    const coursesView = $('studentCoursesView');
    if (coursesView) coursesView.classList.add('active');
    renderStudentCourses();
  }
}

function buildNav() {
  if (isAdmin(currentUser)) {
    $('mainNav').innerHTML = `<a href="#" class="active" onclick="event.preventDefault();">Dashboard</a>`;
    return;
  }
  const aiActive        = (studentNav === 'ai'        && !currentCourseId) ? 'active' : '';
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
    <a href="#" class="nav-ai-btn ${aiActive}" onclick="event.preventDefault();navigateStudent('ai')"><i class="fas fa-robot"></i> AI Solver</a>
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

  // ⚡ Auto-load courses when switching to the Courses tab.
  // Same fix as navigateStudent(): don't compete with an in-flight
  // fetch (its finally-block will re-render), only fire a fresh one
  // when nothing is running. Force-fresh if no data, else cache-aware.
  if (tab === 'courses' && !_coursesLoading) {
    fetchCoursesFromDB(liveCourses.length === 0).catch(function (err) {
      console.warn('[switchAdminTab] auto-fetch failed:', err);
    });
  }

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
    live:          { icon: 'fa-bolt',           text: 'Live Activity' },
    courses:       { icon: 'fa-graduation-cap', text: 'Manage Courses' },
    professors:    { icon: 'fa-user-tie',       text: 'Manage Professors' },
    students:      { icon: 'fa-user-graduate',  text: 'Manage Students' },
    replies:       { icon: 'fa-envelope-open-text', text: 'Email Replies' },
    subscriptions: { icon: 'fa-repeat',         text: 'Subscriptions & Auto-Pay' },
    organization:  { icon: 'fa-building-user',  text: 'Organization & Owner' },
    community:     { icon: 'fa-users',          text: 'Community — Alumni & Friends' },
    security:      { icon: 'fa-shield-halved',  text: 'Admin Security' },
    feedback:      { icon: 'fa-comment-dots',        text: 'Feedback Moderation' },
    contributions: { icon: 'fa-hand-holding-heart',  text: 'Student Contributions' },
    backup:        { icon: 'fa-database',            text: 'Backup & Restore' }
  };
  const actionsMap = {
    overview: `<button class="btn btn-outline" onclick="switchAdminTab('courses')"><i class="fas fa-arrow-right"></i> Go to Courses</button>`,
    live: `<button class="btn btn-primary" onclick="renderAdminLive()"><i class="fas fa-rotate"></i> Refresh</button>`,
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
    organization: `
      <button class="btn btn-outline" onclick="switchAdminTab('overview')"><i class="fas fa-chart-pie"></i> <span class="btn-text">Overview</span></button>
      <button class="btn btn-primary" onclick="renderAdminOrganizationTab()"><i class="fas fa-rotate"></i> <span class="btn-text">Reload</span></button>`,
    security: `
      <button class="btn btn-outline" onclick="switchAdminTab('overview')"><i class="fas fa-chart-pie"></i> <span class="btn-text">Overview</span></button>`,
    community: `
      <button class="btn btn-outline" onclick="switchAdminTab('overview')"><i class="fas fa-chart-pie"></i> <span class="btn-text">Overview</span></button>
      <button class="btn btn-primary" onclick="renderAdminCommunity()"><i class="fas fa-rotate"></i> <span class="btn-text">Refresh</span></button>`,
    feedback: `
      <button class="btn btn-outline" onclick="switchAdminTab('overview')"><i class="fas fa-chart-pie"></i> <span class="btn-text">Overview</span></button>
      <button class="btn btn-primary" onclick="renderAdminFeedback()"><i class="fas fa-rotate"></i> <span class="btn-text">Refresh</span></button>`,
    contributions: `
      <button class="btn btn-outline" onclick="switchAdminTab('overview')"><i class="fas fa-chart-pie"></i> <span class="btn-text">Overview</span></button>
      <button class="btn btn-primary" onclick="renderAdminContributions()"><i class="fas fa-rotate"></i> <span class="btn-text">Refresh</span></button>`,
    backup: `
      <button class="btn btn-outline" onclick="switchAdminTab('overview')"><i class="fas fa-chart-pie"></i> <span class="btn-text">Overview</span></button>`,
  };
  const meta = titleMap[adminTab] || titleMap.overview;
  if (titleEl) titleEl.innerHTML = `<i class="fas ${meta.icon}"></i> ${meta.text}`;
  if (actionsEl) actionsEl.innerHTML = actionsMap[adminTab] || '';
}

function renderAdminDashboard() {
  updateAdminTabUI();
  if (adminTab === 'overview') renderAdminOverview();
  else if (adminTab === 'live')          renderAdminLive();
  else if (adminTab === 'courses') renderAdminCourses();
  else if (adminTab === 'professors') renderAdminProfessors();
  else if (adminTab === 'students') renderAdminStudents();
  else if (adminTab === 'replies') renderAdminEmailReplies();
  else if (adminTab === 'subscriptions') renderAdminSubscriptions();
  else if (adminTab === 'organization') renderAdminOrganizationTab();
  else if (adminTab === 'community') renderAdminCommunity();
  else if (adminTab === 'security') renderAdminSecurityTab();
  else if (adminTab === 'feedback')      renderAdminFeedback();
  else if (adminTab === 'contributions') renderAdminContributions();
  else if (adminTab === 'backup')        renderAdminBackup();
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
    const res = await fetch('/api/students');
    const data = await res.json();
    if (data.success) $('statStudents').textContent = data.students.length;
  } catch { $('statStudents').textContent = '—'; }
}

/* ============================================================
   ADMIN — LIVE ACTIVITY DASHBOARD
   ============================================================ */
async function renderAdminLive() {
  const el = document.getElementById('adminTabLive');
  if (!el) return;
  el.classList.add('active');
  el.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>Loading live activity…</p></div>`;

  let data;
  try {
    data = await fetchJSON(`${API_BASE}/admin/live-activity?t=${Date.now()}`);
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><p style="color:var(--rose-500);">${escapeHtml(e.message)}</p></div>`;
    return;
  }
  if (!data.success) {
    el.innerHTML = `<div class="empty-state"><p style="color:var(--rose-500);">${escapeHtml(data.message || 'Failed to load.')}</p></div>`;
    return;
  }

  const fmtTime = (t) => {
    if (!t) return '—';
    return new Date(t).toLocaleString('en-IN', {
      day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit'
    });
  };

  const activityIcon = (type) => ({
    view:  'fa-eye',
    quiz:  'fa-file-pen',
    login: 'fa-right-to-bracket'
  }[type] || 'fa-circle-dot');

  const activityLabel = (a) => {
    if (a.type === 'quiz') {
      return `Took a quiz${a.score != null ? ` — scored ${a.score}/${a.total}` : ''}`;
    }
    if (a.type === 'view') {
      return 'Viewed a material';
    }
    return a.type;
  };

  el.innerHTML = `
    <div class="stats-grid" style="margin-bottom:22px;">
      <div class="stat-card">
        <div class="stat-icon tone-emerald"><i class="fas fa-users"></i></div>
        <div class="stat-info">
          <div class="num">${data.stats.activeNow}</div>
          <div class="label">Active Now (5 min)</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon tone-brand"><i class="fas fa-right-to-bracket"></i></div>
        <div class="stat-info">
          <div class="num">${data.stats.loginsLastHour}</div>
          <div class="label">Logins (Last Hour)</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon tone-cyan"><i class="fas fa-user-graduate"></i></div>
        <div class="stat-info">
          <div class="num">${data.stats.totalStudents}</div>
          <div class="label">Total Students</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon tone-gold"><i class="fas fa-bolt"></i></div>
        <div class="stat-info">
          <div class="num">${data.recentActivity.length}</div>
          <div class="label">Actions (Last Hour)</div>
        </div>
      </div>
    </div>

    <div class="editor-section">
      <div class="editor-section-header">
        <div class="editor-section-title">
          <i class="fas fa-circle" style="color:var(--emerald-500);"></i>
          Active Right Now
          <span style="font-size:12px;color:var(--text-tertiary);font-weight:500;margin-left:8px;">
            ${data.stats.activeNow} user${data.stats.activeNow === 1 ? '' : 's'} seen in the last 5 minutes
          </span>
        </div>
        <button class="btn btn-outline btn-sm" onclick="renderAdminLive()">
          <i class="fas fa-rotate"></i> Refresh
        </button>
      </div>
      ${data.activeSessions.length === 0
        ? `<div class="empty-state" style="padding:30px;"><i class="fas fa-user-slash"></i><p>No one is online right now.</p></div>`
        : `<div class="subscriber-list">
            ${data.activeSessions.map(u => `
              <div class="subscriber-row active">
                <div class="subscriber-avatar">${escapeHtml(getInitials(u.fullName || u.username))}</div>
                <div class="subscriber-info">
                  <h4>${escapeHtml(u.fullName || u.username)}</h4>
                  <p>@${escapeHtml(u.username)}${u.email ? ' · ' + escapeHtml(u.email) : ''}</p>
                </div>
                <span class="subscriber-meta">Last seen: ${fmtTime(u.activeSession && u.activeSession.lastSeenAt)}</span>
              </div>
            `).join('')}
          </div>`}
    </div>

    <div class="editor-section">
      <div class="editor-section-title">
        <i class="fas fa-right-to-bracket"></i> Recent Logins (Last Hour)
      </div>
      ${data.recentLogins.length === 0
        ? `<div class="empty-state" style="padding:30px;"><i class="fas fa-clock"></i><p>No logins in the last hour.</p></div>`
        : `<div class="coupons-table"><table class="data-table">
            <thead><tr><th>Student</th><th>Username</th><th>Logged in</th></tr></thead>
            <tbody>
              ${data.recentLogins.map(u => `
                <tr>
                  <td><strong>${escapeHtml(u.fullName || u.username)}</strong></td>
                  <td><code class="coupon-code">@${escapeHtml(u.username)}</code></td>
                  <td>${fmtTime(u.activeSession && u.activeSession.loginAt)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table></div>`}
    </div>

    <div class="editor-section">
      <div class="editor-section-title">
        <i class="fas fa-bolt"></i> Recent Activity (Last Hour)
      </div>
      ${data.recentActivity.length === 0
        ? `<div class="empty-state" style="padding:30px;"><i class="fas fa-inbox"></i><p>No activity recorded yet.</p></div>`
        : `<div class="coupons-table"><table class="data-table">
            <thead><tr><th>Student</th><th>Action</th><th>Time</th></tr></thead>
            <tbody>
              ${data.recentActivity.map(a => `
                <tr>
                  <td>
                    <strong>${escapeHtml(a.fullName || a.username)}</strong>
                    <div style="font-size:11.5px;color:var(--text-tertiary);">@${escapeHtml(a.username)}</div>
                  </td>
                  <td>
                    <i class="fas ${activityIcon(a.type)}" style="color:var(--brand-500);margin-right:6px;"></i>
                    ${escapeHtml(activityLabel(a))}
                  </td>
                  <td>${fmtTime(a.timestamp)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table></div>`}
    </div>
  `;
}

async function renderAdminCourses() {  
  const courses = getCourses();

  // ⭐ FIX: show loading skeleton while courses are still being fetched
  //    (previously it flashed "No courses found" during load).
  if (_coursesLoading && courses.length === 0) {
    $('adminCourseList').innerHTML = renderCoursesLoadingSkeleton('Loading courses…');
    return;
  }
  // ⭐ Safety net: no data, not loading → refetch once and show skeleton.
  if (courses.length === 0 && !_coursesLoading) {
    $('adminCourseList').innerHTML = renderCoursesLoadingSkeleton('Loading courses…');
    _courseCacheAt = 0;
    fetchCoursesFromDB(true).catch(function (err) {
      console.warn('[renderAdminCourses] auto-fetch failed:', err);
    });
    return;
  }

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
  if (countEl) {
    const hidden = professors.filter(p => p.visible === false).length;
    const total = professors.length;
    countEl.textContent = hidden > 0
      ? `${total} member${total === 1 ? '' : 's'} · ${hidden} hidden`
      : `${total} member${total === 1 ? '' : 's'}`;
  }

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
    const isVisible = p.visible !== false;   // legacy docs without field => visible
    const photoHtml = p.photo
      ? `<img src="${p.photo}" alt="${escapeHtml(p.name)}" loading="lazy">`
      : `<div class="avatar-placeholder"><i class="fas fa-user-tie"></i></div>`;

    let contactHtml = '';
    if (p.email)  contactHtml += `<div class="prof-contact-item"><i class="fas fa-envelope"></i> ${escapeHtml(p.email)}</div>`;
    if (p.phone)  contactHtml += `<div class="prof-contact-item"><i class="fas fa-phone"></i> ${escapeHtml(p.phone)}</div>`;
    if (p.office) contactHtml += `<div class="prof-contact-item"><i class="fas fa-map-marker-alt"></i> ${escapeHtml(p.office)}</div>`;

    const visibilityPill = isVisible
      ? `<span class="visibility-pill visibility-visible" title="Visible to students"><i class="fas fa-eye"></i> Visible</span>`
      : `<span class="visibility-pill visibility-hidden" title="Hidden from students"><i class="fas fa-eye-slash"></i> Hidden</span>`;

    const toggleBtn = isVisible
      ? `<button class="btn btn-outline btn-sm"
                 onclick="toggleProfessorVisibility('${p._id}', false)"
                 title="Hide this member from students">
           <i class="fas fa-eye-slash"></i> Hide
         </button>`
      : `<button class="btn btn-success btn-sm"
                 onclick="toggleProfessorVisibility('${p._id}', true)"
                 title="Show this member to students">
           <i class="fas fa-eye"></i> Show
         </button>`;

    html += `
      <div class="admin-professor-item ${isVisible ? '' : 'professor-hidden'}">
        ${photoHtml}
        <div class="info">
          <h4>${escapeHtml(p.name)} ${visibilityPill}</h4>
          <div class="title">${escapeHtml(p.title)}</div>
          <div class="desc">${escapeHtml(p.description) || ''}</div>
          ${contactHtml ? `<div class="prof-contact-block">${contactHtml}</div>` : ''}
        </div>
        <div class="actions">
          ${toggleBtn}
          <button class="btn btn-danger btn-sm" onclick="deleteProfessor('${p._id}')" title="Delete" aria-label="Delete professor">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>`;
  });
  html += `</div>`;
  $('adminProfessorList').innerHTML = html;
}

/* ------------------------------------------------------------
   Toggle professor visibility (hide / show without deletion)
   ------------------------------------------------------------ */
async function toggleProfessorVisibility(professorId, newVisible) {
  const action = newVisible ? 'show' : 'hide';
  if (!confirm(
    `Are you sure you want to ${action} this team member ` +
    `${newVisible ? 'to' : 'from'} students?\n\n` +
    `Their details will NOT be deleted — only visibility changes.`
  )) return;

  try {
    const res = await fetch(`${API_BASE}/professors/${professorId}/visibility`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visible: newVisible })
    });
    const data = await res.json();

    if (data.success) {
      // Update the in-memory cache so the UI reflects the change instantly
      const idx = liveProfessors.findIndex(p => (p._id || p.id) === professorId);
      if (idx >= 0) liveProfessors[idx].visible = newVisible;

      // Reset the client TTL so the next fetch on any tab is fresh
      _professorsCacheAt = 0;

      showToast(
        newVisible ? '👁️ Now visible to students.' : '🙈 Hidden from students.',
        'success'
      );
      renderAdminProfessors();
    } else {
      showToast(data.message || 'Failed to update visibility.', 'error');
    }
  } catch (err) {
    console.error('[toggleProfessorVisibility]', err);
    showToast('Server error while updating visibility.', 'error');
  }
}

async function renderAdminStudents() {
  const container = $('adminStudentList');
  if (!container) return;
  container.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>Loading students...</p></div>`;

  try {
    // fetchJSON → interceptor attaches token + surfaces clean errors
    const data = await fetchJSON(`${API_BASE}/students?_t=${Date.now()}`);
    const countEl = $('studentCountLabel');

    if (!data.success) throw new Error(data.message || 'Failed to load students');

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
            <button class="btn btn-outline btn-sm" onclick="resetStudentPassword('${sid}', ${jsStr(s.fullName || s.username)})">
              <i class="fas fa-key"></i> Reset Password
            </button>
            <button class="btn btn-danger btn-sm" onclick="deleteStudent('${sid}', ${jsStr(s.fullName || s.username)})">
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
    const res = await fetch('/api/admin/email-replies?refresh=1&t=' + Date.now());
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
    const res = await fetch('/api/admin/send-email', {
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
    const res = await fetch('/api/admin/email-status');
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
    const res = await fetch(`/api/admin/reset-password/${userId}`, {
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
    const res = await fetch(`/api/admin/students/${userId}`, { method: 'DELETE' });
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
        <button type="button" class="cred-copy-btn" onclick="copyCredential('name', ${jsStr(student.fullName)})" title="Copy" aria-label="Copy name">
          <i class="fas fa-copy"></i>
        </button>
      </div>
    </div>
    <div class="cred-row">
      <div class="cred-label"><i class="fas fa-at"></i> Username</div>
      <div class="cred-value-group">
        <span class="cred-value cred-code">${escapeHtml(student.username)}</span>
        <button type="button" class="cred-copy-btn" onclick="copyCredential('username', ${jsStr(student.username)})" title="Copy" aria-label="Copy username">
          <i class="fas fa-copy"></i>
        </button>
      </div>
    </div>
    <div class="cred-row">
      <div class="cred-label"><i class="fas fa-key"></i> Password</div>
      <div class="cred-value-group">
        <span class="cred-value cred-code">${escapeHtml(student.password)}</span>
        <button type="button" class="cred-copy-btn" onclick="copyCredential('password', ${jsStr(student.password)})" title="Copy" aria-label="Copy password">
          <i class="fas fa-copy"></i>
        </button>
      </div>
    </div>
    ${student.email ? `
    <div class="cred-row">
      <div class="cred-label"><i class="fas fa-envelope"></i> Email</div>
      <div class="cred-value-group">
        <span class="cred-value">${escapeHtml(student.email)}</span>
        <button type="button" class="cred-copy-btn" onclick="copyCredential('email', ${jsStr(student.email)})" title="Copy" aria-label="Copy email">
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
   CONTACT TEAM MEMBER MODAL
   ============================================================ */
function openContactMemberModal(toEmail, toName, roleLabel) {
  if (!toEmail) return showToast('No contact address available for this member.', 'info');

  const modal = document.getElementById('contactMemberModal');
  if (!modal) return showToast('Contact form is unavailable.', 'error');

  // Pre-fill "from" fields if the student is logged in
  const nameEl = document.getElementById('contactFromName');
  const emailEl = document.getElementById('contactFromEmail');
  if (nameEl && currentUser) nameEl.value = currentUser.fullName || currentUser.username || '';
  if (emailEl && currentUser) emailEl.value = currentUser.email || '';

  const subjectEl = document.getElementById('contactSubject');
  if (subjectEl) subjectEl.value = '';
  const msgEl = document.getElementById('contactMessage');
  if (msgEl) msgEl.value = '';

  document.getElementById('contactToEmail').value = toEmail;
  document.getElementById('contactToName').value  = toName || 'Team Member';

  const titleEl = document.getElementById('contactModalTitle');
  if (titleEl) titleEl.textContent = `Contact ${toName || 'Team Member'}`;

  const subEl = document.getElementById('contactModalSub');
  if (subEl) {
    subEl.textContent = roleLabel
      ? `Reaching out regarding: ${roleLabel}. Your message is relayed privately.`
      : `Your message is relayed privately. The recipient's address is not exposed.`;
  }

  openModal('contactMemberModal');
  setTimeout(() => {
    const firstEmpty = (!nameEl || !nameEl.value) ? nameEl
                      : (!emailEl || !emailEl.value) ? emailEl
                      : subjectEl;
    if (firstEmpty) firstEmpty.focus();
  }, 100);
}

async function submitContactMessage(e) {
  if (e) e.preventDefault();

  const toEmail = document.getElementById('contactToEmail').value.trim();
  const toName  = document.getElementById('contactToName').value.trim();
  const fromName  = document.getElementById('contactFromName').value.trim();
  const fromEmail = document.getElementById('contactFromEmail').value.trim();
  const subject   = document.getElementById('contactSubject').value.trim();
  const message   = document.getElementById('contactMessage').value.trim();

  if (!toEmail)         return showToast('Recipient email is missing.', 'error');
  if (!fromName)        return showToast('Please enter your name.', 'error');
  if (!fromEmail)       return showToast('Please enter your email.', 'error');
  if (!subject)         return showToast('Please enter a subject.', 'error');
  if (!message)         return showToast('Please enter your message.', 'error');
  if (message.length > 5000) return showToast('Message is too long (max 5,000 characters).', 'error');

  const btn = document.getElementById('contactSubmitBtn');
  const originalHTML = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending…';
  }

  try {
    const res = await fetch(`${API_BASE}/contact/team`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toEmail, toName, fromName, fromEmail, subject, message })
    });
    const data = await res.json();

    if (data.success) {
      closeModal('contactMemberModal');
      showToast('✅ ' + (data.message || 'Message sent.'), 'success');
    } else {
      showToast(data.message || 'Could not send message.', 'error');
    }
  } catch (err) {
    console.error('[contact/team]', err);
    showToast('Network error. Please try again.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHTML || '<i class="fas fa-paper-plane"></i> Send Message';
    }
  }
}

/* ============================================================
   ADMIN — Organization Tab (Edit Owner Profile)
   ============================================================ */
function renderAdminOrganizationTab() {
  const container = document.getElementById('adminOrganizationContent');
  if (!container) return;

  const o = liveOwnerProfile || {};
  const preview = o.photo
    ? `<img src="${o.photo}" class="owner-preview-img" alt="Preview" id="ownerPhotoPreview">`
    : `<div class="owner-preview-fallback" id="ownerPhotoPreview">${escapeHtml(getInitials(o.name || '?'))}</div>`;

  const isVisible = o.visible !== false;
  const visibilityPill = isVisible
    ? `<span class="visibility-pill visibility-visible" title="Visible to students"><i class="fas fa-eye"></i> Visible to students</span>`
    : `<span class="visibility-pill visibility-hidden" title="Hidden from students"><i class="fas fa-eye-slash"></i> Hidden from students</span>`;

  const toggleBtn = isVisible
    ? `<button class="btn btn-outline" onclick="toggleOwnerVisibility(false)" title="Hide this founder section from students">
         <i class="fas fa-eye-slash"></i> Hide Founder Section
       </button>`
    : `<button class="btn btn-success" onclick="toggleOwnerVisibility(true)" title="Show this founder section to students">
         <i class="fas fa-eye"></i> Show Founder Section
       </button>`;

  container.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-header" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <h3 class="editor-section-title" style="margin:0;">
          <i class="fas fa-building-user"></i> Owner / Head Owner Profile
          ${visibilityPill}
        </h3>
        <div>${toggleBtn}</div>
      </div>
      <p class="editor-hint">
        These details power the "About the Founder" section on the student home page.
        Changes go live immediately — no redeployment required.
        Use <strong>Hide Founder Section</strong> to temporarily remove it from the student view.
      </p>

      <div class="editor-grid-2">
        <div class="form-group">
          <label>Display Name *</label>
          <input type="text" id="ownerName" value="${escapeHtml(o.name || '')}" maxlength="80" placeholder="e.g. Krish Yadav">
        </div>
        <div class="form-group">
          <label>Role / Designation *</label>
          <input type="text" id="ownerRole" value="${escapeHtml(o.role || '')}" maxlength="60" placeholder="e.g. Founder, Head Owner">
        </div>
      </div>

      <div class="form-group">
        <label>Professional Title</label>
        <input type="text" id="ownerTitle" value="${escapeHtml(o.title || '')}" maxlength="120" placeholder="e.g. Founder & Course Director">
      </div>

      <div class="form-group">
        <label>Short Bio</label>
        <textarea id="ownerBio" rows="5" maxlength="2000" placeholder="Two or three sentences describing this person…">${escapeHtml(o.bio || '')}</textarea>
        <span class="hint">Max 2,000 characters.</span>
      </div>

      <div class="editor-grid-2">
        <div class="form-group">
          <label>Contact Email</label>
          <input type="email" id="ownerEmail" value="${escapeHtml(o.email || '')}" maxlength="200" placeholder="founder@example.com">
          <span class="hint">Students will see a "Message" button (private relay).</span>
        </div>
        <div class="form-group">
          <label>Phone (with country code)</label>
          <input type="tel" id="ownerPhone" value="${escapeHtml(o.phone || '')}" maxlength="40" placeholder="+91 98765 43210">
          <span class="hint">Shown as a click-to-call button.</span>
        </div>
      </div>

      <div class="editor-section-title" style="margin-top:20px;"><i class="fas fa-image"></i> Profile Photo</div>
      <div class="thumbnail-editor">
        ${preview}
        <div class="thumbnail-actions">
          <input type="file" id="ownerPhotoInput" accept="image/*" style="display:none;" onchange="previewOwnerPhoto(this)">
          <button class="btn btn-outline btn-sm" onclick="document.getElementById('ownerPhotoInput').click()">
            <i class="fas fa-upload"></i> Upload Photo
          </button>
          ${o.photo ? `<button class="btn btn-outline btn-sm" onclick="removeOwnerPhoto()"><i class="fas fa-times"></i> Remove</button>` : ''}
          <span class="hint" style="margin-top:6px;">Square images work best. Max 2 MB.</span>
        </div>
      </div>
    </div>

    <div class="editor-footer" style="position:static;">
      <div class="editor-footer-left">
        <span class="editor-hint"><i class="fas fa-info-circle"></i> Updates apply instantly across the platform.</span>
      </div>
      <div class="editor-footer-right">
        <button class="btn btn-outline" onclick="renderAdminOrganizationTab()"><i class="fas fa-rotate-left"></i> Reset</button>
        <button class="btn btn-primary btn-lg" onclick="saveOwnerProfile()"><i class="fas fa-save"></i> Save Profile</button>
      </div>
    </div>
  `;
}

function previewOwnerPhoto(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) return showToast('Image too large (max 2 MB).', 'error');
  const reader = new FileReader();
  reader.onload = (e) => {
    const prev = document.getElementById('ownerPhotoPreview');
    if (prev) {
      const img = document.createElement('img');
      img.src = e.target.result;
      img.className = 'owner-preview-img';
      img.id = 'ownerPhotoPreview';
      img.alt = 'Preview';
      prev.replaceWith(img);
    }
    // cache so save knows about it
    window.__pendingOwnerPhotoFile = file;
  };
  reader.readAsDataURL(file);
}

function removeOwnerPhoto() {
  // ⚠️ FIX: Clear the queued File object too, not just the preview.
  // Without this, saveOwnerProfile() will re-upload the deleted photo.
  window.__pendingOwnerPhoto     = '';
  window.__pendingOwnerPhotoFile = null;

  const prev = document.getElementById('ownerPhotoPreview');
  if (prev) {
    const fallback = document.createElement('div');
    fallback.className = 'owner-preview-fallback';
    fallback.id = 'ownerPhotoPreview';
    fallback.textContent = getInitials(document.getElementById('ownerName')?.value || '?');
    prev.replaceWith(fallback);
  }
}

async function saveOwnerProfile() {
  const name  = (document.getElementById('ownerName')?.value || '').trim();
  const role  = (document.getElementById('ownerRole')?.value || '').trim();
  const title = (document.getElementById('ownerTitle')?.value || '').trim();
  const bio   = (document.getElementById('ownerBio')?.value || '').trim();
  const email = (document.getElementById('ownerEmail')?.value || '').trim();
  const phone = (document.getElementById('ownerPhone')?.value || '').trim();

  if (!name) return showToast('Display name is required.', 'error');
  if (!role) return showToast('Role is required.', 'error');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return showToast('Please enter a valid email address.', 'error');
  }

  const payload = {
    adminId: currentUser._id,
    name, role, title, bio, email, phone
  };
  // If a new photo was selected, upload it to disk first
  if (window.__pendingOwnerPhotoFile) {
    try {
      showToast('Uploading founder photo…', 'info');
      const result = await uploadFileToServer(window.__pendingOwnerPhotoFile);
      payload.photo = result.url;
    } catch (err) {
      return showToast('Photo upload failed: ' + err.message, 'error');
    }
  }

  try {
    const data = await fetchJSON(`${API_BASE}/admin/settings/owner`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (data.success) {
      liveOwnerProfile = data.owner;
      window.__pendingOwnerPhoto = undefined;
      showToast('✅ Organization profile saved.', 'success');
      renderAdminOrganizationTab();
      // Refresh the student view if it's currently shown
      if (studentNav === 'home' && currentUser.role === 'student') {
        renderOwnerProfile();
      }
    } else {
      showToast(data.message || 'Failed to save.', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Server error.', 'error');
  }
}

/* ------------------------------------------------------------
   Toggle owner / founder visibility (hide/show without deletion)
   ------------------------------------------------------------ */
async function toggleOwnerVisibility(newVisible) {
  const action = newVisible ? 'show' : 'hide';
  if (!confirm(
    `Are you sure you want to ${action} the founder section ` +
    `${newVisible ? 'to' : 'from'} students?\n\n` +
    `All details are preserved — only visibility changes.`
  )) return;

  try {
    const data = await fetchJSON(`${API_BASE}/admin/settings/owner`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminId: currentUser._id,
        visible: newVisible
      })
    });

    if (data.success) {
      // Update local cache so student home reflects the change instantly
      liveOwnerProfile.visible = newVisible;
      _ownerProfileLoaded = true;

      showToast(
        newVisible ? '👁️ Founder section is now visible to students.' : '🙈 Founder section hidden from students.',
        'success'
      );
      renderAdminOrganizationTab();
    } else {
      showToast(data.message || 'Failed to update visibility.', 'error');
    }
  } catch (err) {
    console.error('[toggleOwnerVisibility]', err);
    showToast('Server error while updating visibility.', 'error');
  }
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
  const totalQuestions = (course.materials || []).reduce((s, m) => s + (m.quizCount !== undefined ? m.quizCount : (m.quiz || []).length), 0);
  const quizzesCount = (course.materials || []).filter(m => (m.quizCount !== undefined ? m.quizCount : (m.quiz || []).length) > 0).length;

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
          <label>Or Upload File (PDF, PPT, DOCX) — Optional · max 500 MB</label>
          <input type="file" id="newMatInlineFile">
        </div>

        <div class="editor-grid-2">
          <div class="form-group">
            <label>Access Level</label>
            <label class="toggle-box pro" style="margin-top:6px;">
              <input type="checkbox" id="newMatInlinePremium"
                     onchange="document.getElementById('newMatInlinePreviewGroup').style.display=this.checked?'block':'none';">
              <span><i class="fas fa-crown"></i> PRO Material</span>
            </label>
          </div>
          <div class="form-group">
            <label>Price (₹) — only if PRO</label>
            <input type="number" id="newMatInlinePrice" value="0" min="0" step="1">
          </div>
        </div>

        <div class="form-group" id="newMatInlinePreviewGroup" style="display:none;">
          <label><i class="fas fa-eye"></i> Free Preview Percentage</label>
          <input type="number" id="newMatInlinePreview" value="0" min="0" max="100" step="1">
          <span class="hint">0 = no preview. 10 = first 10% of the PDF is free to read.</span>
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
    const quizCount = m.quizCount !== undefined ? m.quizCount : (m.quiz || []).length;
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
  const quizCount = m.quizCount !== undefined ? m.quizCount : (m.quiz || []).length;
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
        <div class="editor-grid-2">
          <div class="form-group">
            <label><i class="fas fa-eye"></i> Free Preview Percentage</label>
            <input type="number" class="me-preview" value="${m.previewPercent || 0}" min="0" max="100" step="1">
            <span class="hint">0 = no preview. 10 = first 10% of the PDF is free.</span>
          </div>
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
          <button class="btn btn-danger btn-sm" onclick="deleteMaterialFromEditor('${courseId}', '${m.id}', ${jsStr(m.title)})"><i class="fas fa-trash"></i> Delete</button>
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
    const res = await fetch(`/api/courses/${courseId}/playlists`, {
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
    const res = await fetch(`/api/courses/${courseId}/playlists/auto-videos`, {
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
    const res = await fetch(`/api/courses/${courseId}/playlists/${playlistId}`, {
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
    const res = await fetch(`/api/courses/${courseId}/playlists/${playlistId}`, {
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
    const res = await fetch(`/api/courses/${courseId}/playlists/${playlistId}/materials`, {
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
    const res = await fetch(`/api/courses/${courseId}/playlists/${playlistId}/materials/${materialId}`, {
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
    const res = await fetch(`/api/courses/${courseId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) { showToast('✅ Saved!', 'success'); await fetchCoursesFromDB(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

async function handleThumbnailUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) return showToast('Image too large (max 10 MB).', 'error');
  try {
    showToast('Uploading thumbnail…', 'info');
    const result = await uploadFileToServer(file);
    const res = await fetch(`/api/courses/${editingCourseId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thumbnail: result.url })
    });
    const data = await res.json();
    if (data.success) { showToast('✓ Thumbnail updated!', 'success'); await fetchCoursesFromDB(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch (err) { showToast('Upload failed: ' + err.message, 'error'); }
}

async function removeThumbnail() {
  try {
    const res = await fetch(`/api/courses/${editingCourseId}`, {
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
    const res = await fetch(`/api/courses/${courseId}/materials`, {
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

  const isPremium = el.querySelector('.me-premium').checked;
  const previewRaw = parseInt(el.querySelector('.me-preview')?.value, 10);
  const previewPercent = isPremium
    ? Math.max(0, Math.min(100, Number.isFinite(previewRaw) ? previewRaw : 0))
    : 0;

  const payload = {
    title: el.querySelector('.me-title').value.trim(),
    type: resolvedType,
    description: el.querySelector('.me-desc').value.trim(),
    url: el.querySelector('.me-url').value.trim(),
    isPremium: isPremium,
    price: parseFloat(el.querySelector('.me-price').value) || 0,
    previewPercent: previewPercent
  };
  if (!payload.title) return showToast('Title required.', 'error');
  try {
    const res = await fetch(`/api/courses/${courseId}/materials/${materialId}`, {
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

  // ⭐ NEW — reset the preview field + hide its group
  const previewEl = $('newMatInlinePreview');
  if (previewEl) previewEl.value = '0';
  const previewGroup = $('newMatInlinePreviewGroup');
  if (previewGroup) previewGroup.style.display = 'none';

  const grp = $('newMatInlineCustomGroup');
  if (grp) grp.style.display = 'none';
}
async function saveNewMaterialInline(courseId) {
  const titleEl  = $('newMatInlineTitle');
  const typeEl   = $('newMatInlineType');
  const customEl = $('newMatInlineCustomType');
  const descEl   = $('newMatInlineDescription');
  const urlEl    = $('newMatInlineUrl');
  const premEl   = $('newMatInlinePremium');
  const priceEl  = $('newMatInlinePrice');
  const fileEl   = $('newMatInlineFile');
  const btn      = $('newMatInlineSubmitBtn');

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
  // ⭐ NEW — read + clamp preview percentage
  const previewRaw = parseInt($('newMatInlinePreview')?.value, 10);
  const previewPercent = isPremium
    ? Math.max(0, Math.min(100, Number.isFinite(previewRaw) ? previewRaw : 0))
    : 0;
  const file = fileEl && fileEl.files ? fileEl.files[0] : null;

  const doSave = async (fileData, fileName, cloudUrl, publicId, diskName) => {
    // FIX: Determine if fileData is a URL from an uploaded file
    const isUploadedFile = fileData && (fileData.startsWith('/uploads/') || fileData.startsWith('http'));

    const payload = {
      title,
      type: resolvedType,
      description: descEl ? descEl.value.trim() : '',
      url: isUploadedFile ? fileData : (urlEl ? urlEl.value.trim() : ''),
      cloudUrl: cloudUrl || '',
      cloudinaryPublicId: publicId || '',
      diskName: diskName || '',
      isPremium,
      price,
      previewPercent,                       // ⭐ NEW
      fileData: isUploadedFile ? '' : (fileData || ''),
      fileName: fileName || ''
    };

    try {
      const res = await fetch(`/api/courses/${courseId}/materials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data.success) {
        showToast('📎 Material added!', 'success');
        resetNewMaterialInlineForm();

        // ---- 1) INSTANT local update from the POST response ----
        if (data.course && data.course._id) {
          const updated = data.course;
          const idx = liveCourses.findIndex(
            c => c.id === updated._id || c._id === updated._id
          );
          if (idx >= 0) {
            liveCourses[idx].materials = (updated.materials || []).map(m => ({
              _id: m._id,
              id: m._id,
              title: m.title,
              type: m.type,
              description: m.description || '',
              url: m.url || '',
              fileName: m.fileName || '',
              isPremium: !!m.isPremium,
              price: m.price || 0,
              estimatedTime: m.estimatedTime || '',
              tags: m.tags || '',
              examConfig: m.examConfig || {},
              quizCount: (m.quiz || []).length
            }));
          }
          _courseCacheAt = Date.now();
        }

        // ---- 2) Re-render with fresh data ----
        renderApp();
        if (editingCourseId === courseId) {
          renderCourseEditor(courseId);
        }

        // ---- 3) Background refetch for full consistency (cache-busted) ----
        fetchCoursesFromDB(true).catch(err =>
          console.warn('[material add] background refetch failed:', err)
        );

        // ---- 4) Scroll to the newest card + flash highlight ----
        setTimeout(() => {
          const cards = document.querySelectorAll(
            '#courseEditorContent .material-editor:not(.material-editor-new)'
          );
          if (cards.length > 0) {
            const newest = cards[cards.length - 1];
            newest.setAttribute('open', '');
            newest.scrollIntoView({ behavior: 'smooth', block: 'center' });

            const originalShadow = newest.style.boxShadow;
            newest.style.transition = 'box-shadow .4s ease';
            newest.style.boxShadow =
              '0 0 0 3px rgba(16,185,129,.55), 0 0 32px rgba(16,185,129,.4)';
            setTimeout(() => {
              newest.style.boxShadow = originalShadow || '';
            }, 3200);
          }
        }, 300);
      } else {
        showToast(data.message || 'Failed to add material.', 'error');
      }
    } catch (err) {
      console.error('[saveNewMaterialInline]', err);
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
    if (file.size > 500 * 1024 * 1024) {
      showToast('File too large (max 500 MB).', 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-plus-circle"></i> Add This Material';
      }
      return;
    }
    try {
      showToast(`Uploading ${file.name}…`, 'info');
      const result = await uploadFileToServer(file, (pct) => {
        if (btn) btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Uploading ${pct}%`;
      });
      await doSave(result.url, result.fileName, result.cloudUrl, result.publicId, result.diskName);
    } catch (err) {
      showToast('Upload failed: ' + err.message, 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-plus-circle"></i> Add This Material';
      }
    }
  } else {
    doSave('', '', '', '', '');
  }
}
async function deleteMaterialFromEditor(courseId, materialId, title) {
  if (!confirm(`Delete "${title}"?`)) return;
  try {
    const res = await fetch(`/api/courses/${courseId}/materials/${materialId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) { showToast('Deleted.', 'info'); await fetchCoursesFromDB(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

function replaceMaterialFile(courseId, materialId) {
  const el = document.querySelector(`.material-editor[data-mat-id="${materialId}"]`);
  if (el) el.querySelector('.me-file-input').click();
}

async function handleNewMaterialFile(input, courseId, materialId) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 500 * 1024 * 1024) return showToast('File too large (max 500 MB).', 'error');
  try {
    showToast(`Uploading ${file.name}…`, 'info');
    const result = await uploadFileToServer(file);
    const res = await fetch(`/api/courses/${courseId}/materials/${materialId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: result.url, fileName: result.fileName })
    });
    const data = await res.json();
    if (data.success) { showToast('✓ File replaced!', 'success'); await fetchCoursesFromDB(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch (err) { showToast('Upload failed: ' + err.message, 'error'); }
}

async function postAnnouncement(courseId) {
  const title = $('annTitle').value.trim();
  const body = $('annBody').value.trim();
  if (!title) return showToast('Title required.', 'error');
  try {
    const res = await fetch(`/api/courses/${courseId}/announcements`, {
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
    const res = await fetch(`/api/courses/${courseId}/announcements/${annId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) { showToast('Deleted.', 'info'); await fetchCoursesFromDB(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

/* ============================================================
   STUDENT HOME
   ============================================================ */
function getInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// LOCATE AND REPLACE THE renderOwnerProfile FUNCTION IN app.js
// LOCATE AND REPLACE THE renderOwnerProfile FUNCTION IN app.js
function renderOwnerProfile() {
  const container = document.getElementById('ownerProfileContainer');
  if (!container) return;

  // 1. Agar data abhi load nahi hua hai, toh container ko khaali rakho.
  // Isse koi bhi static ya fake text flash nahi hoga.
  if (!_ownerProfileLoaded) {
    container.innerHTML = '';
    return;
  }

  // 2. Agar data load ho gaya hai lekin database mein founder set nahi hai,
  // toh bhi container ko khaali rakho.
  if (!liveOwnerProfile.name) {
    container.innerHTML = '';
    return;
  }

  // 3. Data mil gaya, ab real content render karo
  const o = liveOwnerProfile;

  // ⭐ Admin has hidden the founder section — render nothing.
  if (o.visible === false) {
    container.innerHTML = '';
    return;
  }

  const avatarHtml = o.photo
    ? `<img src="${o.photo}" alt="${escapeHtml(o.name)}" class="owner-avatar-img" loading="lazy">`
    : `<div class="owner-avatar-fallback">${escapeHtml(getInitials(o.name))}</div>`;

  const contactHtml = [];
  if (o.email) {
    contactHtml.push(`
      <button type="button" class="contact-chip contact-chip-email"
              onclick="openContactMemberModal(${JSON.stringify(o.email).replace(/"/g, '&quot;')}, ${JSON.stringify(o.name).replace(/"/g, '&quot;')}, 'Founder')">
        <i class="fas fa-envelope"></i> Email
      </button>`);
  }
  if (o.phone) {
    contactHtml.push(`
      <a href="tel:${escapeHtml(o.phone.replace(/\s+/g, ''))}" class="contact-chip contact-chip-phone">
        <i class="fas fa-phone"></i> Call
      </a>`);
  }

  container.innerHTML = `
    <div class="owner-container">
      <div class="owner-image owner-avatar">${avatarHtml}</div>
      <div class="owner-details">
        <span class="owner-role-badge">${escapeHtml(o.role || 'Founder')}</span>
        <h3>${escapeHtml(o.name)}</h3>
        <div class="owner-title">${escapeHtml(o.title || '')}</div>
        <p>${escapeHtml(o.bio || '')}</p>
        ${contactHtml.length ? `<div class="owner-contact-row">${contactHtml.join('')}</div>` : ''}
      </div>
    </div>
  `;
}
/* ============================================================
   Community cache — alumni & friends (5-minute TTL)
   ============================================================ */
let _alumniCache  = { data: null, at: 0 };
let _friendsCache = { data: null, at: 0 };
const COMMUNITY_CACHE_MS = 5 * 60 * 1000;

function invalidateCommunityCache() {
  _alumniCache  = { data: null, at: 0 };
  _friendsCache = { data: null, at: 0 };
}

function renderStudentHome() {
  renderXPWidget();
  renderSubscriptionBanner();
  renderStreakCard();
  renderContinueCard();
  renderOwnerProfile();
  renderAlumniSection();
  renderFriendsSection();
  loadApprovedFeedback();
  loadMyContributions();
  renderTestimonials();

  // ⭐ Paint the grid immediately with whatever we already have in memory
  renderProfessorsGrid();

  // ⭐ Then refresh from the server in the background. When it lands,
  //    re-paint the grid AND the founder block. Both respect a 30s TTL.
  fetchProfessorsFromDB().then(() => {
    if (studentNav === 'home' && !currentCourseId) {
      renderProfessorsGrid();
    }
  });

  // Same background refresh for the founder profile — this is what
  // makes hide/show reach students without a full page reload.
  fetchOwnerProfile().then(() => {
    if (studentNav === 'home' && !currentCourseId) {
      renderOwnerProfile();
    }
  });
}
/* ============================================================
   DYNAMIC TESTIMONIALS — pulls from approved feedback DB
   ============================================================ */
async function renderTestimonials() {
  const slider = document.getElementById('testimonialsSlider');
  if (!slider) return;

  // 30s in-memory cache
  if (renderTestimonials._cache && (Date.now() - renderTestimonials._at) < 30000) {
    paintTestimonials(slider, renderTestimonials._cache);
    return;
  }

  try {
    const data = await fetchJSON(`${API_BASE}/feedback?_t=${Date.now()}`);
    const list = (data && data.success && Array.isArray(data.feedback)) ? data.feedback : [];
    renderTestimonials._cache = list;
    renderTestimonials._at = Date.now();
    paintTestimonials(slider, list);
  } catch (e) {
    console.warn('[testimonials]', e.message);
    slider.innerHTML = `
      <div class="empty-state" style="padding:30px 20px;">
        <i class="fas fa-star"></i>
        <p>No reviews yet — be the first to share yours!</p>
      </div>`;
  }
}

function paintTestimonials(slider, list) {
  if (!list || list.length === 0) {
    slider.innerHTML = `
      <div class="empty-state" style="padding:40px 20px;">
        <i class="fas fa-star-half-alt"></i>
        <p>No reviews yet — be the first to share yours!</p>
        <button class="btn btn-primary" style="margin-top:14px;"
                onclick="openFeedbackModal()">
          <i class="fas fa-pen"></i> Write a Review
        </button>
      </div>`;
    return;
  }

  const top = list.slice(0, 6);
  let html = '';
  top.forEach(f => {
    const name = f.studentName || f.studentUsername || 'Student';
    const initials = name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
    const stars = '★'.repeat(f.rating || 5) + '☆'.repeat(5 - (f.rating || 5));
    const when = f.approvedAt || f.submittedAt
      ? new Date(f.approvedAt || f.submittedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : '';

    html += `
      <div class="testimonial-card testimonial-real">
        <div class="testimonial-head">
          <div class="testimonial-avatar">${escapeHtml(initials)}</div>
          <div class="testimonial-meta">
            <h4>${escapeHtml(name)}</h4>
            <span class="testimonial-stars" aria-label="${f.rating || 5} stars">${stars}</span>
          </div>
          ${when ? `<span class="testimonial-date">${when}</span>` : ''}
        </div>
        ${f.title ? `<div class="testimonial-title">${escapeHtml(f.title)}</div>` : ''}
        <p class="testimonial-body">${escapeHtml(f.message)}</p>
        ${f.courseName ? `<div class="testimonial-course"><i class="fas fa-graduation-cap"></i> ${escapeHtml(f.courseName)}</div>` : ''}
      </div>`;
  });
  slider.innerHTML = html;
}
/* ------------------------------------------------------------
   Renders the "Our Team" professor grid (visible-only).
   Extracted so it can be re-run after a background refresh.
   ------------------------------------------------------------ */
function renderProfessorsGrid() {
  const grid = $('professorsGrid');
  if (!grid) return;

  // Only show professors the admin has marked as visible.
  // Legacy documents without a `visible` field are treated as visible.
  const professors = getProfessors().filter(p => p.visible !== false);

  if (professors.length === 0) {
    grid.innerHTML = `<p style="color:var(--text-tertiary);">No professors added yet.</p>`;
    return;
  }

  let html = '';
  professors.forEach(p => {
    const photoHtml = p.photo
      ? `<img src="${p.photo}" alt="${escapeHtml(p.name)}" class="team-avatar" loading="lazy">`
      : `<div class="team-avatar team-avatar-fallback">${escapeHtml(getInitials(p.name))}</div>`;

    const contactButtons = [];
    if (p.email) {
      contactButtons.push(`
        <button type="button" class="contact-chip contact-chip-email"
                onclick="openContactMemberModal(${JSON.stringify(p.email).replace(/"/g, '&quot;')}, ${JSON.stringify(p.name).replace(/"/g, '&quot;')}, ${JSON.stringify(p.title || '').replace(/"/g, '&quot;')})">
          <i class="fas fa-envelope"></i> Message
        </button>`);
    }
    if (p.phone) {
      contactButtons.push(`
        <a href="tel:${escapeHtml(p.phone.replace(/\s+/g, ''))}" class="contact-chip contact-chip-phone">
          <i class="fas fa-phone"></i> Call
        </a>`);
    }

    html += `
      <div class="professor-card">
        ${photoHtml}
        <h3>${escapeHtml(p.name)}</h3>
        <div class="prof-title">${escapeHtml(p.title)}</div>
        <p>${escapeHtml(p.description) || ''}</p>
        ${contactButtons.length ? `<div class="team-contact-row">${contactButtons.join('')}</div>` : ''}
      </div>`;
  });

  grid.innerHTML = html;
}

function renderStreakCard() {
  const container = document.getElementById('streakCardContainer');
  if (!container) return;
  if (isAdmin(currentUser)) { container.innerHTML = ''; return; }
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
/* ============================================================
   XP + LEVEL WIDGET
   ============================================================ */
function renderXPWidget() {
  const container = document.getElementById('streakCardContainer');
  if (!container) return;

  if (!currentUser || isAdmin(currentUser)) return;

  const existing = document.getElementById('xpWidget');
  if (existing) existing.remove();

  const info = currentUser.levelInfo || {
    level: 1, name: 'Cadet', xp: 0,
    nextLevelXP: 100, pctToNext: 0, isMax: false
  };
  const xp = currentUser.xp || 0;

  const widget = document.createElement('div');
  widget.id = 'xpWidget';
  widget.className = 'xp-widget';
  widget.innerHTML = `
    <div class="xp-badge">
      <i class="fas ${info.icon || 'fa-user'}"></i>
      <span class="xp-badge-lvl">${info.level}</span>
    </div>
    <div class="xp-body">
      <div class="xp-top">
        <span class="xp-rank">${escapeHtml(info.name)}</span>
        <span class="xp-amount">
          ${info.isMax
            ? `<strong>${xp.toLocaleString()}</strong> XP · MAX`
            : `<strong>${xp.toLocaleString()}</strong> / ${(info.nextLevelXP || 0).toLocaleString()} XP`}
        </span>
      </div>
      <div class="xp-bar">
        <div class="xp-fill" style="width:${info.pctToNext}%"></div>
      </div>
      ${!info.isMax
        ? `<div class="xp-hint">${(info.nextLevelXP - xp).toLocaleString()} XP until <strong>${escapeHtml(info.nextLevelName || 'next rank')}</strong></div>`
        : `<div class="xp-hint">🏆 You've reached the highest rank!</div>`}
    </div>
  `;

  container.parentNode.insertBefore(widget, container);
}

function renderContinueCard() {
  const container = document.getElementById('continueCardContainer');
  if (!container) return;

  const la = currentUser?.lastActivity;
  if (!la || !la.courseId || isAdmin(currentUser)) {
    container.innerHTML = '';
    return;
  }

  const course = findCourse(la.courseId);
  if (!course) { container.innerHTML = ''; return; }

  const acc = accentStyle(course.code || course.name);
  const viewedCount = getProgress(course.id).length;
  const totalMats = (course.materials || []).length;
  const pct = totalMats > 0 ? Math.round((viewedCount / totalMats) * 100) : 0;

  // Circle geometry: r=19, circumference = 2πr ≈ 119.38
  const radius = 19;
  const circumference = 2 * Math.PI * radius;
  const dash = (pct / 100) * circumference;

  container.innerHTML = `
    <div class="continue-card" style="${acc}">
      <div class="continue-ring" aria-label="${pct}% complete">
        <svg viewBox="0 0 44 44" width="64" height="64">
          <defs>
            <linearGradient id="contRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%"   stop-color="#6366f1"/>
              <stop offset="100%" stop-color="#06b6d4"/>
            </linearGradient>
          </defs>
          <circle class="continue-ring-track"
                  cx="22" cy="22" r="${radius}"
                  fill="none" stroke-width="3.5"/>
          <circle class="continue-ring-fill"
                  cx="22" cy="22" r="${radius}"
                  fill="none" stroke-width="3.5"
                  stroke-linecap="round"
                  stroke="url(#contRingGrad)"
                  stroke-dasharray="${dash} ${circumference}"
                  transform="rotate(-90 22 22)"/>
        </svg>
        <span class="continue-ring-pct">${pct}<span class="continue-ring-pct-sym">%</span></span>
      </div>
      <div class="continue-info">
        <span class="continue-label"><i class="fas fa-history"></i> Continue where you left off</span>
        <h3>${escapeHtml(course.name)}</h3>
        <p>${viewedCount} of ${totalMats} materials completed · ${timeAgo(la.timestamp)}</p>
      </div>
      <button class="btn btn-primary continue-btn" onclick="viewCourseDetail('${course.id}')">
        <i class="fas fa-play"></i> Resume
      </button>
    </div>`;
}
/* ============================================================
   SUBSCRIPTION — STUDENT UI
   ============================================================ */
/* ============================================================
   DEPRECATED — replaced by renderStudentSubscriptionBanner()
   (multi-tier aware). Kept as no-op for backward compat.
   ============================================================ */
function renderSubscriptionBanner() {
  /* no-op — new banner handles everything */
}

async function startSubscriptionCheckout() {
  if (!currentUser || currentUser.role !== 'student') {
    return showToast('Please log in as a student first.', 'error');
  }
  if (currentUser.isSubscribed) return showToast('You already have an active subscription.', 'info');
  if (!liveSubscriptionSettings.enabled) return showToast('Subscription is not available right now.', 'error');

  showToast('Preparing subscription…', 'info');

  // Lazy-load Razorpay SDK
  try { await window.loadRazorpay(); }
  catch { return showToast('Could not load payment gateway.', 'error'); }

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
/* ---- Debounced renderers (used by search inputs) ---- */
const debouncedRenderStudentCourses = debounce(renderStudentCourses, 250);
const debouncedRenderAdminCourses  = debounce(renderAdminCourses, 250);

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
  // ⚡ Safety Net 1: Loading in progress → show skeleton
  if (_coursesLoading && liveCourses.length === 0) {
    const el = $('studentCourseList');
    if (el) el.innerHTML = renderCoursesLoadingSkeleton('Loading courses…');
    return;
  }

  // ⚡ Safety Net 2 (STRONGER): We have NO course data and we're not
  //    loading. This is exactly the "cache stale, response empty" case.
  //    Reset the cache marker, fire the fetch, show the skeleton.
  if (liveCourses.length === 0 && !_coursesLoading) {
    const el = $('studentCourseList');
    if (el) el.innerHTML = renderCoursesLoadingSkeleton('Loading courses…');

    // Reset cache so subsequent renders don't loop
    _courseCacheAt = 0;

    fetchCoursesFromDB(true).catch(function (err) {
      console.warn('[renderStudentCourses] auto-fetch failed:', err);
    });
    return;
  }

  const courses = getCourses().filter(c => c.status !== 'draft' && c.status !== 'archived');
  const searchTerm  = ($('studentCourseSearch')?.value || '').toLowerCase().trim();
  const fSemester   = ($('filterSemester')?.value   || '').trim();
  const fCategory   = ($('filterCategory')?.value   || '').trim();
  const fDifficulty = ($('filterDifficulty')?.value || '').trim();
  const fPrice      = ($('filterPrice')?.value      || '').trim();

  function normalizeSemester(v) {
    if (v === null || v === undefined) return '';
    const s = String(v).trim();
    const m = s.match(/\d+/);
    return m ? m[0] : s.toLowerCase();
  }

  const filtered = courses.filter(c => {
    if (searchTerm) {
      const hit = (c.name || '').toLowerCase().includes(searchTerm) ||
                  (c.code && c.code.toLowerCase().includes(searchTerm)) ||
                  (c.instructor && c.instructor.toLowerCase().includes(searchTerm));
      if (!hit) return false;
    }
    if (fSemester) {
      const courseSem = normalizeSemester(c.semester);
      const filterSem = normalizeSemester(fSemester);
      if (courseSem !== filterSem) return false;
    }
    if (fCategory && c.category !== fCategory) return false;
    if (fDifficulty && c.difficulty !== fDifficulty) return false;
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
  if (!container) return;

  // ⚡ Same stronger safety net as renderStudentCourses
  if (_coursesLoading && liveCourses.length === 0) {
    container.innerHTML = renderCoursesLoadingSkeleton('Loading your saved courses…');
    return;
  }
  if (liveCourses.length === 0 && !_coursesLoading) {
    container.innerHTML = renderCoursesLoadingSkeleton('Loading your saved courses…');
    _courseCacheAt = 0;
    fetchCoursesFromDB(true).catch(function (err) {
      console.warn('[renderSavedCourses] auto-fetch failed:', err);
    });
    return;
  }

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

  // ⭐ Hydrate cached PDF thumbnails on the newly-rendered cards
  setTimeout(() => hydrateMaterialThumbs(), 30);
}

function renderMaterialCard(course, m, isPurchased) {
  const hasFile = (m.fileData && m.fileData.length > 0) || (m.fileName && m.fileName.length > 0);
  const hasUrl  = m.url && m.url.length > 0;

  const isMatPremium    = m.isPremium    === true || m.isPremium    === 'true';
  const isCoursePremium = course.isPremium === true || course.isPremium === 'true';

  const matPrice    = parseFloat(m.price)    || 0;
  const coursePrice = parseFloat(course.price) || 0;

  const isMatPurchased = currentUser && currentUser.purchases && currentUser.purchases.includes(m.id);
  const isSubscribed   = !!currentUser?.isSubscribed;
  const isAdminUser    = isAdmin(currentUser);

  const courseLocked   = isCoursePremium && !isPurchased    && !isSubscribed;
  const materialLocked = isMatPremium    && !isMatPurchased && !isSubscribed;
  const isLocked       = !isAdminUser && (courseLocked || materialLocked);
  const canAccess      = !isLocked;

  const viewed    = isMaterialViewed(course.id, m.id);
  const quizCount = m.quizCount !== undefined ? m.quizCount : (m.quiz || []).length;

  // ─── PDF detection ───
  const cleanUrl = (m.url || '').toLowerCase().split('?')[0].split('#')[0];
  const isPdf = (m.fileName || '').toLowerCase().endsWith('.pdf') ||
                cleanUrl.endsWith('.pdf') ||
                (m.fileData || '').startsWith('data:application/pdf');

  // ─── ⭐ Thumbnail (CSS cover for PDFs, real thumb if cached) ───
  let thumbHtml = '';
  if (isPdf) {
    const cachedThumb = getPDFThumbnail(m.id);
    const acc = getCourseAccent(course.code || course.name);
    if (cachedThumb) {
      thumbHtml = `<div class="material-thumb has-thumb" data-material-id="${m.id}">
        <img src="${cachedThumb}" alt="" loading="lazy" decoding="async">
        ${isLocked ? '<div class="material-thumb-lock"><i class="fas fa-lock"></i></div>' : ''}
      </div>`;
    } else {
      thumbHtml = `<div class="material-thumb" data-material-id="${m.id}"
                        style="background:linear-gradient(135deg, ${acc.from}, ${acc.to});">
        <div class="material-thumb-cover">
          <i class="fas fa-file-pdf"></i>
          <span>${escapeHtml(String(m.type || 'PDF').toUpperCase())}</span>
        </div>
        ${isLocked ? '<div class="material-thumb-lock"><i class="fas fa-lock"></i></div>' : ''}
      </div>`;
    }
  }

  // ─── Button logic ───
  let fileActionHtml = '';
  if (isLocked) {
    const previewPct = Math.max(0, Math.min(100, Number(m.previewPercent) || 0));
    // ⭐ Preview button only for material-level premium (not course-wide premium)
    const canPreview = !isCoursePremium && previewPct > 0;

    if (canPreview) {
      fileActionHtml += `<button class="btn btn-accent btn-sm"
                          onclick="event.stopPropagation();viewFileOnline('${course.id}', '${m.id}')">
                          <i class="fas fa-eye"></i> Preview ${previewPct}%
                        </button> `;
    }

    if (isCoursePremium) {
      fileActionHtml += `<button class="btn btn-warning btn-sm"
                          onclick="event.stopPropagation();showPaymentModal('${course.id}', null)">
                          <i class="fas fa-crown"></i> Unlock whole course ₹${coursePrice}
                        </button>`;
    } else {
      fileActionHtml += `<button class="btn btn-warning btn-sm"
                          onclick="event.stopPropagation();showPaymentModal('${course.id}', '${m.id}')">
                          <i class="fas fa-lock"></i> Unlock this file ₹${matPrice}
                        </button>`;
    }
  } else {
    if (m.type === 'video' && hasUrl && !hasFile) {
      fileActionHtml += `<button class="btn btn-primary btn-sm"
                          onclick="event.stopPropagation();openMaterialVideo('${course.id}', '${m.id}')">
                          <i class="fas fa-play"></i> Watch
                        </button>`;
    }

    if (hasFile && isPdf) {
      fileActionHtml += ` <button class="btn btn-primary btn-sm"
                          onclick="event.stopPropagation();viewFileOnline('${course.id}', '${m.id}')">
                          <i class="fas fa-book-open"></i> Read
                        </button>`;
    } else if (hasUrl && !hasFile && m.type !== 'video') {
      fileActionHtml += ` <button class="btn btn-primary btn-sm"
                          onclick="event.stopPropagation();viewFileOnline('${course.id}', '${m.id}')">
                          <i class="fas fa-book-open"></i> Read
                        </button>`;
    }
  }

  let progressBtnHtml = '';
  if (currentUser.role === 'student' && canAccess) {
    progressBtnHtml = `<button class="btn ${viewed ? 'btn-success' : 'btn-outline'} btn-sm"
                        onclick="event.stopPropagation();toggleMaterialViewed(event, '${course.id}', '${m.id}')">
                        <i class="fas ${viewed ? 'fa-check-circle' : 'fa-circle'}"></i>
                        ${viewed ? 'Completed' : 'Mark done'}
                      </button>`;
    if (quizCount > 0) {
      const qr = (currentUser.quizResults || {})[m.id];
      const label = qr ? `Retake (${qr.score}/${qr.total})` : `Take Quiz (${quizCount})`;
      progressBtnHtml += ` <button class="btn btn-accent btn-sm"
                            onclick="event.stopPropagation();openQuizPlayer('${course.id}', '${m.id}')">
                            <i class="fas fa-question-circle"></i> ${label}
                          </button>`;
    }
  }

  // ─── Badge logic ───
  let badgeHtml = '';
  if (isCoursePremium) {
    if (!isAdminUser && (isPurchased || isSubscribed)) {
      badgeHtml = `<span class="mat-badge unlocked"><i class="fas fa-unlock"></i> UNLOCKED</span>`;
    }
  } else if (isMatPremium) {
    if (isAdminUser || isSubscribed || isMatPurchased) {
      badgeHtml = `<span class="mat-badge unlocked"><i class="fas fa-unlock"></i> UNLOCKED</span>`;
    } else {
      badgeHtml = `<span class="mat-badge premium"><i class="fas fa-crown"></i> PRO (₹${matPrice})</span>`;
    }
  } else {
    badgeHtml = `<span class="mat-badge free">FREE</span>`;
  }

  const quizBadge = quizCount > 0
    ? `<span class="mat-quiz-badge"><i class="fas fa-question-circle"></i> ${quizCount}</span>`
    : '';

  return `
    <div class="material-item ${isLocked ? 'locked-mat' : ''}">
      ${thumbHtml}
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

    // ====== AI DOUBT SOLVER BOX ======
    html += `<div class="ai-doubt-box">
      <div class="ai-doubt-header">
        <div class="ai-doubt-icon"><i class="fas fa-robot"></i></div>
        <div>
          <h4>Ask AI Assistant</h4>
          <p>Get an instant answer while you wait for a human reply</p>
        </div>
      </div>
      <textarea id="aiDoubtInput-${course.id}" 
                placeholder="e.g. Explain Bernoulli's equation with an example…"
                rows="3"></textarea>
      <div class="ai-doubt-actions">
        <button class="btn btn-accent" onclick="askAIDoubt('${course.id}')">
          <i class="fas fa-sparkles"></i> Ask AI
        </button>
        <button class="btn btn-outline btn-sm" onclick="askAIDoubt('${course.id}', true)">
          <i class="fas fa-paper-plane"></i> Ask & Post Publicly
        </button>
      </div>
      <div class="ai-doubt-answer" id="aiDoubtAnswer-${course.id}" style="display:none;"></div>
    </div>`;
    // ====== END AI BOX ======
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
      const isAdminUser = isAdmin(currentUser);
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
        `/api/materials/${courseId}/${mat.id}/video-session`,
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
   MathJax v3 — SINGLE CLEAN IMPLEMENTATION
   ------------------------------------------------------------
   ONE source of truth. No duplicates. No conflicts.
   - Loads MathJax ONCE via window.loadMathJax() (defined in index.html)
   - Queues elements that need typesetting until MathJax is ready
   - Drains the queue automatically after startup
   ============================================================ */
window.__mathjaxReady   = false;
window.__mathjaxLoading = false;
window.__mathjaxQueue   = window.__mathjaxQueue || [];

function renderMathIn(el) {
  if (!el || !el.isConnected) return;

  // ---- Not ready yet: queue the element + trigger loader ----
  if (!window.__mathjaxReady ||
      !window.MathJax ||
      typeof window.MathJax.typesetPromise !== 'function') {

    if (!window.__mathjaxQueue.includes(el)) {
      window.__mathjaxQueue.push(el);
    }

    if (typeof window.loadMathJax === 'function' && !window.__mathjaxLoading) {
      window.__mathjaxLoading = true;
      window.loadMathJax()
        .then(() => {
          window.__mathjaxReady = true;
          console.log('[MathJax] ✅ ready');
          // Drain everything that was queued while MathJax was loading
          const q = window.__mathjaxQueue.splice(0);
          q.forEach(node => {
            if (node && node.isConnected) renderMathIn(node);
          });
        })
        .catch(err => {
          window.__mathjaxLoading = false;   // allow retry on next call
          console.warn('[MathJax] load failed:', err && err.message);
        });
    }
    return;
  }

  // ---- Ready: typeset this element ----
  try {
    window.MathJax.typesetPromise([el]).catch(err => {
      console.warn('[MathJax] typeset error:', err && err.message);
    });
  } catch (e) {
    console.warn('[MathJax] typeset threw:', e && e.message);
  }
}

/* ---- MathJax is loaded ON-DEMAND by renderMathIn() above ----
   Do NOT preload — it's ~1 MB and only needed for quizzes / AI answers.
   The queue is drained automatically inside renderMathIn() once MathJax
   finishes loading. */

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
async function openQuizEditor(courseId, materialId) {
  const course = findCourse(courseId);
  if (!course) return showToast('Course not found.', 'error');
  const mat = (course.materials || []).find(m => m.id === materialId);
  if (!mat) return showToast('Material not found.', 'error');

  // ─── CRITICAL FIX: load the full quiz array if it hasn't been loaded yet.
  // The /api/courses list strips `quiz` for perf — only `quizCount` arrives.
  // Without this fetch, the editor would open with zero questions.
  if (!Array.isArray(mat.quiz)) {
    const hasQuestions = (mat.quizCount || 0) > 0;
    if (hasQuestions) {
      try {
        showToast('Loading question paper…', 'info');
        const res = await fetch(
          `${API_BASE}/courses/${courseId}/materials/${materialId}/full-quiz?_t=${Date.now()}`
        );
        const data = await res.json();
        mat.quiz = (data && data.success && Array.isArray(data.quiz)) ? data.quiz : [];
        mat.examConfig = (data && data.examConfig) || mat.examConfig || {};
      } catch (e) {
        console.warn('[openQuizEditor] full-quiz fetch failed:', e);
        mat.quiz = [];
        showToast('Could not load existing questions — starting fresh.', 'error');
      }
    } else {
      mat.quiz = [];
    }
  }

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
  else { pushHash('#/admin/courses'); renderApp(); }
}

function normalizeQuestion(q) {
  const type = q.type || (Array.isArray(q.correctIndexes) && q.correctIndexes.length > 1
    ? 'multiple' : 'single');

  let correctIndexes = Array.isArray(q.correctIndexes) ? [...q.correctIndexes]
    : (typeof q.correctIndex === 'number' ? [q.correctIndex] : []);

  const numOrNull = (v) => (v === null || v === undefined || v === '') ? null : Number(v);

  return {
    type,
    question:    q.question    || '',
    explanation: q.explanation || '',

    options:        (q.options && q.options.length) ? [...q.options] : ['', '', '', ''],
    correctIndexes,

    integerAnswer:    numOrNull(q.integerAnswer),
    integerTolerance: Number(q.integerTolerance) || 0,

    /* ⭐ NEW: Numerical Range */
    rangeMin: numOrNull(q.rangeMin),
    rangeMax: numOrNull(q.rangeMax),

    /* ⭐ NEW: Subjective */
    subjectiveMaxMarks:     Number(q.subjectiveMaxMarks) || 10,
    subjectiveInstructions: q.subjectiveInstructions || '',

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
let _quizEditorLoading = false;
async function renderQuizEditor() {
  const container = document.getElementById('quizEditorContent');
  if (!container) return;
  const course = findCourse(quizEditingCourseId);
  if (!course) { container.innerHTML = '<p>Course not found.</p>'; return; }
  const mat = (course.materials || []).find(m => m.id === quizEditingMaterialId);
  if (!mat) { container.innerHTML = '<p>Material not found.</p>'; return; }

  // ─── Direct-URL access path: if the quiz array isn't loaded yet, fetch it.
  if (!Array.isArray(mat.quiz) && (mat.quizCount || 0) > 0 && !_quizEditorLoading) {
    _quizEditorLoading = true;
    container.innerHTML = `
      <div class="courses-loading">
        <div class="pdfv-spinner"></div>
        <p>Loading question paper…</p>
      </div>`;
    try {
      const res = await fetch(
        `${API_BASE}/courses/${quizEditingCourseId}/materials/${quizEditingMaterialId}/full-quiz?_t=${Date.now()}`
      );
      const data = await res.json();
      mat.quiz = (data && data.success && Array.isArray(data.quiz)) ? data.quiz : [];
      mat.examConfig = (data && data.examConfig) || mat.examConfig || {};
    } catch (e) {
      console.warn('[renderQuizEditor] fetch failed:', e);
      mat.quiz = [];
    } finally {
      _quizEditorLoading = false;
    }

    const saved = getSavedQuizDraft(quizEditingMaterialId);
    if (saved && Array.isArray(saved.quiz) && saved.quiz.length > 0) {
      quizDraft = saved.quiz.map(q => normalizeQuestion(q));
      quizPaperConfig = saved.config || { subject: '', paperCode: '', totalTime: '', totalMarks: 0 };
    } else {
      quizDraft = (mat.quiz || []).map(q => normalizeQuestion(q));
      const cfg = mat.examConfig || {};
      quizPaperConfig = {
        subject:    cfg.subject    || course.name || '',
        paperCode:  cfg.paperCode  || (course.code ? course.code + '-' + (mat.title || '') : ''),
        totalTime:  cfg.totalTime  || '',
        totalMarks: Number(cfg.totalMarks) || quizDraft.reduce((s, q) => s + (q.marks || 0), 0)
      };
    }
  }

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
          <button class="btn btn-outline btn-sm" onclick="addQuizQuestion('numerical')"><i class="fas fa-plus"></i> Numerical Range</button>
          <button class="btn btn-outline btn-sm" onclick="addQuizQuestion('matrix')"><i class="fas fa-plus"></i> Matrix Match</button>
          <button class="btn btn-outline btn-sm" onclick="addQuizQuestion('subjective')"><i class="fas fa-plus"></i> Subjective</button>
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
            <option value="single"     ${q.type === 'single'     ? 'selected' : ''}>Single Correct (MCQ)</option>
            <option value="multiple"   ${q.type === 'multiple'   ? 'selected' : ''}>Multiple Correct (MSQ)</option>
            <option value="integer"    ${q.type === 'integer'    ? 'selected' : ''}>Integer (exact match)</option>
            <option value="numerical"  ${q.type === 'numerical'  ? 'selected' : ''}>⭐ Numerical Range (min–max)</option>
            <option value="matrix"     ${q.type === 'matrix'     ? 'selected' : ''}>Matrix Match</option>
            <option value="subjective" ${q.type === 'subjective' ? 'selected' : ''}>⭐ Subjective (admin evaluates)</option>
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
  return ({
    single: 'SINGLE',
    multiple: 'MULTIPLE',
    integer: 'INTEGER',
    numerical: 'NUMERICAL RANGE',
    matrix: 'MATRIX',
    subjective: 'SUBJECTIVE'
  })[t] || 'SINGLE';
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
    if (q.type === 'numerical') {
    return `
      <div class="editor-grid-2">
        <div class="form-group">
          <label><i class="fas fa-arrow-down"></i> Minimum Accepted Value</label>
          <input type="number" step="any"
                 value="${q.rangeMin === null || q.rangeMin === undefined ? '' : q.rangeMin}"
                 placeholder="e.g. 9.7"
                 oninput="updateQuizField(${qi}, 'rangeMin', this.value === '' ? null : parseFloat(this.value))">
        </div>
        <div class="form-group">
          <label><i class="fas fa-arrow-up"></i> Maximum Accepted Value</label>
          <input type="number" step="any"
                 value="${q.rangeMax === null || q.rangeMax === undefined ? '' : q.rangeMax}"
                 placeholder="e.g. 10.3"
                 oninput="updateQuizField(${qi}, 'rangeMax', this.value === '' ? null : parseFloat(this.value))">
        </div>
      </div>
      <div class="numerical-range-preview">
        <i class="fas fa-bullseye"></i>
        <span>
          Any answer between
          <strong>${q.rangeMin ?? '?'}</strong> and <strong>${q.rangeMax ?? '?'}</strong>
          (inclusive) will be marked as <span class="ok-text">CORRECT</span>.
        </span>
      </div>`;
  }

  if (q.type === 'subjective') {
    return `
      <div class="editor-grid-2">
        <div class="form-group">
          <label><i class="fas fa-star"></i> Maximum Marks</label>
          <input type="number" min="1" max="1000" step="0.5"
                 value="${q.subjectiveMaxMarks || 10}"
                 oninput="updateQuizField(${qi}, 'subjectiveMaxMarks', parseFloat(this.value) || 10); updateQuizField(${qi}, 'marks', parseFloat(this.value) || 10);">
          <span class="hint">Admin can award marks from 0 up to this maximum.</span>
        </div>
        <div class="form-group">
          <label><i class="fas fa-info-circle"></i> Instructions for Students (optional)</label>
          <textarea rows="2" maxlength="500"
                    placeholder="e.g. Show all steps clearly. Upload clear, well-lit photos of your handwritten solution."
                    oninput="updateQuizField(${qi}, 'subjectiveInstructions', this.value)">${escapeHtml(q.subjectiveInstructions || '')}</textarea>
        </div>
      </div>
      <div class="subjective-info-box">
        <i class="fas fa-camera"></i>
        <div>
          <strong>How this works:</strong>
          <ul>
            <li>Students upload <strong>photos of their handwritten solution</strong> (JPG / PNG).</li>
            <li>Subjective answers are <strong>not auto-graded</strong> — they are marked as <em>Pending Evaluation</em>.</li>
            <li>Admin reviews submissions in the admin panel and awards marks out of <strong>${q.subjectiveMaxMarks || 10}</strong>.</li>
          </ul>
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
  } else if (type === 'numerical') {          // ⭐ NEW
    base.rangeMin = null;
    base.rangeMax = null;
    base.negativeMarks = 0;                   // no negative for range typically
  } else if (type === 'matrix') {
    base.matrixLeftItems  = ['', '', '', ''];
    base.matrixRightItems = ['', '', '', ''];
    base.matrixRows = [0, 1, 2, 3].map(i => ({ text: '', correctIndex: i }));
  } else if (type === 'subjective') {         // ⭐ NEW
    base.subjectiveMaxMarks = 10;
    base.subjectiveInstructions = '';
    base.marks = 10;                          // mirror subjectiveMaxMarks
    base.negativeMarks = 0;                   // no negative for subjective
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
  const oldType = q.type;
  q.type = newType;

  // Cleanup fields that don't belong to the new type
  const resetCommon = () => {
    q.options = [];
    q.correctIndexes = [];
    q.matrixLeftItems = [];
    q.matrixRightItems = [];
    q.matrixRows = [];
    q.integerAnswer = null;
    q.integerTolerance = 0;
    q.rangeMin = null;
    q.rangeMax = null;
    q.subjectiveMaxMarks = q.subjectiveMaxMarks || 10;
    q.subjectiveInstructions = q.subjectiveInstructions || '';
  };

  if (newType === 'integer' && oldType !== 'integer') {
    resetCommon();
  } else if (newType === 'numerical' && oldType !== 'numerical') {   // ⭐ NEW
    resetCommon();
    q.negativeMarks = 0;
  } else if (newType === 'matrix' && oldType !== 'matrix') {
    resetCommon();
    q.matrixLeftItems  = ['', '', '', ''];
    q.matrixRightItems = ['', '', '', ''];
    q.matrixRows = [0, 1, 2, 3].map(i => ({ text: '', correctIndex: i }));
  } else if (newType === 'subjective' && oldType !== 'subjective') { // ⭐ NEW
    resetCommon();
    if (!q.subjectiveMaxMarks || q.subjectiveMaxMarks < 1) q.subjectiveMaxMarks = 10;
    q.marks = q.subjectiveMaxMarks;
    q.negativeMarks = 0;
  } else if ((newType === 'single' || newType === 'multiple') &&
             oldType !== 'single' && oldType !== 'multiple') {
    resetCommon();
    if (!q.options || q.options.length === 0) q.options = ['', '', '', ''];
    if (!Array.isArray(q.correctIndexes)) q.correctIndexes = [];
  }

  if (newType === 'single' && Array.isArray(q.correctIndexes) && q.correctIndexes.length > 1) {
    q.correctIndexes = [q.correctIndexes[0]];
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
    if (q.type === 'numerical') {                                    // ⭐ NEW
      if (q.rangeMin === null || q.rangeMin === undefined || isNaN(Number(q.rangeMin))) {
        return showToast(`Question ${i + 1}: minimum value required.`, 'error');
      }
      if (q.rangeMax === null || q.rangeMax === undefined || isNaN(Number(q.rangeMax))) {
        return showToast(`Question ${i + 1}: maximum value required.`, 'error');
      }
      if (Number(q.rangeMin) > Number(q.rangeMax)) {
        return showToast(`Question ${i + 1}: minimum value cannot be greater than maximum.`, 'error');
      }
    }
    if (q.type === 'subjective') {                                   // ⭐ NEW
      const maxM = Number(q.subjectiveMaxMarks);
      if (!Number.isFinite(maxM) || maxM < 1) {
        return showToast(`Question ${i + 1}: maximum marks must be at least 1.`, 'error');
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
      `/api/courses/${quizEditingCourseId}/materials/${quizEditingMaterialId}/quiz`,
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

/* ============================================================
   QUIZ — PROCTORED FULL-PAGE EXAM MODE
   ------------------------------------------------------------
   Config:
     QUIZ_PROCTOR_MAX_STRIKES
       0 = zero-tolerance → first violation auto-submits
       1 = one grace warning, second violation auto-submits  (default)
       2 = two grace warnings, third auto-submits
   ============================================================ */
const QUIZ_PROCTOR_MAX_STRIKES = 1;

let quizPlayerState = null;

/* ---- Listener registry (cleanup after exam) ---- */
const _quizListeners = [];
function _attachProctorListener(target, event, handler, opts) {
  target.addEventListener(event, handler, opts);
  _quizListeners.push({ target, event, handler, opts });
}
function _detachAllProctorListeners() {
  while (_quizListeners.length) {
    const { target, event, handler, opts } = _quizListeners.pop();
    try { target.removeEventListener(event, handler, opts); } catch (e) {}
  }
}

/* ============================================================
   OPEN — Shows pre-exam consent first
   ============================================================ */
async function openQuizPlayer(courseId, materialId) {
  const course = findCourse(courseId); if (!course) return;
  const mat = (course.materials || []).find(m => m.id === materialId); if (!mat) return;

  // Quiz data is not in the cached list — fetch it on demand
  let quiz = mat.quiz;
  if (!quiz || quiz.length === 0) {
    try {
      showToast('Loading quiz…', 'info');
      const res = await fetch(`/api/courses/${courseId}/materials/${materialId}/full-quiz`);
      const data = await res.json();
      if (!data.success) return showToast(data.message || 'Could not load quiz.', 'error');
      quiz = data.quiz || [];
      mat.quiz = quiz;
      mat.examConfig = data.examConfig || mat.examConfig || {};
    } catch (e) {
      return showToast('Network error loading quiz.', 'error');
    }
  }
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
    paperConfig: mat.examConfig || {},
    previewMode: false,
    examStarted: false,
    strikes: 0,
    violations: [],
    startTime: null,
    violationHandling: false,
    fullscreenArmed: false
  };

  const cb = document.getElementById('preExamConsentBox');
  if (cb) cb.checked = false;
  const btn = document.getElementById('preExamBeginBtn');
  if (btn) btn.disabled = true;
  openModal('preExamWarningModal');
}

function togglePreExamConsent() {
  const cb = document.getElementById('preExamConsentBox');
  const btn = document.getElementById('preExamBeginBtn');
  if (btn) btn.disabled = !(cb && cb.checked);
}

function cancelPreExam() {
  closeModal('preExamWarningModal');
  quizPlayerState = null;
}

/* ============================================================
   BEGIN — Fullscreen + proctoring listeners
   ============================================================ */
async function beginExamSession() {
  if (!quizPlayerState) return;
  closeModal('preExamWarningModal');

  const shell = document.getElementById('quizExamShell');
  if (!shell) return;
  shell.style.display = 'flex';
  shell.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';

  try {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (req) { const p = req.call(el); if (p && p.catch) p.catch(() => {}); }
  } catch (e) {}

  quizPlayerState.examStarted = true;
  quizPlayerState.startTime = Date.now();

  _attachProctorListener(document, 'visibilitychange', _onExamVisibilityChange);
  _attachProctorListener(window, 'blur', _onExamWindowBlur);
  _attachProctorListener(document, 'fullscreenchange', _onExamFullscreenChange);
  _attachProctorListener(document, 'webkitfullscreenchange', _onExamFullscreenChange);
  _attachProctorListener(window, 'beforeunload', _onExamBeforeUnload);

  _attachProctorListener(document, 'contextmenu', _blockContextMenu, true);
  _attachProctorListener(document, 'copy', _blockCopy, true);
  _attachProctorListener(document, 'cut', _blockCopy, true);
  _attachProctorListener(document, 'paste', _blockCopy, true);
  _attachProctorListener(document, 'selectstart', _blockSelectStart, true);
  _attachProctorListener(document, 'dragstart', _blockDrag, true);
  _attachProctorListener(document, 'keydown', _blockDevKeys, true);

  setTimeout(() => { if (quizPlayerState) quizPlayerState.fullscreenArmed = true; }, 900);

  renderQuizExamShell();
  startQuizTimer();
  showToast('Exam started. Good luck!', 'success');
}

/* ============================================================
   RENDER — Full-page shell
   ============================================================ */
function renderQuizExamShell() {
  const st = quizPlayerState; if (!st) return;
  const shell = document.getElementById('quizExamShell');
  if (!shell) return;

  const cfg = st.paperConfig || {};
  const course = findCourse(st.courseId);
  const mat = course && (course.materials || []).find(m => m.id === st.materialId);
  const examCfg = cfg.subject ? cfg : (mat && mat.examConfig) || {};

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

  const headerHtml = `
    <header class="quiz-exam-header">
      <div class="quiz-exam-title-group">
        <div class="quiz-exam-title">
          <i class="fas fa-file-pen"></i>
          ${escapeHtml(examCfg.subject || st.materialTitle)}
        </div>
        <div class="quiz-exam-sub">
          ${examCfg.paperCode ? `<span><i class="fas fa-hashtag"></i> ${escapeHtml(examCfg.paperCode)}</span>` : ''}
          <span><i class="fas fa-list-ol"></i> ${st.quiz.length} question${st.quiz.length === 1 ? '' : 's'}</span>
          ${examCfg.totalMarks ? `<span><i class="fas fa-star"></i> Max ${examCfg.totalMarks}</span>` : ''}
        </div>
      </div>

      <div class="quiz-exam-timer-wrap">
        <div class="quiz-exam-timer" id="quizTimerDisplay">--:--</div>
        ${st.previewMode ? '' : '<div class="quiz-proctor-pill"><i class="fas fa-shield-halved"></i> Proctored</div>'}
      </div>

      <div class="quiz-exam-progress">
        <span class="quiz-exam-progress-text">
          <strong>${answered}</strong> / ${st.quiz.length} answered
        </span>
        <div class="quiz-exam-progress-bar">
          <div class="quiz-exam-progress-fill"
               style="width:${st.quiz.length > 0 ? (answered / st.quiz.length) * 100 : 0}%"></div>
        </div>
      </div>
    </header>
  `;

  let bodyHtml = '';
  if (!st.submitted) {
    let qHtml = '';
    st.quiz.forEach((q, qi) => {
      const qType = q.type || 'single';
      const a = st.answers[qi];
      const isAnswered =
        qType === 'integer' ? (a !== '' && a !== null && a !== undefined && !isNaN(Number(a))) :
        qType === 'matrix'  ? (Array.isArray(a) && a.filter(x => x !== undefined && x !== '').length >= (q.matrixRows || []).length) :
                              (Array.isArray(a) ? a.length > 0 : (a >= 0));

      qHtml += `<div class="quiz-play-card ${isAnswered ? 'answered' : ''}">
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
    bodyHtml = `<div class="quiz-exam-body-inner">${qHtml}</div>`;
  } else {
    const { score, total, percent, results, attempts, marksEarned, marksPossible } = st.response;
    const isPerfect = score === total;
    const isPass = percent >= 60;
    const emoji = isPerfect ? '🏆' : isPass ? '🎉' : '📚';
    const headline = isPerfect ? 'Perfect Score!' : isPass ? 'Well done!' : 'Keep practicing!';

    let rHtml = `<div class="quiz-result-hero ${isPass ? 'pass' : 'fail'}">
      <div class="quiz-result-emoji">${emoji}</div>
      <div class="quiz-result-score">${score} / ${total}</div>
      <div class="quiz-result-pct">${percent}%${marksPossible ? ` · ${marksEarned} / ${marksPossible} marks` : ''}</div>
      <div class="quiz-result-headline">${headline}</div>
      <div style="font-size:12px;color:var(--text-tertiary);margin-top:6px;">Attempt #${attempts}</div>
    </div>`;

    st.quiz.forEach((q, qi) => {
      const r = results[qi];
      const ok = r.correct;
      rHtml += `<div class="quiz-result-item ${ok ? 'ok' : 'bad'}">
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
    bodyHtml = `<div class="quiz-exam-body-inner">${rHtml}</div>`;
  }

  let footerHtml;
  if (st.previewMode) {
    footerHtml = `
      <footer class="quiz-exam-footer">
        <div class="quiz-exam-footer-left">
          <span class="quiz-exam-warning-note"
                style="background:rgba(99,102,241,.1);color:var(--brand-600);border-color:rgba(99,102,241,.25);">
            <i class="fas fa-eye"></i> Preview mode — no proctoring, no submission.
          </span>
        </div>
        <button type="button" class="btn btn-primary" onclick="exitQuizSession()">
          <i class="fas fa-times"></i> Close Preview
        </button>
      </footer>`;
  } else if (!st.submitted) {
    footerHtml = `
      <footer class="quiz-exam-footer">
        <div class="quiz-exam-footer-left">
          <button type="button" class="btn btn-outline" onclick="requestQuitExam()">
            <i class="fas fa-times"></i> Quit Exam
          </button>
          <span class="quiz-exam-warning-note">
            <i class="fas fa-shield-halved"></i> Do not switch tabs or leave full-screen.
          </span>
        </div>
        <button type="button" class="btn btn-primary btn-lg" onclick="submitQuiz()">
          <i class="fas fa-paper-plane"></i> Submit Test
        </button>
      </footer>`;
  } else {
    footerHtml = `
      <footer class="quiz-exam-footer">
        <div class="quiz-exam-footer-left"></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button type="button" class="btn btn-outline" onclick="retakeQuiz()">
            <i class="fas fa-redo"></i> Retake
          </button>
          <button type="button" class="btn btn-primary" onclick="exitQuizSession()">
            <i class="fas fa-check"></i> Done
          </button>
        </div>
      </footer>`;
  }

  shell.innerHTML = headerHtml + `<div class="quiz-exam-body">${bodyHtml}</div>` + footerHtml;
  renderMathIn(shell.querySelector('.quiz-exam-body'));
}

/* ============================================================
   PROCTORING — Event handlers
   ============================================================ */
function _onExamVisibilityChange() {
  if (!quizPlayerState || !quizPlayerState.examStarted || quizPlayerState.submitted) return;
  if (document.hidden) _handleExamViolation('You left the exam tab.');
}

function _onExamWindowBlur() {
  if (!quizPlayerState || !quizPlayerState.examStarted || quizPlayerState.submitted) return;
  if (document.querySelector('.modal-overlay.active')) return;
  if (window.__examAllowBlur) return;   // ⭐ ADD: file picker grace period
  _handleExamViolation('The exam window lost focus.');
}

function _onExamFullscreenChange() {
  if (!quizPlayerState || !quizPlayerState.examStarted || quizPlayerState.submitted) return;
  if (!quizPlayerState.fullscreenArmed) return;
  const stillFs = document.fullscreenElement || document.webkitFullscreenElement;
  if (!stillFs) _handleExamViolation('You exited full-screen mode.');
}

function _onExamBeforeUnload(e) {
  if (!quizPlayerState || !quizPlayerState.examStarted || quizPlayerState.submitted) return;
  persistQuizAnswers();
  e.preventDefault();
  e.returnValue = '';
  return '';
}

function _handleExamViolation(reason) {
  const st = quizPlayerState;
  if (!st || st.submitted || st.violationHandling) return;

  st.violationHandling = true;
  st.strikes = (st.strikes || 0) + 1;
  st.violations.push({ reason, at: Date.now() });

  if (st.strikes > QUIZ_PROCTOR_MAX_STRIKES) {
    _autoSubmitForViolation(reason);
  } else {
    _showViolationWarning(reason, st.strikes);
  }

  setTimeout(() => { if (quizPlayerState) quizPlayerState.violationHandling = false; }, 1500);
}

function _resetViolationModalButtons() {
  const resumeBtn = document.getElementById('quizViolationResumeBtn');
  if (resumeBtn) {
    resumeBtn.textContent = 'Resume Exam';
    resumeBtn.className = 'btn btn-primary btn-block';
    resumeBtn.setAttribute('onclick', 'resumeExamAfterViolation()');
  }
}

function _showViolationWarning(reason, strikeNumber) {
  const text = document.getElementById('quizViolationText');
  const box  = document.getElementById('quizViolationBox');

  if (text) {
    text.textContent =
      `${reason} This is your final warning — one more violation will instantly auto-submit your exam.`;
  }
  if (box) {
    box.innerHTML = `
      <div class="violation-warning-row">
        <span class="violation-warning-label">Strike</span>
        <span class="violation-warning-value">${strikeNumber} of ${QUIZ_PROCTOR_MAX_STRIKES}</span>
      </div>
      <div class="violation-warning-row">
        <span class="violation-warning-label">Rule</span>
        <span class="violation-warning-value">Do not switch tabs or windows during the exam.</span>
      </div>`;
  }
  _resetViolationModalButtons();
  persistQuizAnswers();
  openModal('quizViolationModal');
}

function resumeExamAfterViolation() {
  closeModal('quizViolationModal');
  try {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      const el = document.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) { const p = req.call(el); if (p && p.catch) p.catch(() => {}); }
    }
  } catch (e) {}
}

async function _autoSubmitForViolation(reason) {
  const st = quizPlayerState;
  if (!st) return;
  st.autoSubmitted = true;
  showToast('⚠️ Auto-submitting due to proctoring violation…', 'error');
  await new Promise(r => setTimeout(r, 400));
  await submitQuiz({ auto: true });
}

function requestQuitExam() {
  const st = quizPlayerState;
  if (!st) return;

  st.examStarted = false;
  const ok = confirm(
    'Quit the exam?\n\n' +
    'Your answers will be saved locally, but no score will be recorded.'
  );
  if (ok) {
    persistQuizAnswers();
    exitQuizSession();
    return;
  }
  try {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      const el = document.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) { const p = req.call(el); if (p && p.catch) p.catch(() => {}); }
    }
  } catch (e) {}
  setTimeout(() => { if (quizPlayerState) quizPlayerState.examStarted = true; }, 1000);
}

/* ============================================================
   ANTI-CHEAT — Input restrictions
   ============================================================ */
function _inExam() {
  return quizPlayerState && quizPlayerState.examStarted && !quizPlayerState.submitted;
}
function _blockContextMenu(e) {
  if (!_inExam()) return;
  e.preventDefault();
  return false;
}
function _blockCopy(e) {
  if (!_inExam()) return;
  if (e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
  e.preventDefault();
  return false;
}
function _blockSelectStart(e) {
  if (!_inExam()) return;
  if (e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
  e.preventDefault();
  return false;
}
function _blockDrag(e) {
  if (!_inExam()) return;
  e.preventDefault();
}
function _blockDevKeys(e) {
  if (!_inExam()) return;

  if (e.key === 'F12') { e.preventDefault(); e.stopPropagation(); return false; }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey &&
      ['I','J','C','i','j','c'].includes(e.key)) {
    e.preventDefault(); e.stopPropagation(); return false;
  }
  if ((e.ctrlKey || e.metaKey) && ['u','U','s','S','p','P'].includes(e.key)) {
    e.preventDefault(); e.stopPropagation(); return false;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault(); e.stopPropagation(); return false;
  }
  if ((e.ctrlKey || e.metaKey) && ['a','c','v','x','A','C','V','X'].includes(e.key)) {
    if (e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
    e.preventDefault(); e.stopPropagation(); return false;
  }
}

/* ============================================================
   SUBMIT / EXIT / RETAKE
   ============================================================ */
async function submitQuiz(opts = {}) {
  const st = quizPlayerState; if (!st) return;
  if (st.previewMode) return showToast('Preview mode — nothing submitted.', 'info');
  if (st.submitted) return;

  const auto = !!opts.auto;

  if (!auto) {
    for (let i = 0; i < st.quiz.length; i++) {
      const q = st.quiz[i];
      const a = st.answers[i];
      if (q.type === 'integer' || q.type === 'numerical') {
        if (a === '' || a === null || a === undefined || isNaN(Number(a))) {
          return showToast(`Please answer Q${i + 1}.`, 'error');
        }
      } else if (q.type === 'subjective') {
        if (!Array.isArray(a) || a.length === 0) {
          return showToast(`Please upload at least one photo for Q${i + 1}.`, 'error');
        }
        if (a.some(u => u && u.uploading)) {
          return showToast(`Please wait for Q${i + 1} uploads to finish.`, 'error');
        }
        if (a.some(u => !u || !u.url)) {
          return showToast(`Q${i + 1}: some photos failed to upload. Remove and retry.`, 'error');
        }
      } else if (q.type === 'matrix') {
        const rows = q.matrixRows || [];
        if (!Array.isArray(a) || a.filter(x => x !== undefined && x !== '').length < rows.length) {
          return showToast(`Please match all items in Q${i + 1}.`, 'error');
        }
      } else {
        if (Array.isArray(a) ? a.length === 0 : (a === null || a === undefined || a === -1)) {
          return showToast(`Please answer Q${i + 1}.`, 'error');
        }
      }
    }
  }

  st.examStarted = false;

  try {
    const res = await fetch(
      `/api/user/quiz/${st.courseId}/${st.materialId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser._id, answers: st.answers })
      }
    );
    const data = await res.json();
    if (data.success) {
      st.submitted = true;
      st.response = data;

      // ⭐ XP + level-up feedback
      if (data.xpResult && data.xpResult.gained > 0) {
        showToast(`+${data.xpResult.gained} XP · ${data.xpResult.reason}`, 'success');
      }
      if (data.xpResult && data.xpResult.leveledUp) {
        setTimeout(() => {
          showToast(`🎉 Level ${data.xpResult.level} — ${data.xpResult.levelName}!`, 'success');
        }, 1200);
      }

      stopQuizTimer();
      clearQuizAnswers(st.materialId);
      try { localStorage.removeItem('aero_quiz_start_' + st.materialId); } catch (e) {}
      try { clearSavedQuizDraft(st.materialId); } catch (e) {}

      if (!currentUser.quizResults) currentUser.quizResults = {};
      currentUser.quizResults[st.materialId] = {
        score: data.score, total: data.total, percent: data.percent,
        marksEarned: data.marksEarned, marksPossible: data.marksPossible,
        attempts: data.attempts, lastAttemptAt: new Date().toISOString()
      };
      saveSessionUser(currentUser);
      _analyticsCacheAt = 0;

      _detachAllProctorListeners();
      exitFullscreenNow();

      renderQuizExamShell();

      if (auto) {
        showToast('⚠️ Exam auto-submitted due to proctoring violation.', 'error');
      } else {
        const pct = data.percent;
        if (pct === 100)     showToast('🏆 Perfect!', 'success');
        else if (pct >= 60)  showToast(`🎉 Scored ${data.score}/${data.total}!`, 'success');
        else                 showToast(`📚 Scored ${data.score}/${data.total}.`, 'info');
      }
    } else {
      st.examStarted = true;
      showToast(data.message || 'Failed.', 'error');
    }
  } catch {
    st.examStarted = true;
    showToast('Server error.', 'error');
  }
}

function exitFullscreenNow() {
  try {
    if (document.fullscreenElement && document.exitFullscreen) {
      const p = document.exitFullscreen();
      if (p && p.catch) p.catch(() => {});
    } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  } catch (e) {}
}

function exitQuizSession() {
  const st = quizPlayerState;
  const returnCourseId = st ? st.courseId : null;
  const wasPreview = st ? st.previewMode : false;

  _detachAllProctorListeners();
  exitFullscreenNow();
  stopQuizTimer();

  const shell = document.getElementById('quizExamShell');
  if (shell) {
    shell.style.display = 'none';
    shell.innerHTML = '';
    shell.setAttribute('aria-hidden', 'true');
  }
  document.body.style.overflow = '';
  quizPlayerState = null;

  if (!wasPreview && returnCourseId && currentUser && currentUser.role === 'student') {
    try { renderCourseDetail(returnCourseId); } catch (e) {}
  }
}

function retakeQuiz() {
  const st = quizPlayerState;
  if (!st) return;
  const courseId = st.courseId;
  const materialId = st.materialId;
  clearQuizAnswers(materialId);
  try { localStorage.removeItem('aero_quiz_start_' + materialId); } catch (e) {}
  exitQuizSession();
  openQuizPlayer(courseId, materialId);
}
/* ============================================================
   Quiz exam — targeted DOM updates (avoid full re-render)
   ============================================================ */
function _isQuestionAnswered(q, a) {
  const qType = q.type || 'single';
  if (qType === 'integer' || qType === 'numerical') {
    return a !== '' && a !== null && a !== undefined && !isNaN(Number(a));
  }
  if (qType === 'subjective') {
    // Answered if at least one photo uploaded AND no upload still in progress
    if (!Array.isArray(a) || a.length === 0) return false;
    return a.every(u => u && u.url && !u.uploading);
  }
  if (qType === 'matrix') {
    const rows = q.matrixRows || [];
    return Array.isArray(a) && a.filter(x => x !== undefined && x !== '').length >= rows.length;
  }
  return Array.isArray(a) ? a.length > 0 : (a >= 0);
}

function updateQuizProgressUI() {
  const st = quizPlayerState;
  if (!st) return;
  const answered = st.quiz.reduce((s, q, i) => s + (_isQuestionAnswered(q, st.answers[i]) ? 1 : 0), 0);

  const textEl = document.querySelector('.quiz-exam-progress-text');
  if (textEl) textEl.innerHTML = `<strong>${answered}</strong> / ${st.quiz.length} answered`;

  const fillEl = document.querySelector('.quiz-exam-progress-fill');
  if (fillEl) {
    fillEl.style.width = st.quiz.length > 0
      ? ((answered / st.quiz.length) * 100) + '%'
      : '0%';
  }
}

function updateQuizQuestionCard(qi) {
  const st = quizPlayerState;
  if (!st) return;
  const cards = document.querySelectorAll('.quiz-exam-body-inner .quiz-play-card');
  const card = cards[qi];
  if (!card) return;

  const q = st.quiz[qi];
  const a = st.answers[qi];
  const qType = q.type || 'single';
  const isAnswered = _isQuestionAnswered(q, a);

  card.classList.toggle('answered', isAnswered);

  const qnum = card.querySelector('.quiz-play-qnum');
  if (qnum) {
    const existingTag = qnum.querySelector('.quiz-answered-tag');
    if (isAnswered && !existingTag) {
      const span = document.createElement('span');
      span.className = 'quiz-answered-tag';
      span.innerHTML = '<i class="fas fa-check-circle"></i> Answered';
      qnum.appendChild(span);
    } else if (!isAnswered && existingTag) {
      existingTag.remove();
    }
  }

  if (qType === 'single' || qType === 'multiple') {
    const opts = card.querySelectorAll('.quiz-play-option');
    opts.forEach((opt, oi) => {
      const selected = qType === 'single'
        ? (a === oi || (Array.isArray(a) && a[0] === oi))
        : (Array.isArray(a) && a.includes(oi));
      opt.classList.toggle('selected', selected);
      const input = opt.querySelector('input');
      if (input) input.checked = selected;
    });
  }
}

/* ============================================================
   ANSWER INTERACTION
   ============================================================ */
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

  if (qType === 'numerical') {                                       // ⭐ NEW
    return `<div class="form-group" style="margin-top:8px;">
      <label>Your Answer <span class="hint" style="display:inline;">(any value inside the accepted range counts as correct)</span></label>
      <input type="number" step="any" placeholder="Enter a numeric value"
             value="${ans === '' ? '' : (ans ?? '')}"
             oninput="selectQuizAnswerInteger(${qi}, this.value)">
    </div>`;
  }

  if (qType === 'subjective') {                                      // ⭐ NEW
    const uploads = Array.isArray(ans) ? ans : [];
    const maxM = q.subjectiveMaxMarks || 10;
    const instr = q.subjectiveInstructions || '';
    return `
      <div class="subjective-answer-block">
        ${instr ? `<div class="subjective-instructions"><i class="fas fa-info-circle"></i> ${escapeHtml(instr)}</div>` : ''}
        <div class="subjective-meta-row">
          <span class="subjective-max-badge"><i class="fas fa-star"></i> ${maxM} marks · Admin evaluated</span>
        </div>
        <label class="subjective-upload-btn">
          <input type="file" accept="image/*" multiple style="display:none;"
                 onmousedown="window.__examAllowBlur = true;"
                 onfocus="window.__examAllowBlur = true;"
                 onchange="handleSubjectiveUpload(${qi}, this);">
          <i class="fas fa-camera"></i> Choose Photos of Your Solution
        </label>
        <div class="subjective-uploads" id="subjectiveUploads-${qi}">
          ${uploads.map((u, idx) => renderSubjectiveUpload(u, qi, idx)).join('')}
        </div>
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

  if (qType === 'numerical') {                                       // ⭐ NEW
    const min = r.rangeMin;
    const max = r.rangeMax;
    const chosen = r.chosen;
    const hasAns = chosen !== '' && chosen !== null && chosen !== undefined && !isNaN(Number(chosen));
    return `
      <div class="quiz-answer-row"><span class="quiz-answer-label">Your answer:</span>
        <span class="${r.correct ? 'ok-text' : (hasAns ? 'bad-text' : '')}">
          ${hasAns ? chosen : '—'}
        </span>
      </div>
      <div class="quiz-answer-row"><span class="quiz-answer-label">Accepted range:</span>
        <span class="ok-text">${min} – ${max}</span>
      </div>
    `;
  }

  if (qType === 'subjective') {                                      // ⭐ NEW
    const uploads = Array.isArray(r.chosen) ? r.chosen : [];
    const evals   = quizPlayerState?.response?.subjectiveEvaluations || {};
    const ev      = evals[String(quizPlayerState ? quizPlayerState.quiz.indexOf(q) : -1)] || null;
    return `
      <div class="quiz-answer-row">
        <span class="quiz-answer-label">Your uploaded solution(s):</span>
        <span>${uploads.length} photo${uploads.length === 1 ? '' : 's'}</span>
      </div>
      ${uploads.length > 0 ? `
        <div class="subjective-result-thumbs">
          ${uploads.map(u => `<a href="${escapeHtml(u.url)}" target="_blank" rel="noopener">
            <img src="${escapeHtml(u.url)}" alt="answer" loading="lazy">
          </a>`).join('')}
        </div>` : '<div class="quiz-answer-row"><em>No photos uploaded.</em></div>'}
      <div class="quiz-answer-row subjective-pending-note">
        <i class="fas fa-hourglass-half"></i>
        <span>${ev ? `Marks awarded: <strong>${ev.awardedMarks} / ${r.maxMarks}</strong>${ev.feedback ? ' — ' + escapeHtml(ev.feedback) : ''}` : 'Pending admin evaluation'}</span>
      </div>
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
  updateQuizQuestionCard(qi);
  updateQuizProgressUI();
}
function selectQuizAnswerInteger(qi, val) {
  const st = quizPlayerState; if (!st || st.submitted) return;
  st.answers[qi] = val;
  persistQuizAnswers();
  updateQuizQuestionCard(qi);
  updateQuizProgressUI();
}
function selectQuizAnswerMatrix(qi, li, val) {
  const st = quizPlayerState; if (!st || st.submitted) return;
  let arr = Array.isArray(st.answers[qi]) ? st.answers[qi].slice() : [];
  if (val === '') delete arr[li]; else arr[li] = parseInt(val, 10);
  st.answers[qi] = arr;
  persistQuizAnswers();
  updateQuizQuestionCard(qi);
  updateQuizProgressUI();
}
function selectQuizAnswer(qi, oi) { selectQuizAnswerMulti(qi, oi, true, 'single'); }

/* ============================================================
   PREVIEW (admin) — same shell, no proctoring
   ============================================================ */

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
    paperConfig: { ...quizPaperConfig },
    previewMode: true,
    examStarted: false,
    strikes: 0,
    violations: [],
    startTime: null,
    violationHandling: false,
    fullscreenArmed: true
  };

  const shell = document.getElementById('quizExamShell');
  if (!shell) return;
  shell.style.display = 'flex';
  shell.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  renderQuizExamShell();
}

/* ============================================================
   Shared guard — throws if this material is premium and locked.
   Called FIRST in every open-* function. No network calls are
   made until this returns true.
   ============================================================ */
function assertMaterialUnlocked(courseId, materialId, opts) {
  opts = opts || {};
  if (!currentUser) {
    if (!opts.silent) showToast('Please log in to open this material.', 'error');
    return false;
  }
  if (isAdmin(currentUser)) return true;

  const course = findCourse(courseId);
  if (!course) { if (!opts.silent) showToast('Course not found.', 'error'); return false; }

  const mat = (course.materials || []).find(m => m.id === materialId);
  if (!mat) { if (!opts.silent) showToast('Material not found.', 'error'); return false; }

  const isCoursePremium = course.isPremium === true || course.isPremium === 'true';
  const isMatPremium    = mat.isPremium    === true || mat.isPremium    === 'true';

  const purchases    = Array.isArray(currentUser.purchases) ? currentUser.purchases : [];
  const ownsCourse   = purchases.includes(String(course.id));
  const ownsMaterial = purchases.includes(String(mat.id));
  const subscribed   = !!currentUser.isSubscribed;

  if (subscribed || ownsCourse || ownsMaterial) return true;

  if (isCoursePremium || isMatPremium) {
    if (!opts.silent) {
      showToast('This content is locked. Purchase it or subscribe to unlock.', 'error');
    }
    return false;
  }
  return true;
}

/* ============================================================
   viewFileOnline — PREMIUM + PREVIEW GATED + AUTH-TOKEN-AWARE
   ------------------------------------------------------------
   Behaviour:
     • Full access   → viewer opens with all pages.
     • Preview mode  → viewer opens with only previewPercent% pages
                       and a paywall card appended at the end.
     • Fully locked  → toast + abort (no network call).
   ============================================================ */
async function viewFileOnline(courseId, materialId) {
  const course = findCourse(courseId);
  if (!course) return showToast('Course not found.', 'error');

  const mat = (course.materials || []).find(m => m.id === materialId);
  if (!mat) return showToast('Material not found.', 'info');

  if (!currentUser) {
    return showToast('Please log in to open this material.', 'error');
  }

  /* ① Preview-aware gate — no network call before this passes */
  const access = getMaterialAccessInfo(course, mat);
  if (!access.hasFullAccess && !access.canPreview) {
    if (access.isCoursePremium) {
      return showToast('Purchase the course to access this material.', 'error');
    }
    return showToast('This content is locked. Purchase it to unlock.', 'error');
  }

  try { await window.loadPDFJS(); }
  catch { return showToast('Could not load PDF viewer.', 'error'); }

  /* Viewer options — the viewer decides how many pages to render */
  const viewerOpts = {
    materialId:     mat.id,
    courseId:       course.id,
    fileName:       mat.fileName,
    title:          mat.title,
    username:       currentUser.fullName || currentUser.username || 'Student',
    hasFullAccess:  access.hasFullAccess,   // ⭐ NEW
    previewPercent: access.previewPercent   // ⭐ NEW (0 when full access)
  };

  /* ② Server re-verify — authoritative source of truth */
  try {
    const check = await fetchJSON(
      `${API_BASE}/courses/${courseId}/materials/${materialId}/file?_t=${Date.now()}`
    );

    if (check && check.success === false &&
        (check.code === 'course-premium' || check.code === 'material-premium')) {
      return showToast(check.message || 'This content is locked.', 'error');
    }

    if (check && check.success && check.fileData) {
      // Trust the server's verdict over the client cache
      viewerOpts.hasFullAccess  = check.hasFullAccess === true;
      viewerOpts.previewPercent = check.previewPercent || 0;

      const fd = check.fileData;
      const isPdfInline =
        String(fd).startsWith('data:application/pdf') ||
        (mat.fileName || '').toLowerCase().endsWith('.pdf');

      if (isPdfInline) {
        if (fd.startsWith('data:')) {
          viewerOpts.data = fd;
        } else {
          viewerOpts.url = withAuthToken(fd);
        }
        window.PDFViewer.open(viewerOpts);
        return;
      }
    }
  } catch (e) {
    if (/locked|premium|subscription|purchase/i.test(e.message || '')) {
      return showToast(e.message, 'error');
    }
    console.warn('[viewFileOnline] file-check failed:', e.message);
  }

  /* ③ Legacy URL path (disk / Cloudinary) */
  let fileUrl = null;
  if (mat.url && (mat.url.startsWith('/uploads/') || /^https?:/i.test(mat.url))) {
    fileUrl = mat.url;
  }

  if (fileUrl) {
    const cleanUrl = fileUrl.toLowerCase().split('?')[0].split('#')[0];
    const isPdfUrl = cleanUrl.endsWith('.pdf')
                  || (mat.fileName || '').toLowerCase().endsWith('.pdf');

    if (isPdfUrl) {
      viewerOpts.url = fileUrl.startsWith('/uploads/')
        ? withAuthToken(fileUrl)
        : fileUrl;
      window.PDFViewer.open(viewerOpts);
    } else {
      showToast('Preview is only available for PDFs.', 'error');
    }
    return;
  }

  showToast('No file attached.', 'info');
}

/* ============================================================
   openMaterialVideo — PREMIUM GATED
   ============================================================ */
async function openMaterialVideo(courseId, materialId) {
  /* ① HARD GATE — before any network call */
  if (!assertMaterialUnlocked(courseId, materialId)) return;

  const course = findCourse(courseId);
  if (!course) return;
  const mat = (course.materials || []).find(m => m.id === materialId);
  if (!mat || !mat.url) return showToast('No video URL set for this material.', 'error');

  try {
    const res = await fetch(
      `/api/materials/${courseId}/${materialId}/video-session`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser._id })
      }
    );
    const data = await res.json();

    /* ② Server refused → stop right here, do NOT fall through */
    if (!data.success) {
      return showToast(data.message || 'Could not load video.', 'error');
    }

    const baseOpts = {
      materialId: mat.id,
      courseId: course.id,
      title: mat.title,
      username: currentUser.fullName || currentUser.username || 'Student'
    };

    if (data.kind === 'youtube' && data.videoId) {
      window.VideoPlayer.open({ ...baseOpts, videoId: data.videoId });
    } else if (data.kind === 'direct' && data.directUrl) {
      window.VideoPlayer.open({ ...baseOpts, src: withAuthToken(data.directUrl) });
    } else {
      showToast('Unsupported video response from server.', 'error');
    }
  } catch (e) {
    showToast('Server error loading video.', 'error');
  }
}

async function toggleBookmark(e, courseId) {
  if (e) e.stopPropagation();
  if (!currentUser?._id) return;
  try {
    const res = await fetch(`/api/user/bookmarks/${courseId}`, {
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
    const res = await fetch(`/api/user/progress/${courseId}/${materialId}`, {
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
  const userIdAtStart = currentUser._id;
  try {
    const res = await fetch(`/api/user/me/${userIdAtStart}`);
    const data = await res.json();
    // Guard: don't overwrite state if session was killed while we were fetching
    if (data.success && currentUser && currentUser._id === userIdAtStart && !_sessionKilled) {
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
    const response = await fetch('/api/courses', {
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
    const response = await fetch(`/api/courses/${courseId}`, { method: 'DELETE' });
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
    const res = await fetch(`/api/courses/${courseId}`, {
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
  const photoInput = $('newProfPhotoInput');
  const photoFile = photoInput && photoInput.files ? photoInput.files[0] : null;

  if (photoFile) {
    if (photoFile.size > 5 * 1024 * 1024) return showToast('Photo too large (max 5 MB).', 'error');
    try {
      showToast('Uploading photo…', 'info');
      const result = await uploadFileToServer(photoFile);
      await processSave(result.url);
    } catch (err) {
      showToast('Upload failed: ' + err.message, 'error');
    }
  } else {
    processSave(null);
  }
 
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
      const response = await fetch(`/api/courses/${courseId}/materials`, {
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
    const response = await fetch(`/api/courses/${courseId}/doubts`, {
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
    const res = await fetch(`/api/courses/${courseId}/doubts/${doubtId}/replies`, {
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
    const res = await fetch(`/api/courses/${courseId}/doubts/${doubtId}/replies/${replyId}/accept`, {
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
/* ============================================================
   PAYMENT MODAL — SECURE + ROBUST
   ============================================================ */
async function showPaymentModal(courseId, materialId = null) {
  if (!currentUser) {
    return showToast('Please log in first.', 'error');
  }
  if (String(currentUser.role || '').toLowerCase() === 'admin') {
    return showToast('Admins cannot make purchases.', 'info');
  }

  const course = findCourse(courseId);
  if (!course) return showToast('Course not found.', 'error');

  let amount = 0;
  let itemName = course.name;
  let purchaseId = course.id;

  if (materialId) {
    const mat = (course.materials || []).find(m => m.id === materialId);
    if (!mat) return showToast('Material not found.', 'error');
    amount     = Number(mat.price) || 0;
    itemName   = mat.title;
    purchaseId = mat.id;
  } else {
    amount = Number(course.price) || 0;
  }

  if (Array.isArray(currentUser.purchases) && currentUser.purchases.includes(purchaseId)) {
    return showToast('You already own this item.', 'info');
  }
  if (currentUser.isSubscribed) {
    return showToast('Your subscription already unlocks this content.', 'success');
  }
  if (amount <= 0) {
    return showToast('This item does not require payment.', 'info');
  }

  showToast(`Preparing checkout for ₹${amount}…`, 'info');

  try {
    await window.loadRazorpay();
  } catch (e) {
    console.error('[payment] Razorpay SDK failed to load', e);
    return showToast('Could not load payment gateway. Check your connection.', 'error');
  }

  let orderData;
  try {
    orderData = await fetchJSON('/api/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount:  amount,
        userId:  currentUser._id,
        itemId:  purchaseId
      })
    });
  } catch (err) {
    console.error('[payment] create-order failed', err);
    return showToast(err.message || 'Could not start payment.', 'error');
  }

  if (!orderData || !orderData.success || !orderData.order) {
    return showToast((orderData && orderData.message) || 'Could not create order.', 'error');
  }

  const options = {
    key:         orderData.key_id,
    amount:      orderData.order.amount,
    currency:    orderData.order.currency || 'INR',
    name:        'AeroGyan Education',
    description: `Purchase: ${itemName}`,
    order_id:    orderData.order.id,
    prefill: {
      name:    currentUser.fullName || currentUser.username || '',
      email:   currentUser.email    || '',
      contact: currentUser.phone    || ''
    },
    theme: { color: '#4f46e5' },

    handler: async function (response) {
      showToast('Verifying payment…', 'info');

      try {
        const verifyData = await fetchJSON('/api/verify-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            razorpay_order_id:   response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature:  response.razorpay_signature,
            courseId: purchaseId,
            userId:   currentUser._id
          })
        });

        if (verifyData && verifyData.success) {
          if (!Array.isArray(currentUser.purchases)) currentUser.purchases = [];
          if (!currentUser.purchases.includes(purchaseId)) {
            currentUser.purchases.push(purchaseId);
          }
          saveSessionUser(currentUser);

          showToast('🎉 Payment successful! Content unlocked.', 'success');
          renderApp();
        } else {
          showToast((verifyData && verifyData.message) || 'Payment verification failed.', 'error');
        }
      } catch (err) {
        console.error('[payment] verify failed', err);
        showToast(
          'Payment succeeded but verification failed. Please contact support with your payment ID: ' +
          response.razorpay_payment_id,
          'error'
        );
      }
    },

    modal: {
      ondismiss: function () {
        showToast('Payment cancelled.', 'info');
      }
    }
  };

  try {
    const rzp = new Razorpay(options);

    rzp.on('payment.failed', function (response) {
      console.error('[razorpay] payment.failed', response.error);
      const desc = (response.error && response.error.description) || 'Payment was declined.';
      showToast('❌ ' + desc, 'error');
    });

    rzp.open();
  } catch (e) {
    console.error('[payment] Razorpay open failed', e);
    showToast('Could not open payment window.', 'error');
  }
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
  // MathJax preload now happens once at the top of app.js
  // (see preloadMathJaxOnce IIFE). Nothing to do here.

  const savedUser = loadSessionUser();
  if (savedUser) {
    // ── Guard: a valid session needs BOTH a user AND a token ──
    // If a previous session left the user behind but the token is
    // gone, every /api/ call would silently 401. Catch it here and
    // clear the partial session so the login view shows cleanly.
    let token = null;
    try { token = sessionStorage.getItem('aero_token'); } catch (e) {}

    if (!token) {
      console.warn('[initApp] User present but no auth token — clearing partial session.');
      clearSession();
      currentUser = null;
      try { sessionStorage.removeItem('aero_user'); } catch (e) {}
    } else {
      currentUser = savedUser;
      if (currentUser.role === 'admin') adminTab = 'overview';
      _sessionKilled = false;
      startSessionHeartbeat();
    }
  }
  updateThemeIcon();
  syncHashToState();

  /* ---- Make sure the AI home section exists before first paint ---- */
  if (currentUser && String(currentUser.role || '').toLowerCase() === 'student') {
    try { ensureStudentAIHomeView(); } catch (e) {}
  }

  /* ---- Single first paint ---- */
  renderApp();

  /* ---- Kick off critical fetches in parallel ---- */
  const criticalFetches = [
    fetchCoursesFromDB(),
    fetchProfessorsFromDB(),
    fetchSubscriptionSettings(),
    fetchOwnerProfile()
  ];

  if (savedUser && savedUser._id) {
    // user-scoped data — fire and forget, no need to block paint
    setTimeout(() => {
      refreshUserData().catch(() => {});
      loadNotifications().catch(() => {});
    }, 400);
  }

  // Await and log failures only (renderApp already scheduled above)
  const results = await Promise.allSettled(criticalFetches);
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.warn('[initApp] fetch #' + i + ' failed:', r.reason);
  });

  // One more paint after data lands
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

  // Lazy-load Chart.js only when analytics tab opens
  try { await window.loadChartJS(); }
  catch { console.warn('[analytics] Chart.js failed to load — charts skipped.'); }

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
        `/api/user/analytics/${currentUser._id}?t=${now}`
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

document.addEventListener('click', (e) => {
  if (e.target.closest('#themeToggle')) {
    _analyticsCacheAt = 0;
  }
});

// Listen for both hash changes and browser back/forward buttons
window.addEventListener('hashchange', () => { syncHashToState(); renderApp(); });
window.addEventListener('popstate', () => { syncHashToState(); renderApp(); });
// Auto-switch role based on username input.
// Only AUTO-UPGRADE to Admin (e.g. when the username contains "admin").
// Never auto-downgrade — the user may have deliberately clicked the Admin
// tab, and many admin usernames aren't literally the word "admin".
document.getElementById('loginUsername')?.addEventListener('input', (e) => {
  const val = e.target.value.trim().toLowerCase();
  if (/admin/i.test(val) && loginRole !== 'admin') {
    setLoginRole('admin');
  }
});
/* ============================================================
/* ---------- Student: Alumni section (cached) ---------- */
async function renderAlumniSection() {
  const section = document.getElementById('alumniSection');
  const grid    = document.getElementById('alumniGrid');
  if (!section || !grid) return;

  let list = _alumniCache.data;
  if (!list || Date.now() - _alumniCache.at > COMMUNITY_CACHE_MS) {
    try {
      const res = await fetch(`${API_BASE}/alumni?_t=${Date.now()}`, { cache: 'no-store' });
      const data = await res.json();
      list = (data && data.success && Array.isArray(data.alumni)) ? data.alumni : [];
      _alumniCache = { data: list, at: Date.now() };
    } catch (e) {
      console.warn('[alumni] fetch failed:', e);
      list = _alumniCache.data || [];
    }
  }

  if (!list || list.length === 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  let html = '';
  list.forEach(a => {
    const avatar = a.photo
      ? `<img src="${escapeHtml(a.photo)}" alt="${escapeHtml(a.name)}" class="alumni-avatar-img" loading="lazy">`
      : `<div class="alumni-avatar-fallback">${escapeHtml(getInitials(a.name))}</div>`;

    const metaParts = [];
    if (a.batch)    metaParts.push(`<i class="fas fa-calendar-alt"></i> ${escapeHtml(a.batch)}`);
    if (a.degree)   metaParts.push(`<i class="fas fa-book"></i> ${escapeHtml(a.degree)}`);
    if (a.location) metaParts.push(`<i class="fas fa-map-marker-alt"></i> ${escapeHtml(a.location)}`);

    const workParts = [];
    if (a.currentRole) workParts.push(escapeHtml(a.currentRole));
    if (a.company)     workParts.push(`@ ${escapeHtml(a.company)}`);

    const contactBtns = [];
    if (a.linkedin) {
      contactBtns.push(`<a href="${escapeHtml(a.linkedin)}" target="_blank" rel="noopener noreferrer" class="contact-chip contact-chip-email" style="text-decoration:none;"><i class="fab fa-linkedin"></i> LinkedIn</a>`);
    }

    html += `
      <div class="alumni-card">
        <div class="alumni-avatar">${avatar}</div>
        <div class="alumni-body">
          <h3>${escapeHtml(a.name)}</h3>
          ${workParts.length ? `<div class="alumni-work">${workParts.join(' ')}</div>` : ''}
          ${metaParts.length ? `<div class="alumni-meta">${metaParts.join(' · ')}</div>` : ''}
          ${a.bio ? `<p class="alumni-bio">${escapeHtml(a.bio)}</p>` : ''}
          ${contactBtns.length ? `<div class="alumni-contact">${contactBtns.join('')}</div>` : ''}
        </div>
      </div>`;
  });
  grid.innerHTML = html;
}

/* ---------- Student: Friends section (cached) ---------- */
async function renderFriendsSection() {
  const section = document.getElementById('friendsSection');
  const grid    = document.getElementById('friendsGrid');
  if (!section || !grid) return;

  let list = _friendsCache.data;
  if (!list || Date.now() - _friendsCache.at > COMMUNITY_CACHE_MS) {
    try {
      const res = await fetch(`${API_BASE}/friends?_t=${Date.now()}`, { cache: 'no-store' });
      const data = await res.json();
      list = (data && data.success && Array.isArray(data.friends)) ? data.friends : [];
      _friendsCache = { data: list, at: Date.now() };
    } catch (e) {
      console.warn('[friends] fetch failed:', e);
      list = _friendsCache.data || [];
    }
  }

  if (!list || list.length === 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  let html = '';
  list.forEach(f => {
    const photoHtml = f.photo
      ? `<img src="${escapeHtml(f.photo)}" alt="${escapeHtml(f.name)}" class="team-avatar" loading="lazy">`
      : `<div class="team-avatar team-avatar-fallback">${escapeHtml(getInitials(f.name))}</div>`;

    const contactBtns = [];
    if (f.linkedin) {
      contactBtns.push(`<a href="${escapeHtml(f.linkedin)}" target="_blank" rel="noopener noreferrer" class="contact-chip contact-chip-email" style="text-decoration:none;"><i class="fab fa-linkedin"></i> LinkedIn</a>`);
    }

    html += `<div class="professor-card friend-card">${photoHtml}<h3>${escapeHtml(f.name)}</h3><div class="prof-title">${escapeHtml(f.role || 'Supporter')}</div><p>${escapeHtml(f.bio || '')}</p>${contactBtns.length ? `<div class="team-contact-row">${contactBtns.join('')}</div>` : ''}</div>`;
  });
  grid.innerHTML = html;
}

/* ---------- Submit modals ---------- */
function openAlumniSubmitModal() {
  ['alumName','alumBatch','alumDegree','alumRole','alumCompany','alumLocation',
   'alumEmail','alumPhone','alumLinkedin','alumBio'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const prev = document.getElementById('alumPhotoPreview');
  if (prev && prev.tagName === 'IMG') {
    prev.outerHTML = `<div class="profile-preview-empty" id="alumPhotoPreview"><i class="fas fa-user"></i></div>`;
  }
  window.__pendingAlumPhotoFile = null;
  openModal('alumniSubmitModal');
}

function openFriendSubmitModal() {
  ['frName','frRole','frBio','frEmail','frPhone','frLinkedin'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const prev = document.getElementById('frPhotoPreview');
  if (prev && prev.tagName === 'IMG') {
    prev.outerHTML = `<div class="profile-preview-empty" id="frPhotoPreview"><i class="fas fa-user"></i></div>`;
  }
  window.__pendingFrPhotoFile = null;
  openModal('friendSubmitModal');
}

function previewAlumniPhoto(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { input.value = ''; return showToast('Image too large (max 2 MB).', 'error'); }
  const reader = new FileReader();
  reader.onload = (e) => {
    const prev = document.getElementById('alumPhotoPreview');
    if (prev) {
      const img = document.createElement('img');
      img.src = e.target.result;
      img.className = 'profile-preview';
      img.id = 'alumPhotoPreview';
      img.alt = 'Preview';
      prev.replaceWith(img);
    }
    window.__pendingAlumPhotoFile = file;
  };
  reader.readAsDataURL(file);
}

function previewFriendPhoto(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { input.value = ''; return showToast('Image too large (max 2 MB).', 'error'); }
  const reader = new FileReader();
  reader.onload = (e) => {
    const prev = document.getElementById('frPhotoPreview');
    if (prev) {
      const img = document.createElement('img');
      img.src = e.target.result;
      img.className = 'profile-preview';
      img.id = 'frPhotoPreview';
      img.alt = 'Preview';
      prev.replaceWith(img);
    }
    window.__pendingFrPhotoFile = file;
  };
  reader.readAsDataURL(file);
}

async function submitAlumniForm(e) {
  if (e) e.preventDefault();
  const name = ($('alumName').value || '').trim();
  const bio  = ($('alumBio').value  || '').trim();
  if (!name) return showToast('Please enter your name.', 'error');
  if (!bio)  return showToast('Please share a short bio.', 'error');

  const btn = $('alumSubmitBtn');
  const originalHTML = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting…'; }

  try {
    let photoUrl = '';
    if (window.__pendingAlumPhotoFile) {
      showToast('Uploading photo…', 'info');
      const up = await uploadFileToServer(window.__pendingAlumPhotoFile);
      photoUrl = up.url;
    }
    const payload = {
      name,
      batch:       ($('alumBatch').value    || '').trim(),
      degree:      ($('alumDegree').value   || '').trim(),
      currentRole: ($('alumRole').value     || '').trim(),
      company:     ($('alumCompany').value  || '').trim(),
      location:    ($('alumLocation').value || '').trim(),
      email:       ($('alumEmail').value    || '').trim(),
      phone:       ($('alumPhone').value    || '').trim(),
      linkedin:    ($('alumLinkedin').value || '').trim(),
      bio,
      photo: photoUrl
    };
    const res = await fetch(`${API_BASE}/alumni/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      closeModal('alumniSubmitModal');
      showToast('✅ ' + (data.message || 'Submitted for review.'), 'success');
    } else {
      showToast(data.message || 'Submission failed.', 'error');
    }
  } catch (err) {
    console.error('[submitAlumniForm]', err);
    showToast('Network error. Please try again.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = originalHTML; }
  }
}

async function submitFriendForm(e) {
  if (e) e.preventDefault();
  const name = ($('frName').value || '').trim();
  const role = ($('frRole').value || '').trim();
  if (!name) return showToast('Please enter your name.', 'error');
  if (!role) return showToast('Please enter your role.', 'error');

  const btn = $('frSubmitBtn');
  const originalHTML = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting…'; }

  try {
    let photoUrl = '';
    if (window.__pendingFrPhotoFile) {
      showToast('Uploading photo…', 'info');
      const up = await uploadFileToServer(window.__pendingFrPhotoFile);
      photoUrl = up.url;
    }
    const payload = {
      name, role,
      bio:      ($('frBio').value      || '').trim(),
      email:    ($('frEmail').value    || '').trim(),
      phone:    ($('frPhone').value    || '').trim(),
      linkedin: ($('frLinkedin').value || '').trim(),
      photo: photoUrl
    };
    const res = await fetch(`${API_BASE}/friends/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      closeModal('friendSubmitModal');
      showToast('✅ ' + (data.message || 'Submitted for review.'), 'success');
    } else {
      showToast(data.message || 'Submission failed.', 'error');
    }
  } catch (err) {
    console.error('[submitFriendForm]', err);
    showToast('Network error. Please try again.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = originalHTML; }
  }
}

/* ---------- Admin: Community Tab ---------- */
async function renderAdminCommunity() {
  const container = document.getElementById('adminCommunityContent');
  if (!container) return;
  container.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>Loading community…</p></div>`;

  try {
    const res = await fetch(`${API_BASE}/admin/community?adminId=${currentUser._id}&t=${Date.now()}`, { cache: 'no-store' });
    const data = await res.json();
    if (!data.success) throw new Error(data.message || 'Failed to load.');

    const alumni  = data.alumni  || [];
    const friends = data.friends || [];

    const pendA = alumni.filter(x => x.status === 'pending');
    const apprA = alumni.filter(x => x.status === 'approved');
    const rejA  = alumni.filter(x => x.status === 'rejected');
    const pendF = friends.filter(x => x.status === 'pending');
    const apprF = friends.filter(x => x.status === 'approved');
    const rejF  = friends.filter(x => x.status === 'rejected');

    let html = '';

    /* ---- Alumni block ---- */
    html += `
      <div class="editor-section">
        <div class="editor-section-header">
          <div class="editor-section-title">
            <i class="fas fa-graduation-cap"></i> Alumni Submissions
            <span style="font-size:12px;color:var(--text-tertiary);font-weight:500;margin-left:8px;">
              ${pendA.length} pending · ${apprA.length} approved · ${rejA.length} rejected
            </span>
          </div>
        </div>
        ${renderCommunityList('alumni', pendA, 'Pending Approval', 'pending')}
        ${renderCommunityList('alumni', apprA, 'Approved (visible to students)', 'approved')}
        ${renderCommunityList('alumni', rejA,  'Rejected', 'rejected')}
      </div>
    `;

    /* ---- Friends block ---- */
    html += `
      <div class="editor-section">
        <div class="editor-section-header">
          <div class="editor-section-title">
            <i class="fas fa-handshake"></i> Friends & Supporters
            <span style="font-size:12px;color:var(--text-tertiary);font-weight:500;margin-left:8px;">
              ${pendF.length} pending · ${apprF.length} approved · ${rejF.length} rejected
            </span>
          </div>
        </div>
        ${renderCommunityList('friends', pendF, 'Pending Approval', 'pending')}
        ${renderCommunityList('friends', apprF, 'Approved (visible to students)', 'approved')}
        ${renderCommunityList('friends', rejF,  'Rejected', 'rejected')}
      </div>
    `;

    container.innerHTML = html;
  } catch (e) {
    console.error('[admin/community]', e);
    container.innerHTML = `<div class="empty-state"><p style="color:var(--rose-500);">Error loading community: ${escapeHtml(e.message || 'unknown')}</p></div>`;
  }
}

function renderCommunityList(type, items, title, status) {
  if (items.length === 0) {
    return `<div class="community-group-head">${escapeHtml(title)} <span class="community-count">0</span></div>
            <p class="community-empty">No entries.</p>`;
  }
  let html = `<div class="community-group-head">${escapeHtml(title)} <span class="community-count">${items.length}</span></div>`;
  html += `<div class="community-list">`;
  items.forEach(x => {
    const photoHtml = x.photo
      ? `<img src="${escapeHtml(x.photo)}" alt="" class="community-avatar-img" loading="lazy">`
      : `<div class="community-avatar-fallback">${escapeHtml(getInitials(x.name))}</div>`;

    const meta = [];
    if (type === 'alumni') {
      if (x.batch)       meta.push(escapeHtml(x.batch));
      if (x.currentRole) meta.push(escapeHtml(x.currentRole));
      if (x.company)     meta.push('@ ' + escapeHtml(x.company));
    } else {
      if (x.role) meta.push(escapeHtml(x.role));
    }

    let actions = '';
    if (status === 'pending') {
      actions = `
        <button class="btn btn-success btn-sm" onclick="approveCommunity('${type}', '${x._id}')"><i class="fas fa-check"></i> Approve</button>
        <button class="btn btn-warning btn-sm" onclick="rejectCommunity('${type}', '${x._id}')"><i class="fas fa-times"></i> Reject</button>`;
    } else if (status === 'approved') {
      actions = `
        <button class="btn btn-warning btn-sm" onclick="rejectCommunity('${type}', '${x._id}')"><i class="fas fa-times"></i> Unpublish</button>`;
    } else if (status === 'rejected') {
      actions = `
        <button class="btn btn-success btn-sm" onclick="approveCommunity('${type}', '${x._id}')"><i class="fas fa-check"></i> Approve</button>`;
    }
    actions += ` <button class="btn btn-danger btn-sm" onclick="deleteCommunity('${type}', '${x._id}', ${jsStr(x.name)})"><i class="fas fa-trash"></i></button>`;

    html += `
      <div class="community-item">
        <div class="community-avatar">${photoHtml}</div>
        <div class="community-info">
          <h4>${escapeHtml(x.name)}</h4>
          <div class="community-meta">${meta.join(' · ') || '—'}</div>
          ${x.bio ? `<div class="community-bio">${escapeHtml(x.bio.slice(0, 200))}${x.bio.length > 200 ? '…' : ''}</div>` : ''}
          ${x.email ? `<div class="community-contact"><i class="fas fa-envelope"></i> ${escapeHtml(x.email)}</div>` : ''}
        </div>
        <div class="community-actions">${actions}</div>
      </div>`;
  });
  html += `</div>`;
  return html;
}

async function approveCommunity(type, id) {
  if (!confirm('Approve this entry? It will become visible to students.')) return;
  try {
    const res = await fetch(`${API_BASE}/admin/${type}/${id}/approve`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: currentUser._id })
    });
    const data = await res.json();
    if (data.success) {
      showToast('✅ Approved.', 'success');
      invalidateCommunityCache();
      renderAdminCommunity();
    }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

async function rejectCommunity(type, id) {
  if (!confirm('Reject / Unpublish this entry?')) return;
  try {
    const res = await fetch(`${API_BASE}/admin/${type}/${id}/reject`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: currentUser._id })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Rejected.', 'info');
      invalidateCommunityCache();
      renderAdminCommunity();
    }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}

async function deleteCommunity(type, id, name) {
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`${API_BASE}/admin/${type}/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId: currentUser._id })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Deleted.', 'info');
      invalidateCommunityCache();
      renderAdminCommunity();
    }
    else showToast(data.message || 'Failed.', 'error');
  } catch { showToast('Server error.', 'error'); }
}
/* ============================================================
   AI DOUBT SOLVER — Frontend Functions
   ============================================================ */

/**
 * Ask AI a doubt
 * @param {string} courseId - Course ka ID
 * @param {boolean} postPublicly - Agar true, toh Q&A mein bhi save hoga
 */
async function askAIDoubt(courseId, postPublicly = false) {
  const input = document.getElementById(`aiDoubtInput-${courseId}`);
  const answerBox = document.getElementById(`aiDoubtAnswer-${courseId}`);
  const question = input ? input.value.trim() : '';

  // ---- Validation ----
  if (!question) {
    return showToast('Please type your doubt first.', 'error');
  }

  // ---- Loading state dikhao ----
  answerBox.style.display = 'block';
  answerBox.innerHTML = `
    <div class="ai-loading">
      <div class="ai-spinner"></div>
      <span>AI is thinking…</span>
    </div>`;

  try {
    // ---- Backend ko request bhejo ----
    const res = await fetch(`${API_BASE}/ai/solve-doubt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        courseId,
        userId: currentUser ? currentUser._id : null
      })
    });

    const data = await res.json();

    // ---- Error handle karo ----
    if (!data.success) {
      answerBox.innerHTML = `<div class="ai-error">
        <i class="fas fa-triangle-exclamation"></i> ${escapeHtml(data.message)}
      </div>`;
      return;
    }

    // ---- Answer render karo ----
    answerBox.innerHTML = `
      <div class="ai-answer-header">
        <i class="fas fa-robot"></i> <strong>AI Assistant</strong>
        <span class="ai-badge">Beta</span>
      </div>
      <div class="ai-answer-body" id="aiAnswerBody-${courseId}">${renderMarkdown(data.answer)}</div>
      <div class="ai-answer-footer">
        <span class="hint">⚠️ AI answers may be inaccurate. Verify with your instructor.</span>
        <button class="btn btn-outline btn-sm" onclick="copyAIAnswer('${courseId}')">
          <i class="fas fa-copy"></i> Copy
        </button>
      </div>`;

    // ---- LaTeX (math) render karo ----
    if (typeof renderMathIn === 'function') {
      renderMathIn(document.getElementById(`aiAnswerBody-${courseId}`));
    }

    // ---- Agar user chahta hai, toh Q&A mein bhi post karo ----
    if (postPublicly) {
      await fetch(`/api/courses/${courseId}/doubts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentName: currentUser.fullName || currentUser.username,
          studentUsername: currentUser.username,
          studentEmail: currentUser.email || '',
          question: `[AI-answered] ${question}\n\n🤖 AI Answer:\n${data.answer}`
        })
      });
      showToast('✅ Posted publicly for instructor review.', 'success');
      fetchCoursesFromDB();
    }

  } catch (err) {
    console.error('[askAIDoubt]', err);
    answerBox.innerHTML = `<div class="ai-error">
      <i class="fas fa-triangle-exclamation"></i> Network error. Please try again.
    </div>`;
  }
}

/**
 * AI answer ko clipboard mein copy karo
 */
function copyAIAnswer(courseId) {
  const body = document.getElementById(`aiAnswerBody-${courseId}`);
  if (!body) return;
  copyToClipboard(body.innerText).then(ok => {
    showToast(ok ? '✓ Copied!' : 'Copy failed.', ok ? 'success' : 'error');
  });
}

/* ============================================================
   renderMarkdown — AI answer → safe HTML
   ------------------------------------------------------------
   Handles: fenced code blocks, display math ($$…$$ and \[…\]),
   inline math ($…$ and \(…\)), markdown tables, headers,
   blockquotes, ordered + unordered lists, bold/italic/inline-code.

   KEY INSIGHT: math AND code blocks are stashed away as sentinel
   tokens BEFORE markdown processing, so the newline→<br> step
   can never split a math expression across lines (which breaks
   MathJax). They are restored verbatim at the very end.
   ============================================================ */
function renderMarkdown(text) {
  if (!text) return '';

  // ---- Step 1: Stash fenced code blocks ----
  const codeBlocks = [];
  let html = String(text).replace(/```([\s\S]*?)```/g, (_, body) => {
    const idx = codeBlocks.length;
    codeBlocks.push('<pre><code>' + escapeHtml(body.replace(/^\n+/, '')) + '</code></pre>');
    return '\u0001CB' + idx + '\u0001';
  });

  // ---- Step 2: Stash math (BEFORE escaping, so TeX survives) ----
  const mathBlocks = [];
  const stashMath = (content) => {
    const idx = mathBlocks.length;
    mathBlocks.push(content);
    return '\u0001MB' + idx + '\u0001';
  };

  // Display math: $$ ... $$
  html = html.replace(/\$\$([\s\S]*?)\$\$/g, (_, body) => stashMath('$$' + body + '$$'));
  // Display math: \[ ... \]
  html = html.replace(/\\\[([\s\S]*?)\\\]/g, (_, body) => stashMath('\\[' + body + '\\]'));
  // Inline math: \( ... \)
  html = html.replace(/\\\(([\s\S]*?)\\\)/g, (_, body) => stashMath('\\(' + body + '\\)'));
  // Inline math: $ ... $  — skip escaped \$ and skip $$ (display)
  html = html.replace(/(^|[^\\$])\$([^\$\n]+?)\$(?!\$)/g, (full, before, body) => {
    return before + stashMath('$' + body + '$');
  });

  // ---- Step 3: Escape remaining HTML ----
  html = escapeHtml(html);

  // ---- Step 4: Markdown tables ----
  html = html.replace(
    /(?:^\|.+\|[ \t]*\n)(?:^\|[\s\-:|]+\|[ \t]*\n)(?:^\|.+\|[ \t]*\n?)+/gm,
    (block) => {
      const lines = block.trim().split('\n').filter(l => l.trim());
      if (lines.length < 2) return block;

      const parseRow = (line) =>
        line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());

      const headers = parseRow(lines[0]);
      const rows    = lines.slice(2).map(parseRow); // skip the separator row

      let tbl = '<div class="ai-table-wrap"><table class="ai-table"><thead><tr>';
      headers.forEach(h => { tbl += `<th>${h}</th>`; });
      tbl += '</tr></thead><tbody>';
      rows.forEach(r => {
        tbl += '<tr>';
        r.forEach(c => { tbl += `<td>${c}</td>`; });
        tbl += '</tr>';
      });
      tbl += '</tbody></table></div>';
      return tbl;
    }
  );

  // ---- Step 5: Headers ----
  html = html.replace(/^#### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^### (.+)$/gm,  '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm,   '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm,    '<h3>$1</h3>');

  // ---- Step 6: Blockquotes ----
  html = html.replace(/^&gt;[ \t]?(.+)$/gm, '<blockquote>$1</blockquote>');

  // ---- Step 7: Lists ----
  // Unordered
  html = html.replace(/(?:^[ \t]*[-*+] .+(?:\n|$))+/gm, (block) => {
    const items = block.trimEnd().split('\n')
      .map(l => `<li>${l.replace(/^[ \t]*[-*+]\s*/, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });
  // Ordered
  html = html.replace(/(?:^[ \t]*\d+\. .+(?:\n|$))+/gm, (block) => {
    const items = block.trimEnd().split('\n')
      .map(l => `<li>${l.replace(/^[ \t]*\d+\.\s*/, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // ---- Step 8: Inline formatting ----
  html = html.replace(/`([^`\n]+)`/g,       '<code>$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  // ---- Step 9: Paragraphs & single line breaks ----
  const blocks = html.split(/\n{2,}/);
  html = blocks.map(p => {
    const t = p.trim();
    if (!t) return '';
    // Block-level HTML must not be wrapped in <p>
    if (/^<(h[1-6]|table|ul|ol|blockquote|div|pre|hr)\b/i.test(t)) return t;
    return '<p>' + t.replace(/\n/g, '<br>') + '</p>';
  }).filter(Boolean).join('\n');

  // ---- Step 10: Restore stashed math + code blocks ----
  html = html.replace(/\u0001MB(\d+)\u0001/g, (_, i) => mathBlocks[Number(i)]);
  html = html.replace(/\u0001CB(\d+)\u0001/g, (_, i) => codeBlocks[Number(i)]);

  return html;
}
/* ============================================================
   STUDENT FEEDBACK SYSTEM — Frontend
   ============================================================ */
let _feedbackRating = 5;

function openFeedbackModal() {
  const modal = document.getElementById('feedbackModal');
  if (!modal) return showToast('Feedback modal missing.', 'error');

  // Reset form
  const titleEl = document.getElementById('feedbackTitle');
  const msgEl   = document.getElementById('feedbackMessage');
  if (titleEl) titleEl.value = '';
  if (msgEl)   msgEl.value = '';
  setFeedbackRating(5);

  openModal('feedbackModal');
  setTimeout(() => titleEl && titleEl.focus(), 120);
}

function setFeedbackRating(v) {
  _feedbackRating = Math.min(5, Math.max(1, parseInt(v, 10) || 5));
  const hidden = document.getElementById('feedbackRating');
  if (hidden) hidden.value = _feedbackRating;

  document.querySelectorAll('#feedbackStars button').forEach(btn => {
    const bv = parseInt(btn.dataset.v, 10);
    btn.classList.toggle('active', bv <= _feedbackRating);
  });
}

async function submitStudentFeedback(e) {
  if (e) e.preventDefault();

  const title = (document.getElementById('feedbackTitle')?.value || '').trim();
  const msg   = (document.getElementById('feedbackMessage')?.value || '').trim();
  if (!msg) return showToast('Please write your feedback.', 'error');

  const btn = document.getElementById('feedbackSubmitBtn');
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting…'; }

  try {
    const data = await fetchJSON(`${API_BASE}/feedback/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentName:     currentUser?.fullName || currentUser?.username || '',
        studentUsername: currentUser?.username || '',
        studentEmail:    currentUser?.email || '',
        rating:          _feedbackRating,
        title,
        message:         msg
      })
    });
    if (data.success) {
      closeModal('feedbackModal');
      showToast('✅ Thanks! Your feedback is pending admin review.', 'success');
    } else {
      showToast(data.message || 'Could not submit feedback.', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Network error.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig || '<i class="fas fa-paper-plane"></i> Submit Feedback'; }
  }
}

async function loadApprovedFeedback() {
  const host = document.getElementById('studentFeedbackList');
  if (!host) return;

  host.innerHTML = `<div class="empty-state" style="padding:30px 20px;">
    <i class="fas fa-spinner fa-spin"></i><p>Loading reviews…</p></div>`;

  try {
    const data = await fetchJSON(`${API_BASE}/feedback?_t=${Date.now()}`);
    const list = (data && data.success && Array.isArray(data.feedback)) ? data.feedback : [];

    if (list.length === 0) {
      host.innerHTML = `<div class="empty-state" style="padding:30px 20px;">
        <i class="fas fa-star-half-alt"></i>
        <p>No reviews yet — be the first to share yours!</p>
      </div>`;
      return;
    }

    let html = '<div class="feedback-wall">';
    list.forEach(f => {
      const initials = (f.studentName || f.studentUsername || '?')
        .split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
      const stars = '★'.repeat(f.rating || 5) + '☆'.repeat(5 - (f.rating || 5));
      const when = f.approvedAt || f.submittedAt
        ? new Date(f.approvedAt || f.submittedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
        : '';

      html += `
        <div class="feedback-card">
          <div class="feedback-card-head">
            <div class="feedback-avatar">${escapeHtml(initials)}</div>
            <div class="feedback-card-meta">
              <strong>${escapeHtml(f.studentName || f.studentUsername || 'Student')}</strong>
              <span class="feedback-stars-display">${stars}</span>
            </div>
            <span class="feedback-card-date">${when}</span>
          </div>
          ${f.title ? `<div class="feedback-card-title">${escapeHtml(f.title)}</div>` : ''}
          <p class="feedback-card-body">${escapeHtml(f.message)}</p>
          ${f.courseName ? `<div class="feedback-card-course"><i class="fas fa-graduation-cap"></i> ${escapeHtml(f.courseName)}</div>` : ''}
        </div>`;
    });
    html += '</div>';
    host.innerHTML = html;
  } catch (err) {
    console.error('[loadApprovedFeedback]', err);
    host.innerHTML = `<div class="empty-state" style="padding:30px 20px;">
      <p style="color:var(--rose-500);">Could not load reviews.</p>
    </div>`;
  }
}

/* ============================================================
   STUDENT CONTRIBUTIONS — Frontend
   ============================================================ */
function openContributionModal() {
  const modal = document.getElementById('contributionModal');
  if (!modal) return showToast('Contribution modal missing.', 'error');

  ['contribTitle', 'contribSubject', 'contribDescription'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const fileEl = document.getElementById('contribFile');
  if (fileEl) fileEl.value = '';

  openModal('contributionModal');
  setTimeout(() => document.getElementById('contribTitle')?.focus(), 120);
}

async function submitContribution(e) {
  if (e) e.preventDefault();

  const title  = (document.getElementById('contribTitle')?.value || '').trim();
  const fileEl = document.getElementById('contribFile');
  const file   = fileEl && fileEl.files ? fileEl.files[0] : null;

  if (!title) return showToast('Please enter a title.', 'error');
  if (!file)  return showToast('Please attach a file.', 'error');
  if (file.size > 50 * 1024 * 1024) return showToast('File too large (max 50 MB).', 'error');

  const btn = document.getElementById('contribSubmitBtn');
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading…'; }

  try {
    // Upload file first
    const up = await uploadFileToServer(file, pct => {
      if (btn) btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Uploading ${pct}%`;
    });

    const data = await fetchJSON(`${API_BASE}/contributions/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentName:     currentUser?.fullName || currentUser?.username || '',
        studentUsername: currentUser?.username || '',
        studentEmail:    currentUser?.email || '',
        title,
        subject:         (document.getElementById('contribSubject')?.value || '').trim(),
        description:     (document.getElementById('contribDescription')?.value || '').trim(),
        fileUrl:            up.url,
        cloudUrl:           up.cloudUrl || '',
        diskName:           up.diskName || '',
        fileName:           up.fileName || file.name,
        fileSize:           file.size,
        fileType:           file.type,
        cloudinaryPublicId: up.publicId || ''
      })
    });

    if (data.success) {
      closeModal('contributionModal');
      showToast('✅ ' + (data.message || 'Contribution submitted!'), 'success');
      loadMyContributions();
    } else {
      showToast(data.message || 'Upload failed.', 'error');
    }
  } catch (err) {
    console.error('[submitContribution]', err);
    showToast(err.message || 'Upload failed.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig || '<i class="fas fa-upload"></i> Upload Contribution'; }
  }
}

async function loadMyContributions() {
  const host = document.getElementById('myContributionsList');
  if (!host) return;

  if (!currentUser || !currentUser.username) {
    host.innerHTML = '';
    return;
  }

  host.innerHTML = `<div class="empty-state" style="padding:30px 20px;">
    <i class="fas fa-spinner fa-spin"></i><p>Loading your contributions…</p></div>`;

  try {
    const data = await fetchJSON(`${API_BASE}/contributions/mine/${encodeURIComponent(currentUser.username)}?_t=${Date.now()}`);
    const list = (data && data.success && Array.isArray(data.contributions)) ? data.contributions : [];

    if (list.length === 0) {
      host.innerHTML = `<div class="empty-state" style="padding:30px 20px;">
        <i class="fas fa-inbox"></i>
        <p>You haven't contributed anything yet.</p>
      </div>`;
      return;
    }

    let html = '<div class="contribution-list">';
    list.forEach(c => {
      const status = c.status === 'pending'
        ? '<span class="contribution-status pending"><i class="fas fa-circle"></i> Pending review</span>'
        : c.status === 'downloaded'
          ? '<span class="contribution-status ok"><i class="fas fa-check-circle"></i> Approved & downloaded</span>'
          : '<span class="contribution-status bad"><i class="fas fa-times-circle"></i> Removed</span>';
      const when = c.submittedAt
        ? new Date(c.submittedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
        : '';
      const sizeMB = c.fileSize ? (c.fileSize / (1024 * 1024)).toFixed(2) + ' MB' : '';

      html += `
        <div class="contribution-row">
          <div class="contribution-icon"><i class="fas fa-file-alt"></i></div>
          <div class="contribution-info">
            <h4>${escapeHtml(c.title)}</h4>
            ${c.subject ? `<div class="contribution-subject">${escapeHtml(c.subject)}</div>` : ''}
            ${c.description ? `<p class="contribution-desc">${escapeHtml(c.description)}</p>` : ''}
            <div class="contribution-meta">
              ${status}
              ${when ? `<span><i class="fas fa-calendar"></i> ${when}</span>` : ''}
              ${sizeMB ? `<span><i class="fas fa-hdd"></i> ${sizeMB}</span>` : ''}
            </div>
          </div>
        </div>`;
    });
    html += '</div>';
    host.innerHTML = html;
  } catch (err) {
    console.error('[loadMyContributions]', err);
    host.innerHTML = `<div class="empty-state" style="padding:30px 20px;">
      <p style="color:var(--rose-500);">Could not load your contributions.</p>
    </div>`;
  }
}

/* ============================================================
   ADMIN — FEEDBACK MODERATION TAB
   ============================================================ */
async function renderAdminFeedback() {
  const el = document.getElementById('adminFeedbackContent');
  if (!el) return;
  el.classList.add('active');
  el.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>Loading feedback…</p></div>`;

  let list = [];
  try {
    const data = await fetchJSON(`${API_BASE}/admin/feedback?t=${Date.now()}`);
    if (data.success) list = data.feedback || [];
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><p style="color:var(--rose-500);">${escapeHtml(e.message)}</p></div>`;
    return;
  }

  const pend = list.filter(f => f.status === 'pending');
  const appr = list.filter(f => f.status === 'approved');
  const rej  = list.filter(f => f.status === 'rejected');

  const renderGroup = (title, items, status) => {
    if (items.length === 0) {
      return `<div class="community-group-head">${escapeHtml(title)} <span class="community-count">0</span></div>
              <p class="community-empty">No entries.</p>`;
    }
    let h = `<div class="community-group-head">${escapeHtml(title)} <span class="community-count">${items.length}</span></div>`;
    h += '<div class="community-list">';
    items.forEach(f => {
      const stars = '★'.repeat(f.rating || 5);
      const initials = (f.studentName || f.studentUsername || '?')
        .split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();

      let actions = '';
      if (status === 'pending') {
        actions = `
          <button class="btn btn-success btn-sm" onclick="approveFeedback('${f._id}')"><i class="fas fa-check"></i> Approve</button>
          <button class="btn btn-warning btn-sm" onclick="rejectFeedback('${f._id}')"><i class="fas fa-times"></i> Reject</button>`;
      } else if (status === 'approved') {
        actions = `<button class="btn btn-warning btn-sm" onclick="rejectFeedback('${f._id}')"><i class="fas fa-times"></i> Unpublish</button>`;
      } else if (status === 'rejected') {
        actions = `<button class="btn btn-success btn-sm" onclick="approveFeedback('${f._id}')"><i class="fas fa-check"></i> Approve</button>`;
      }
      actions += ` <button class="btn btn-danger btn-sm" onclick="deleteFeedback('${f._id}', ${jsStr(f.studentName || f.studentUsername || 'Feedback')})"><i class="fas fa-trash"></i></button>`;

      h += `
        <div class="community-item">
          <div class="community-avatar"><div class="community-avatar-fallback">${escapeHtml(initials)}</div></div>
          <div class="community-info">
            <h4>${escapeHtml(f.studentName || f.studentUsername || 'Student')} <span style="color:var(--gold-500);font-size:12px;">${stars}</span></h4>
            ${f.title ? `<div class="community-meta"><strong>${escapeHtml(f.title)}</strong></div>` : ''}
            <div class="community-bio">${escapeHtml(f.message)}</div>
            ${f.courseName ? `<div class="community-contact"><i class="fas fa-graduation-cap"></i> ${escapeHtml(f.courseName)}</div>` : ''}
          </div>
          <div class="community-actions">${actions}</div>
        </div>`;
    });
    h += '</div>';
    return h;
  };

  el.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-header">
        <div class="editor-section-title">
          <i class="fas fa-comment-dots"></i> Student Feedback
          <span style="font-size:12px;color:var(--text-tertiary);font-weight:500;margin-left:8px;">
            ${pend.length} pending · ${appr.length} approved · ${rej.length} rejected
          </span>
        </div>
      </div>
      ${renderGroup('Pending Approval', pend, 'pending')}
      ${renderGroup('Approved (visible to students)', appr, 'approved')}
      ${renderGroup('Rejected', rej, 'rejected')}
    </div>`;
}

async function approveFeedback(id) {
  if (!confirm('Approve this feedback? It will become public.')) return;
  try {
    const data = await fetchJSON(`${API_BASE}/admin/feedback/${id}/approve`, { method: 'PUT' });
    if (data.success) { showToast('✅ Approved.', 'success'); renderAdminFeedback(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch (e) { showToast(e.message, 'error'); }
}
async function rejectFeedback(id) {
  if (!confirm('Reject / Unpublish this feedback?')) return;
  try {
    const data = await fetchJSON(`${API_BASE}/admin/feedback/${id}/reject`, { method: 'PUT' });
    if (data.success) { showToast('Rejected.', 'info'); renderAdminFeedback(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch (e) { showToast(e.message, 'error'); }
}
async function deleteFeedback(id, who) {
  if (!confirm(`Delete feedback from "${who}"?`)) return;
  try {
    const data = await fetchJSON(`${API_BASE}/admin/feedback/${id}`, { method: 'DELETE' });
    if (data.success) { showToast('Deleted.', 'info'); renderAdminFeedback(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch (e) { showToast(e.message, 'error'); }
}

/* ============================================================
   ADMIN — CONTRIBUTIONS TAB
   ============================================================ */
async function renderAdminContributions() {
  const el = document.getElementById('adminContributionsContent');
  if (!el) return;
  el.classList.add('active');
  el.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>Loading contributions…</p></div>`;

  let list = [];
  try {
    const data = await fetchJSON(`${API_BASE}/admin/contributions?t=${Date.now()}`);
    if (data.success) list = data.contributions || [];
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><p style="color:var(--rose-500);">${escapeHtml(e.message)}</p></div>`;
    return;
  }

  const pend = list.filter(c => c.status === 'pending');
  const done = list.filter(c => c.status === 'downloaded');

  const renderGroup = (title, items) => {
    if (items.length === 0) {
      return `<div class="community-group-head">${escapeHtml(title)} <span class="community-count">0</span></div>
              <p class="community-empty">No entries.</p>`;
    }
    let h = `<div class="community-group-head">${escapeHtml(title)} <span class="community-count">${items.length}</span></div>`;
    h += '<div class="community-list">';
    items.forEach(c => {
      const when = c.submittedAt
        ? new Date(c.submittedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
        : '';
      const sizeMB = c.fileSize ? (c.fileSize / (1024 * 1024)).toFixed(2) + ' MB' : '';

      h += `
        <div class="community-item">
          <div class="community-avatar"><div class="community-avatar-fallback"><i class="fas fa-file-alt"></i></div></div>
          <div class="community-info">
            <h4>${escapeHtml(c.title)}</h4>
            ${c.subject ? `<div class="community-meta">${escapeHtml(c.subject)}</div>` : ''}
            ${c.description ? `<div class="community-bio">${escapeHtml(c.description.slice(0, 200))}</div>` : ''}
            <div class="community-contact">
              <i class="fas fa-user"></i> ${escapeHtml(c.studentName || c.studentUsername)}
              ${c.studentEmail ? ` · <i class="fas fa-envelope"></i> ${escapeHtml(c.studentEmail)}` : ''}
              ${when ? ` · <i class="fas fa-calendar"></i> ${when}` : ''}
              ${sizeMB ? ` · <i class="fas fa-hdd"></i> ${sizeMB}` : ''}
            </div>
          </div>
          <div class="community-actions">
            <button type="button" class="btn btn-primary btn-sm"
                    onclick="downloadContribution('${c._id}', ${jsStr(c.fileName || c.title || 'contribution')})">
              <i class="fas fa-download"></i> Download
            </button>
            <button type="button" class="btn btn-danger btn-sm"
                    onclick="deleteContribution('${c._id}', ${jsStr(c.title)})">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </div>`;
    });
    h += '</div>';
    return h;
  };

  el.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-header">
        <div class="editor-section-title">
          <i class="fas fa-hand-holding-heart"></i> Student Contributions
          <span style="font-size:12px;color:var(--text-tertiary);font-weight:500;margin-left:8px;">
            ${pend.length} pending · ${done.length} downloaded
          </span>
        </div>
      </div>
      <p class="editor-hint">
        Click <strong>Download</strong> to save a contribution to your machine. Marked as "downloaded"
        once you've grabbed it — you can then upload it to a course yourself.
      </p>
      ${renderGroup('Pending Download', pend)}
      ${renderGroup('Already Downloaded', done)}
    </div>`;
}

/* ============================================================
   ADMIN — BACKUP & RESTORE TAB
   ============================================================ */
function renderAdminBackup() {
  const el = document.getElementById('adminBackupContent');
  if (!el) return;
  el.classList.add('active');

  el.innerHTML = `
    <div class="editor-section">
      <div class="editor-section-title">
        <i class="fas fa-database"></i> Backup & Restore Students
      </div>
      <p class="editor-hint">
        Export all students to a CSV file you can keep as a backup. The CSV contains
        <strong>username, passwordHash, role, fullName, email, phone, createdAt</strong>.
        Import the same file back to restore — existing users are updated, new users are created.
      </p>
    </div>

    <div class="backup-grid">
      <div class="backup-card">
        <div class="backup-card-icon tone-brand"><i class="fas fa-download"></i></div>
        <h3>Export Students</h3>
        <p>Download a CSV file containing every student account. Store it somewhere safe.</p>
        <button class="btn btn-primary btn-lg" onclick="exportStudentsCSV()">
          <i class="fas fa-file-csv"></i> Download CSV
        </button>
      </div>

      <div class="backup-card">
        <div class="backup-card-icon tone-emerald"><i class="fas fa-upload"></i></div>
        <h3>Import Students</h3>
        <p>Upload a CSV backup to restore or merge student accounts. Existing usernames are updated.</p>
        <input type="file" id="csvImportInput" accept=".csv,text/csv" style="display:none;" onchange="handleCSVImport(this)">
        <button class="btn btn-success btn-lg" onclick="document.getElementById('csvImportInput').click()">
          <i class="fas fa-upload"></i> Upload CSV
        </button>
      </div>
    </div>

    <div class="editor-section">
      <div class="editor-section-title"><i class="fas fa-shield-halved"></i> Safety Notes</div>
      <ul style="margin:8px 0 0 22px;color:var(--text-secondary);line-height:1.7;font-size:13.5px;">
        <li>CSV export contains <strong>bcrypt password hashes</strong>, not plaintext. Keep the file secure.</li>
        <li>Importing does <strong>not</strong> delete existing students — it only adds or updates.</li>
        <li>Max file size for import: <strong>25 MB</strong>.</li>
      </ul>
    </div>
  `;
}

async function exportStudentsCSV() {
  try {
    showToast('Preparing CSV…', 'info');
    const token = sessionStorage.getItem('aero_token');
    const res = await fetch(`${API_BASE}/admin/students/export-csv`, {
      headers: token ? { 'Authorization': 'Bearer ' + token } : {}
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aero-students-backup-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
    showToast('✅ CSV downloaded.', 'success');
  } catch (err) {
    console.error('[exportStudentsCSV]', err);
    showToast('Export failed: ' + err.message, 'error');
  }
}

async function handleCSVImport(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    input.value = '';
    return showToast('File too large (max 25 MB).', 'error');
  }

  if (!confirm(`Import students from "${file.name}"?\n\nExisting usernames will be UPDATED. New ones CREATED. Nothing is deleted.`)) {
    input.value = '';
    return;
  }

  const form = new FormData();
  form.append('csvFile', file);

  showToast('Importing…', 'info');
  try {
    const token = sessionStorage.getItem('aero_token');
    const res = await fetch(`${API_BASE}/admin/students/import-csv`, {
      method: 'POST',
      headers: token ? { 'Authorization': 'Bearer ' + token } : {},
      body: form
    });
    const data = await res.json();
    if (data.success) {
      showToast('✅ ' + data.message, 'success');
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        console.warn('[csv-import] Errors:', data.errors);
        showToast(`${data.errors.length} row(s) had issues — see console.`, 'info');
      }
    } else {
      showToast(data.message || 'Import failed.', 'error');
    }
  } catch (err) {
    console.error('[handleCSVImport]', err);
    showToast('Import error: ' + err.message, 'error');
  } finally {
    input.value = '';
  }
}
/* ============================================================
   AI HOME PAGE — Chat-style Doubt Solver
   ============================================================ */
let _aiHomeChat = [];   // [{ role: 'user'|'assistant', text, ts, error? }]
let _aiHomeBusy = false;
let _aiHomeRendered = false;

const AI_HOME_SUGGESTIONS = [
  { icon: 'fa-atom',        text: "Explain Bernoulli's equation with a real-world example" },
  { icon: 'fa-rocket',      text: "What's the difference between a turbojet and a turbofan engine?" },
  { icon: 'fa-calculator',  text: "A projectile is launched at 30° with 50 m/s. Find the max height." },
  { icon: 'fa-shapes',      text: "Derive the lift equation from first principles" },
  { icon: 'fa-satellite',   text: "Summarize the key concepts of orbital mechanics" },
  { icon: 'fa-gauge-high',  text: "What is Mach number and why does it matter?" }
];
/* ============================================================
   ENSURE AI HOME SECTION EXISTS
   ------------------------------------------------------------
   If the HTML file doesn't contain <section id="studentAIHomeView">,
   this creates it on-the-fly and injects it into the DOM.
   This way, even if the deployed index.html is stale, the AI
   home page still works.
   ============================================================ */
function ensureStudentAIHomeView() {
  if (document.getElementById('studentAIHomeView')) return;

  const section = document.createElement('section');
  section.id = 'studentAIHomeView';
  section.className = 'view';
  section.innerHTML = `
    <div class="ai-home-hero">
      <div class="ai-home-orb ai-home-orb-1"></div>
      <div class="ai-home-orb ai-home-orb-2"></div>
      <div class="ai-home-orb ai-home-orb-3"></div>

      <div class="ai-home-brand">
        <div class="ai-home-icon">
          <i class="fas fa-robot"></i>
          <span class="ai-home-pulse"></span>
        </div>
        <div class="ai-home-title-block">
          <span class="ai-home-badge">
            <i class="fas fa-bolt"></i> Powered by AI
          </span>
          <h1>AI Doubt Solver</h1>
          <p>Ask anything about your aerospace courses — get step-by-step solutions, clear explanations, and real-world context in seconds.</p>
        </div>
      </div>
    </div>

    <div class="ai-chat-shell">
      <div class="ai-chat-messages" id="aiChatMessages"></div>

      <div class="ai-chat-composer">
        <textarea
          id="aiHomeInput"
          class="ai-composer-input"
          placeholder="Ask a doubt… e.g. Explain Bernoulli's equation with an example"
          rows="1"
          maxlength="2000"
          oninput="aiHomeAutoGrow(this)"
          onkeydown="aiHomeKeydown(event)"></textarea>
        <div class="ai-composer-row">
          <span class="ai-composer-hint">
            <i class="fas fa-keyboard"></i>
            <strong>Enter</strong> to send · <strong>Shift+Enter</strong> for new line
          </span>
          <div class="ai-composer-btns">
            <button type="button" class="ai-clear-btn" onclick="resetAIHomeChat()" title="Clear conversation">
              <i class="fas fa-trash-alt"></i>
            </button>
            <button type="button" class="ai-send-btn" id="aiHomeSendBtn" onclick="askAIDoubtHome()">
              <i class="fas fa-paper-plane"></i> Ask AI
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Inject right after loginView (or at the top of main-content)
  const mainContent = document.querySelector('.main-content');
  if (!mainContent) {
    console.error('[nav] .main-content not found — cannot inject AI home');
    return;
  }

  const loginView = document.getElementById('loginView');
  if (loginView && loginView.parentNode === mainContent) {
    loginView.insertAdjacentElement('afterend', section);
  } else {
    mainContent.insertBefore(section, mainContent.firstChild);
  }

  console.log('[nav] ✅ studentAIHomeView injected dynamically');
}
function renderStudentAIHome() {
  // ⚠️ FIX: Self-heal — if the section is missing (e.g. stale deployed
  // index.html, or fresh login without initApp running), inject it now.
  ensureStudentAIHomeView();

  const messagesEl = document.getElementById('aiChatMessages');
  if (!messagesEl) return;

  // Wire the input once
  if (!_aiHomeRendered) {
    _aiHomeRendered = true;
    const input = document.getElementById('aiHomeInput');
    if (input) setTimeout(() => input.focus(), 80);
  }

  renderAIHomeChat();
}

function renderAIHomeChat() {
  const messagesEl = document.getElementById('aiChatMessages');
  if (!messagesEl) return;

  if (_aiHomeChat.length === 0) {
    messagesEl.innerHTML = renderAIWelcomeState();
    return;
  }

  let html = '';
  _aiHomeChat.forEach((m, i) => {
    if (m.role === 'user') {
      html += `
        <div class="ai-msg ai-msg-user">
          <div class="ai-msg-avatar"><i class="fas fa-user"></i></div>
          <div class="ai-msg-bubble">${escapeHtml(m.text)}</div>
        </div>`;
    } else if (m.error) {
      html += `
        <div class="ai-msg ai-msg-assistant ai-msg-error">
          <div class="ai-msg-avatar ai-avatar-error"><i class="fas fa-triangle-exclamation"></i></div>
          <div class="ai-msg-bubble">
            <div class="ai-msg-error-title">Couldn't fetch a response</div>
            <div class="ai-msg-error-body">${escapeHtml(m.text)}</div>
            <button class="ai-retry-btn" onclick="retryAILastMessage()">
              <i class="fas fa-rotate-right"></i> Try again
            </button>
          </div>
        </div>`;
    } else {
      html += `
        <div class="ai-msg ai-msg-assistant">
          <div class="ai-msg-avatar"><i class="fas fa-robot"></i></div>
          <div class="ai-msg-bubble">
            <div class="ai-answer-body" id="aiHomeMsg-${i}">${renderMarkdown(m.text)}</div>
            <div class="ai-msg-actions">
              <button class="ai-msg-action" onclick="copyAIHomeMessage(${i})" title="Copy">
                <i class="fas fa-copy"></i> Copy
              </button>
              <span class="ai-msg-model">${escapeHtml(m.model || 'AI')}</span>
            </div>
          </div>
        </div>`;
    }
  });

  if (_aiHomeBusy) {
    html += `
      <div class="ai-msg ai-msg-assistant">
        <div class="ai-msg-avatar"><i class="fas fa-robot"></i></div>
        <div class="ai-msg-bubble ai-typing-bubble">
          <span class="ai-typing-dot"></span>
          <span class="ai-typing-dot"></span>
          <span class="ai-typing-dot"></span>
          <span class="ai-typing-label">Thinking…</span>
        </div>
      </div>`;
  }

  messagesEl.innerHTML = html;

  // Render LaTeX AFTER the browser actually paints the new HTML.
  // Double rAF ensures MathJax measures correct widths.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (typeof renderMathIn === 'function') {
        messagesEl.querySelectorAll('.ai-answer-body').forEach(el => renderMathIn(el));
      }
    });
  });

  // Smooth scroll to bottom
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function renderAIWelcomeState() {
  let chips = '';
  AI_HOME_SUGGESTIONS.forEach(s => {
    chips += `
      <button class="ai-suggestion-chip" onclick="suggestAIPrompt(${jsStr(s.text)})">
        <i class="fas ${s.icon}"></i>
        <span>${escapeHtml(s.text)}</span>
      </button>`;
  });

  return `
    <div class="ai-welcome">
      <div class="ai-welcome-icon"><i class="fas fa-comments"></i></div>
      <h2>What would you like to learn today?</h2>
      <p>Ask a question below or pick one of these to get started.</p>
      <div class="ai-suggestions">${chips}</div>
      <div class="ai-welcome-tips">
        <div class="ai-tip">
          <i class="fas fa-lightbulb"></i>
          <span>Be specific — mention the topic, formulas, or units involved.</span>
        </div>
        <div class="ai-tip">
          <i class="fas fa-superscript"></i>
          <span>LaTeX is supported: use <code>$x^2$</code> or <code>$$\\int$$</code>.</span>
        </div>
      </div>
    </div>`;
}

function suggestAIPrompt(text) {
  const input = document.getElementById('aiHomeInput');
  if (!input) return;
  input.value = text;
  aiHomeAutoGrow(input);
  input.focus();
}

function aiHomeAutoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 220) + 'px';
}

function aiHomeKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    askAIDoubtHome();
  }
}

async function askAIDoubtHome() {
  if (_aiHomeBusy) return;

  const input = document.getElementById('aiHomeInput');
  if (!input) return;

  const question = input.value.trim();
  if (!question) return;

  if (question.length > 2000) {
    return showToast('Question too long (max 2000 characters).', 'error');
  }

  // Append user message
  _aiHomeChat.push({ role: 'user', text: question, ts: Date.now() });

  // Clear + reset input
  input.value = '';
  input.style.height = 'auto';

  _aiHomeBusy = true;
  renderAIHomeChat();

  try {
    const res = await fetchJSON(`${API_BASE}/ai/solve-doubt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        userId: currentUser ? currentUser._id : null
      })
    });

    if (res.success) {
      _aiHomeChat.push({
        role: 'assistant',
        text: res.answer,
        model: res.model,
        ts: Date.now()
      });
    } else {
      _aiHomeChat.push({
        role: 'assistant',
        text: res.message || 'Unknown error.',
        error: true,
        ts: Date.now()
      });
    }
  } catch (err) {
    console.error('[askAIDoubtHome]', err);
    _aiHomeChat.push({
      role: 'assistant',
      text: err.message || 'Network error. Please check your connection.',
      error: true,
      ts: Date.now()
    });
  } finally {
    _aiHomeBusy = false;
    renderAIHomeChat();
    const btn = document.getElementById('aiHomeSendBtn');
    if (btn) btn.disabled = false;
    if (input) input.focus();
  }
}

function retryAILastMessage() {
  // Find the last user message and re-ask
  const lastUser = [..._aiHomeChat].reverse().find(m => m.role === 'user');
  if (!lastUser) return;
  // Remove the error assistant message
  while (_aiHomeChat.length && _aiHomeChat[_aiHomeChat.length - 1].error) {
    _aiHomeChat.pop();
  }
  // Remove the user message (we'll re-add it inside askAIDoubtHome)
  if (_aiHomeChat.length && _aiHomeChat[_aiHomeChat.length - 1].role === 'user') {
    _aiHomeChat.pop();
  }
  const input = document.getElementById('aiHomeInput');
  if (input) input.value = lastUser.text;
  askAIDoubtHome();
}

function resetAIHomeChat() {
  if (_aiHomeChat.length === 0) return;
  if (!confirm('Clear the entire conversation?')) return;
  _aiHomeChat = [];
  renderAIHomeChat();
  const input = document.getElementById('aiHomeInput');
  if (input) { input.value = ''; input.focus(); }
}

function copyAIHomeMessage(idx) {
  const m = _aiHomeChat[idx];
  if (!m || !m.text) return;
  copyToClipboard(m.text).then(ok => {
    showToast(ok ? '✓ Copied to clipboard.' : 'Copy failed.', ok ? 'success' : 'error');
  });
}

/* ============================================================
   GLOBAL LATEX AUTO-RENDERER (safety net)
   ------------------------------------------------------------
   Watches the DOM for any new element containing LaTeX and
   auto-typesets it. Guarantees math renders even if some
   feature forgets to call renderMathIn() explicitly.
   ============================================================ */
(function installAutoLatexObserver() {
  if (window.__autoLatexInstalled) return;
  window.__autoLatexInstalled = true;

  const SELECTOR = '.ai-answer-body, .latex-content, .quiz-play-question, ' +
                   '.quiz-explain, .quiz-play-text, .ai-doubt-answer';

  const obs = new MutationObserver(mutations => {
    const toRender = new Set();

    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (node.matches && node.matches(SELECTOR)) toRender.add(node);
        if (node.querySelectorAll) {
          node.querySelectorAll(SELECTOR).forEach(el => toRender.add(el));
        }
      });
    });

    if (toRender.size === 0) return;

    // Defer to next frame so layout settles before MathJax measures
    requestAnimationFrame(() => {
      toRender.forEach(el => {
        if (el.isConnected && typeof renderMathIn === 'function') {
          renderMathIn(el);
        }
      });
    });
  });

  // Wait until body exists (script is deferred, but be safe)
  if (document.body) {
    obs.observe(document.body, { childList: true, subtree: true });
    console.log('[LaTeX] Auto-renderer installed');
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      obs.observe(document.body, { childList: true, subtree: true });
      console.log('[LaTeX] Auto-renderer installed');
    });
  }
})();

/* ============================================================
   MONETIZATION & GROWTH MODULE
   ------------------------------------------------------------
   • Multi-tier subscription plans (student pricing cards)
   • Coupon code input at checkout
   • Referral program (code, copy, progress, leaderboard)
   • Admin tabs: Plans, Coupons, Referrals
   ============================================================ */

/* ---------- Shared state ---------- */
let _livePlans = [];
let _liveReferralProgram = { enabled: false, threshold: 3, rewardDays: 30, rewardTitle: '', rewardDesc: '' };
let _activeCheckoutCoupon = null;
let _activeCheckoutPlan   = null;

/* ============================================================
   STUDENT: fetch & render subscription plans
   ============================================================ */
async function fetchSubscriptionPlans() {
  try {
    const res = await fetch(`${API_BASE}/subscription/plans?_t=${Date.now()}`, { cache: 'no-store' });
    const data = await res.json();
    if (data.success) {
      _livePlans = data.plans || [];
      _liveReferralProgram = data.referral || _liveReferralProgram;
      // keep legacy settings in sync for old code paths
      if (_livePlans.length > 0) {
        liveSubscriptionSettings.enabled = !!data.enabled;
        liveSubscriptionSettings.amount = _livePlans[0].amount;
      }
    }
  } catch (e) { /* silent */ }
}

/* ---------- Pricing cards (student home + subscription checkout) ---------- */
function renderSubscriptionPlansGrid(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!_livePlans || _livePlans.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-crown"></i>
        <p>No plans available right now.</p>
      </div>`;
    return;
  }

  const cards = _livePlans.map(p => {
    const perMonth = p.durationDays > 0 ? Math.round(p.amount / (p.durationDays / 30)) : p.amount;
    const featuredClass = p.featured ? 'plan-card-featured' : '';
    const badgeHtml = p.badge ? `<span class="plan-badge">${escapeHtml(p.badge)}</span>` : '';
    const savings = p.durationDays > 30
      ? `<div class="plan-savings">≈ ₹${perMonth}/month</div>`
      : '';

    return `
      <div class="plan-card ${featuredClass}">
        ${badgeHtml}
        <div class="plan-card-head">
          <div class="plan-duration">${p.durationDays} days</div>
          <div class="plan-title">${escapeHtml(p.title)}</div>
        </div>
        <div class="plan-price">
          <span class="plan-currency">₹</span>
          <span class="plan-amount">${p.amount}</span>
        </div>
        ${savings}
        <p class="plan-desc">${escapeHtml(p.description || '')}</p>
        <ul class="plan-features">
          <li><i class="fas fa-check"></i> Every course unlocked</li>
          <li><i class="fas fa-check"></i> All premium materials</li>
          <li><i class="fas fa-check"></i> AI Doubt Solver (unlimited)</li>
          <li><i class="fas fa-check"></i> Full quiz & analytics</li>
        </ul>
        <button class="btn btn-primary btn-block plan-select-btn"
                onclick="startCheckoutForPlan(${jsStr(p.id)})">
          <i class="fas fa-bolt"></i> Choose this plan
        </button>
      </div>`;
  }).join('');

  container.innerHTML = `<div class="plans-grid">${cards}</div>`;
}

/* ============================================================
   CHECKOUT MODAL — plan + coupon + proceed
   ============================================================ */
function startCheckoutForPlan(planId) {
  if (!currentUser || currentUser.role !== 'student') {
    return showToast('Please log in as a student first.', 'error');
  }
  if (currentUser.isSubscribed) {
    return showToast('You already have an active subscription.', 'info');
  }

  const plan = (_livePlans || []).find(p => p.id === planId);
  if (!plan) return showToast('Plan not found.', 'error');

  _activeCheckoutPlan = plan;
  _activeCheckoutCoupon = null;

  // Build modal (inject once)
  let modal = document.getElementById('checkoutPlanModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'checkoutPlanModal';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:560px;">
        <div class="modal-icon-header">
          <div class="modal-icon-tile tone-emerald" style="background:linear-gradient(135deg,#fbbf24,#f59e0b);">
            <i class="fas fa-crown"></i>
          </div>
          <div>
            <h3 id="checkoutPlanTitle">Confirm Subscription</h3>
            <p class="modal-sub" style="margin:2px 0 0;">Review your plan, apply a coupon, then proceed to pay.</p>
          </div>
        </div>

        <div class="checkout-plan-summary" id="checkoutPlanSummary"></div>

        <div class="form-group">
          <label>Have a coupon code?</label>
          <div class="coupon-row">
            <input type="text" id="checkoutCouponInput" placeholder="e.g. WELCOME20" maxlength="30" autocomplete="off"
                   oninput="this.value = this.value.toUpperCase().replace(/[^A-Z0-9_-]/g,'')">
            <button type="button" class="btn btn-outline" onclick="applyCheckoutCoupon()">
              <i class="fas fa-tag"></i> Apply
            </button>
          </div>
          <div id="checkoutCouponStatus" class="coupon-status"></div>
        </div>

        <div class="checkout-totals" id="checkoutTotals"></div>

        <div class="modal-actions">
          <button type="button" class="btn btn-outline" onclick="closeModal('checkoutPlanModal')">
            <i class="fas fa-arrow-left"></i> Cancel
          </button>
          <button type="button" class="btn btn-primary btn-lg" id="checkoutProceedBtn" onclick="proceedCheckout()">
            <i class="fas fa-lock"></i> Proceed to Pay
          </button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }

  document.getElementById('checkoutPlanTitle').textContent = plan.title;
  document.getElementById('checkoutCouponInput').value = '';
  document.getElementById('checkoutCouponStatus').innerHTML = '';
  renderCheckoutSummary();
  openModal('checkoutPlanModal');
}

function renderCheckoutSummary() {
  const plan = _activeCheckoutPlan;
  if (!plan) return;

  document.getElementById('checkoutPlanSummary').innerHTML = `
    <div class="checkout-plan-row">
      <div>
        <strong>${escapeHtml(plan.title)}</strong>
        <div class="checkout-plan-meta">
          <i class="fas fa-clock"></i> ${plan.durationDays} days · <i class="fas fa-infinity"></i> Full access
        </div>
      </div>
      <div class="checkout-plan-price">₹${plan.amount}</div>
    </div>
    <p class="checkout-plan-desc">${escapeHtml(plan.description || '')}</p>
  `;

  const final = _activeCheckoutCoupon ? _activeCheckoutCoupon.finalAmount : plan.amount;
  const discount = _activeCheckoutCoupon ? _activeCheckoutCoupon.discountAmount : 0;

  document.getElementById('checkoutTotals').innerHTML = `
    <div class="totals-row"><span>Original</span><span>₹${plan.amount}</span></div>
    ${discount > 0
      ? `<div class="totals-row discount"><span>Coupon (${_activeCheckoutCoupon.discountPercent}%)</span><span>− ₹${discount}</span></div>`
      : ''}
    <div class="totals-row grand"><span>Total payable</span><span>₹${final}</span></div>
  `;
}

async function applyCheckoutCoupon() {
  const input = document.getElementById('checkoutCouponInput');
  const status = document.getElementById('checkoutCouponStatus');
  const code = (input.value || '').trim().toUpperCase();
  if (!code) { status.innerHTML = ''; return; }
  if (!_activeCheckoutPlan) return;

  status.innerHTML = `<span class="coupon-status-loading"><i class="fas fa-spinner fa-spin"></i> Checking…</span>`;

  try {
    const res = await fetchJSON(`${API_BASE}/validate-coupon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, planId: _activeCheckoutPlan.id })
    });

    if (res.success && res.valid) {
      _activeCheckoutCoupon = res;
      status.innerHTML = `<span class="coupon-status-ok"><i class="fas fa-check-circle"></i> ${escapeHtml(res.message)}</span>`;
      renderCheckoutSummary();
    } else {
      _activeCheckoutCoupon = null;
      status.innerHTML = `<span class="coupon-status-err"><i class="fas fa-times-circle"></i> ${escapeHtml(res.message || 'Invalid code.')}</span>`;
      renderCheckoutSummary();
    }
  } catch (err) {
    _activeCheckoutCoupon = null;
    status.innerHTML = `<span class="coupon-status-err"><i class="fas fa-times-circle"></i> ${escapeHtml(err.message || 'Could not validate.')}</span>`;
    renderCheckoutSummary();
  }
}

async function proceedCheckout() {
  if (!_activeCheckoutPlan) return;
  if (!currentUser || currentUser.role !== 'student') return;

  const btn = document.getElementById('checkoutProceedBtn');
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Preparing…'; }

  try {
    // 1) Lazy-load Razorpay
    await window.loadRazorpay();

    // 2) Create order / subscription on server
    const createRes = await fetchJSON(`${API_BASE}/subscribe/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: currentUser._id,
        planId: _activeCheckoutPlan.id,
        couponCode: _activeCheckoutCoupon ? _activeCheckoutCoupon.code : null
      })
    });

    if (!createRes.success) {
      showToast(createRes.message || 'Could not start checkout.', 'error');
      return;
    }

    closeModal('checkoutPlanModal');

    const rzpOptions = {
      key: createRes.key_id,
      name: 'Aerospace Department',
      description: `${createRes.planTitle} — ${createRes.durationDays} days${createRes.couponCode ? ' · ' + createRes.couponCode : ''}`,
      prefill: {
        name: currentUser.fullName || currentUser.username,
        email: currentUser.email || 'student@aerospace.com',
        contact: '9999999999'
      },
      theme: { color: '#4f46e5' },
      modal: { ondismiss: function () { showToast('Checkout cancelled.', 'info'); } }
    };

    if (createRes.mode === 'one-time') {
      rzpOptions.amount = Math.round(createRes.amount * 100);
      rzpOptions.order_id = createRes.orderId;
      rzpOptions.handler = async function (response) {
        await _finalizeOneTimeSubscription(response);
      };
    } else {
      rzpOptions.subscription_id = createRes.subscriptionId;
      rzpOptions.handler = async function (response) {
        await _finalizeSubscription(response);
      };
    }

    const rzp = new Razorpay(rzpOptions);
    rzp.open();
  } catch (err) {
    console.error('[proceedCheckout]', err);
    showToast(err.message || 'Could not start checkout.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig || '<i class="fas fa-lock"></i> Proceed to Pay'; }
  }
}

async function _finalizeSubscription(response) {
  showToast('Verifying subscription…', 'info');
  try {
    const vres = await fetchJSON(`${API_BASE}/subscribe/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: currentUser._id,
        razorpay_subscription_id: response.razorpay_subscription_id,
        razorpay_payment_id: response.razorpay_payment_id,
        razorpay_signature: response.razorpay_signature
      })
    });
    if (vres.success) {
      currentUser = vres.user;
      saveSessionUser(currentUser);
      showToast('🎉 Subscription activated! All courses unlocked.', 'success');
      renderApp();
    } else {
      showToast(vres.message || 'Verification failed.', 'error');
    }
  } catch (err) {
    showToast('Verification error — contact support.', 'error');
  }
}

async function _finalizeOneTimeSubscription(response) {
  showToast('Verifying payment…', 'info');
  try {
    const vres = await fetchJSON(`${API_BASE}/subscribe/verify-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: currentUser._id,
        razorpay_order_id: response.razorpay_order_id,
        razorpay_payment_id: response.razorpay_payment_id,
        razorpay_signature: response.razorpay_signature
      })
    });
    if (vres.success) {
      currentUser = vres.user;
      saveSessionUser(currentUser);
      showToast('🎉 Subscription activated! All courses unlocked.', 'success');
      renderApp();
    } else {
      showToast(vres.message || 'Verification failed.', 'error');
    }
  } catch (err) {
    showToast('Verification error — contact support.', 'error');
  }
}

/* ============================================================
   OVERRIDE old startSubscriptionCheckout to use new flow
   (keeps backward compatibility with existing buttons)
   ============================================================ */
window.startSubscriptionCheckout = function () {
  if (!currentUser || currentUser.role !== 'student') {
    return showToast('Please log in as a student first.', 'error');
  }
  if (currentUser.isSubscribed) return showToast('You already have an active subscription.', 'info');
  if (!_livePlans.length) {
    showToast('No plans available right now.', 'error');
    return;
  }
  // Route to the first plan's checkout
  startCheckoutForPlan(_livePlans[0].id);
};

/* ============================================================
   STUDENT: Referral card
   ============================================================ */
async function renderReferralCard() {
  const anchor = document.getElementById('referralCardHost');
  if (anchor) anchor.remove();

  if (!currentUser || currentUser.role !== 'student') return;

  const host = document.getElementById('streakCardContainer');
  if (!host) return;

  let data;
  try {
    data = await fetchJSON(`${API_BASE}/user/referral/${currentUser._id}?_t=${Date.now()}`);
  } catch (e) {
    console.warn('[referral]', e.message);
    return;
  }
  if (!data.success || !data.program.enabled) return;

  const s = data.stats || {};
  const p = data.program || {};
  const shareLink = `${location.origin}${location.pathname}?ref=${data.referralCode}`;
  const progress = Math.min(100, Math.round((s.progressInCycle / Math.max(1, p.threshold)) * 100));

  const wrap = document.createElement('div');
  wrap.id = 'referralCardHost';
  wrap.innerHTML = `
    <div class="referral-card">
      <div class="referral-card-icon"><i class="fas fa-gift"></i></div>
      <div class="referral-card-body">
        <div class="referral-card-head">
          <div>
            <h4>Refer & earn free premium</h4>
            <p>Invite ${p.threshold} student${p.threshold === 1 ? '' : 's'} — get <strong>${escapeHtml(p.rewardTitle)}</strong>.</p>
          </div>
          <button class="btn btn-outline btn-sm" onclick="openReferralDetailsModal()">
            <i class="fas fa-info-circle"></i> View details
          </button>
        </div>

        <div class="referral-code-row">
          <div class="referral-code-box">
            <span class="referral-code-label">Your code</span>
            <span class="referral-code-value">${escapeHtml(data.referralCode)}</span>
          </div>
          <button class="btn btn-primary btn-sm" onclick="copyReferralLink()">
            <i class="fas fa-copy"></i> Copy link
          </button>
        </div>

        <div class="referral-progress-row">
          <div class="referral-progress-bar">
            <div class="referral-progress-fill" style="width:${progress}%"></div>
          </div>
          <div class="referral-progress-text">
            <strong>${s.totalReferred}</strong> referred · ${s.progressInCycle}/${p.threshold} toward next reward
          </div>
        </div>

        <div class="referral-stats-row">
          <div class="referral-stat">
            <div class="num">${s.totalReferred}</div>
            <div class="lbl">Total referred</div>
          </div>
          <div class="referral-stat">
            <div class="num">${s.totalSubscribed}</div>
            <div class="lbl">Subscribed</div>
          </div>
          <div class="referral-stat">
            <div class="num">${s.rewardsEarned}</div>
            <div class="lbl">Rewards earned</div>
          </div>
        </div>
      </div>
    </div>
  `;

  host.parentNode.insertBefore(wrap, host);
}

async function copyReferralLink() {
  if (!currentUser) return;
  try {
    const data = await fetchJSON(`${API_BASE}/user/referral/${currentUser._id}`);
    const link = `${location.origin}${location.pathname}?ref=${data.referralCode}`;
    const ok = await copyToClipboard(link);
    showToast(ok ? '✓ Referral link copied!' : 'Copy failed.', ok ? 'success' : 'error');
  } catch (e) { showToast('Could not copy link.', 'error'); }
}

async function openReferralDetailsModal() {
  if (!currentUser) return;
  let data;
  try {
    data = await fetchJSON(`${API_BASE}/user/referral/${currentUser._id}?_t=${Date.now()}`);
  } catch (e) { return showToast('Could not load referral details.', 'error'); }

  const s = data.stats || {};
  const p = data.program || {};
  const referred = data.referredUsers || [];

  const old = document.getElementById('referralDetailsModal');
  if (old) old.remove();

  const modal = document.createElement('div');
  modal.id = 'referralDetailsModal';
  modal.className = 'modal-overlay active';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:620px;">
      <h3><i class="fas fa-gift"></i> Referral Program</h3>
      <p class="modal-sub">Invite friends and unlock free premium time.</p>

      <div class="referral-info-banner">
        <div class="referral-info-icon"><i class="fas fa-trophy"></i></div>
        <div>
          <strong>${escapeHtml(p.rewardTitle)}</strong>
          <p>Refer <strong>${p.threshold}</strong> student${p.threshold === 1 ? '' : 's'} → get <strong>${p.rewardDays} days</strong> of premium, free.</p>
        </div>
      </div>

      <div class="referral-share-block">
        <label>Your referral code</label>
        <div class="referral-share-row">
          <input type="text" value="${escapeHtml(data.referralCode)}" readonly onclick="this.select()">
          <button class="btn btn-primary" onclick="copyReferralLink()"><i class="fas fa-copy"></i> Copy Link</button>
        </div>
      </div>

      <div class="referral-progress-large">
        <div class="referral-progress-bar">
          <div class="referral-progress-fill" style="width:${Math.min(100, Math.round((s.progressInCycle / Math.max(1, p.threshold)) * 100))}%"></div>
        </div>
        <div class="referral-progress-text">
          Next reward at <strong>${s.nextRewardAt}</strong> total referrals · You have <strong>${s.totalReferred}</strong>
        </div>
      </div>

      <h4 style="margin:18px 0 8px;font-size:14px;font-weight:700;">Students you've referred (${referred.length})</h4>
      ${referred.length === 0
        ? `<div class="empty-state" style="padding:20px;">
             <i class="fas fa-user-friends"></i>
             <p>No referrals yet — share your link to get started!</p>
           </div>`
        : `<div class="referral-list">
             ${referred.map(u => `
               <div class="referral-list-row">
                 <div class="referral-list-avatar">${escapeHtml(getInitials(u.fullName || u.username))}</div>
                 <div class="referral-list-info">
                   <strong>${escapeHtml(u.fullName || u.username)}</strong>
                   <span>@${escapeHtml(u.username)} · joined ${new Date(u.joinedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
                 </div>
                 ${u.isSubscribed
                   ? `<span class="referral-tag ok"><i class="fas fa-crown"></i> Premium</span>`
                   : `<span class="referral-tag">Free</span>`}
               </div>
             `).join('')}
           </div>`}

      <div class="modal-actions">
        <button class="btn btn-primary" onclick="document.getElementById('referralDetailsModal').remove()">
          <i class="fas fa-check"></i> Done
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

/* ============================================================
   Handle ?ref=CODE in URL — autofill register form
   ============================================================ */
function _consumeRefParam() {
  try {
    const params = new URLSearchParams(location.search);
    const ref = params.get('ref');
    if (!ref) return;
    const code = String(ref).toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30);
    if (!code) return;
    // Store for later use
    sessionStorage.setItem('aero_pending_ref', code);
    // If the login screen is showing, prompt the user
    const loginView = document.getElementById('loginView');
    if (loginView && loginView.classList.contains('active')) {
      setTimeout(() => {
        showToast(`🎁 You were invited with code ${code}. Register to get started!`, 'info');
      }, 700);
    }
  } catch (e) {}
}
_consumeRefParam();
window.addEventListener('popstate', _consumeRefParam);

/* ============================================================
   HOOKS — auto-run when pages render
   ============================================================ */
const _origRenderStudentHome = window.renderStudentHome;
window.renderStudentHome = function () {
  if (typeof _origRenderStudentHome === 'function') _origRenderStudentHome.apply(this, arguments);
  renderReferralCard();
  renderStudentSubscriptionBanner();
};

async function renderStudentSubscriptionBanner() {
  // Ensure plans are loaded
  if (!_livePlans || _livePlans.length === 0) await fetchSubscriptionPlans();

  const existing = document.getElementById('studentSubscriptionBannerHost');
  if (existing) existing.remove();

  if (!currentUser || currentUser.role !== 'student') return;
  if (!liveSubscriptionSettings.enabled) return;

  const host = document.getElementById('streakCardContainer');
  if (!host) return;

  const wrap = document.createElement('div');
  wrap.id = 'studentSubscriptionBannerHost';

  if (currentUser.isSubscribed) {
    const sub = currentUser.subscription || {};
    const exp = sub.expiresAt
      ? new Date(sub.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : '—';
    wrap.innerHTML = `
      <div class="subscribe-active-banner">
        <div class="subscribe-active-icon"><i class="fas fa-crown"></i></div>
        <div class="subscribe-active-info">
          <h4>${escapeHtml(sub.planTitle || 'Premium')} active</h4>
          <p>Renews on <strong>${exp}</strong> · ₹${sub.amount || 0}${sub.autoRenew ? ' · auto-renew on' : ''}</p>
        </div>
        <button class="btn btn-outline btn-sm" onclick="showMyPlanModal()">
          <i class="fas fa-info-circle"></i> Manage
        </button>
      </div>`;
  } else if (liveSubscriptionSettings.enabled && _livePlans.length > 0) {
    const cheapest = _livePlans.reduce((min, p) => (p.amount < min.amount ? p : min), _livePlans[0]);
    wrap.innerHTML = `
      <div class="subscribe-banner" style="cursor:pointer;" onclick="openPlansShowcaseModal()">
        <div class="subscribe-banner-icon"><i class="fas fa-bolt"></i></div>
        <div class="subscribe-banner-info">
          <h4>Unlock everything — from ₹${cheapest.amount}</h4>
          <p>Choose a plan that fits · flexible durations available</p>
        </div>
        <button class="btn btn-primary" onclick="event.stopPropagation();openPlansShowcaseModal()">
          <i class="fas fa-crown"></i> View Plans
        </button>
      </div>`;
  }

  if (wrap.innerHTML.trim()) {
    host.parentNode.insertBefore(wrap, host);
  }
}

function openPlansShowcaseModal() {
  let modal = document.getElementById('plansShowcaseModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'plansShowcaseModal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:960px;">
        <div class="modal-icon-header">
          <div class="modal-icon-tile tone-emerald" style="background:linear-gradient(135deg,#fbbf24,#f59e0b);color:#422006;">
            <i class="fas fa-crown"></i>
          </div>
          <div>
            <h3>Choose your premium plan</h3>
            <p class="modal-sub" style="margin:2px 0 0;">Unlock every course, every quiz, every material.</p>
          </div>
        </div>
        <div id="plansShowcaseGrid" style="margin-top:8px;"></div>
        <div class="modal-actions" style="margin-top:20px;">
          <button class="btn btn-outline" onclick="closeModal('plansShowcaseModal')">Close</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }
  renderSubscriptionPlansGrid('plansShowcaseGrid');
  openModal('plansShowcaseModal');
}

/* ============================================================
   ADMIN — Subscription Plans, Coupons, Referrals
   ============================================================ */

/* ----- Add admin tabs dynamically (only once) ----- */
(function ensureAdminTabs() {
  const tabsEl = document.querySelector('.admin-tabs');
  if (!tabsEl) return;
  if (tabsEl.querySelector('[data-tab="plans"]')) return;

  const tabsToAdd = [
    { id: 'plans',      icon: 'fa-crown',          label: 'Plans' },
    { id: 'coupons',    icon: 'fa-tag',            label: 'Coupons' },
    { id: 'referrals',  icon: 'fa-gift',           label: 'Referrals' }
  ];

  const anchor = tabsEl.querySelector('[data-tab="subscriptions"]');
  tabsToAdd.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'admin-tab';
    btn.dataset.tab = t.id;
    btn.setAttribute('onclick', `switchAdminTab('${t.id}')`);
    btn.innerHTML = `<i class="fas ${t.icon}"></i> ${t.label}`;
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    else tabsEl.appendChild(btn);
  });

  // Add content containers
  ['plans','coupons','referrals'].forEach(id => {
    if (document.getElementById('adminTab' + id.charAt(0).toUpperCase() + id.slice(1))) return;
    const c = document.createElement('div');
    c.className = 'admin-tab-content';
    c.id = 'adminTab' + id.charAt(0).toUpperCase() + id.slice(1);
    document.getElementById('adminView').appendChild(c);
  });
})();

/* ----- Intercept admin tab rendering ----- */
const _origUpdateAdminTabUI = window.updateAdminTabUI;
window.updateAdminTabUI = function () {
  if (typeof _origUpdateAdminTabUI === 'function') _origUpdateAdminTabUI.apply(this, arguments);

  // Extend title map for our new tabs
  if (adminTab === 'plans')      document.getElementById('adminPageTitle').innerHTML = '<i class="fas fa-crown"></i> Subscription Plans';
  if (adminTab === 'coupons')    document.getElementById('adminPageTitle').innerHTML = '<i class="fas fa-tag"></i> Coupon Codes';
  if (adminTab === 'referrals')  document.getElementById('adminPageTitle').innerHTML = '<i class="fas fa-gift"></i> Referral Program';
};

const _origRenderAdminDashboard = window.renderAdminDashboard;
window.renderAdminDashboard = function () {
  if (adminTab === 'plans')      return renderAdminPlans();
  if (adminTab === 'coupons')    return renderAdminCoupons();
  if (adminTab === 'referrals')  return renderAdminReferrals();
  if (typeof _origRenderAdminDashboard === 'function') _origRenderAdminDashboard.apply(this, arguments);
};

/* ---------------- ADMIN: PLANS TAB ---------------- */
async function renderAdminPlans() {
  const el = document.getElementById('adminTabPlans');
  if (!el) return;
  el.classList.add('active');
  el.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>Loading plans…</p></div>`;

  let plans = [];
  try {
    const data = await fetchJSON(`${API_BASE}/admin/subscription-plans?adminId=${currentUser._id}&t=${Date.now()}`);
    if (data.success) plans = data.plans || [];
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><p style="color:var(--rose-500);">${escapeHtml(e.message)}</p></div>`;
    return;
  }

  let html = `
    <div class="editor-section">
      <div class="editor-section-header">
        <div class="editor-section-title">
          <i class="fas fa-crown"></i> Subscription Plans
          <span style="font-size:12px;color:var(--text-tertiary);font-weight:500;margin-left:8px;">
            ${plans.length} plan${plans.length === 1 ? '' : 's'}
          </span>
        </div>
        <button class="btn btn-success" onclick="openCreatePlanModal()">
          <i class="fas fa-plus"></i> New Plan
        </button>
      </div>
      <p class="editor-hint">
        Create as many plans as you like — students will see them as pricing cards on the home page and subscription page.
        Each plan can have its own duration and price.
      </p>
    </div>
    <div class="admin-plans-grid">
  `;

  if (plans.length === 0) {
    html += `<div class="empty-state" style="grid-column:1/-1;"><i class="fas fa-crown"></i><p>No plans yet. Create one above.</p></div>`;
  } else {
    plans.forEach(p => {
      html += `
        <div class="admin-plan-card ${p.featured ? 'featured' : ''} ${p.enabled ? '' : 'disabled'}">
          <div class="admin-plan-card-head">
            ${p.badge ? `<span class="plan-badge">${escapeHtml(p.badge)}</span>` : ''}
            <div class="plan-title">${escapeHtml(p.title)}</div>
            <div class="plan-duration">${p.durationDays} days</div>
          </div>
          <div class="plan-price" style="margin:8px 0;">
            <span class="plan-currency">₹</span><span class="plan-amount">${p.amount}</span>
          </div>
          <p class="plan-desc">${escapeHtml(p.description || '')}</p>
          <div class="plan-status-row">
            <span class="status-badge ${p.enabled ? 'published' : 'draft'}">
              ${p.enabled ? 'ACTIVE' : 'DISABLED'}
            </span>
            ${p.featured ? '<span class="status-badge featured"><i class="fas fa-star"></i> FEATURED</span>' : ''}
          </div>
          <div class="plan-actions">
            <button class="btn btn-outline btn-sm" onclick="openEditPlanModal(${jsStr(p.id)})">
              <i class="fas fa-pen"></i> Edit
            </button>
            <button class="btn btn-outline btn-sm" onclick="togglePlanEnabled(${jsStr(p.id)}, ${!p.enabled})">
              <i class="fas fa-${p.enabled ? 'eye-slash' : 'eye'}"></i> ${p.enabled ? 'Disable' : 'Enable'}
            </button>
            <button class="btn btn-danger btn-sm" onclick="deleteAdminPlan(${jsStr(p.id)}, ${jsStr(p.title)})">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </div>
      `;
    });
  }
  html += `</div>`;
  el.innerHTML = html;
}

function openCreatePlanModal() {
  openPlanEditModal(null);
}
function openEditPlanModal(planId) {
  const plan = (_livePlans || []).find(p => p.id === planId);
  openPlanEditModal(planId);
}

async function openPlanEditModal(planId) {
  // Always fetch fresh
  let plans = [];
  try {
    const data = await fetchJSON(`${API_BASE}/admin/subscription-plans?t=${Date.now()}`);
    if (data.success) plans = data.plans || [];
  } catch (e) {}

  const plan = planId ? plans.find(p => p.id === planId) : null;

  let modal = document.getElementById('planEditModal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'planEditModal';
  modal.className = 'modal-overlay active';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:520px;">
      <h3><i class="fas fa-crown"></i> ${plan ? 'Edit Plan' : 'Create Plan'}</h3>
      <p class="modal-sub">${plan ? 'Update this subscription plan.' : 'Add a new subscription tier.'}</p>

      <form id="planEditForm" onsubmit="savePlanFromModal(event, ${jsStr(planId)})">
        <div class="form-group">
          <label>Plan Title *</label>
          <input type="text" id="planModalTitle" value="${escapeHtml(plan ? plan.title : '')}" maxlength="80" required>
        </div>
        <div class="form-group">
          <label>Description</label>
          <textarea id="planModalDesc" rows="2" maxlength="240">${escapeHtml(plan ? plan.description : '')}</textarea>
        </div>
        <div class="editor-grid-2">
          <div class="form-group">
            <label>Duration (days) *</label>
            <input type="number" id="planModalDays" value="${plan ? plan.durationDays : 30}" min="1" max="3650" required>
            <span class="hint">e.g. 30 (1M), 180 (6M), 365 (12M)</span>
          </div>
          <div class="form-group">
            <label>Price (₹) *</label>
            <input type="number" id="planModalAmount" value="${plan ? plan.amount : 499}" min="0" step="1" required>
          </div>
        </div>
        <div class="editor-grid-2">
          <div class="form-group">
            <label>Badge (optional)</label>
            <input type="text" id="planModalBadge" value="${escapeHtml(plan ? plan.badge : '')}" maxlength="30" placeholder="e.g. Popular, Best Value">
          </div>
          <div class="form-group">
            <label>Options</label>
            <label class="toggle-box" style="margin-top:6px;">
              <input type="checkbox" id="planModalFeatured" ${plan && plan.featured ? 'checked' : ''}>
              <span><i class="fas fa-star"></i> Featured</span>
            </label>
            <label class="toggle-box" style="margin-top:6px;">
              <input type="checkbox" id="planModalEnabled" ${!plan || plan.enabled ? 'checked' : ''}>
              <span><i class="fas fa-eye"></i> Enabled</span>
            </label>
          </div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-outline" onclick="document.getElementById('planEditModal').remove()">Cancel</button>
          <button type="submit" class="btn btn-primary" id="planEditSubmitBtn">
            <i class="fas fa-save"></i> ${plan ? 'Save Changes' : 'Create Plan'}
          </button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function savePlanFromModal(e, planId) {
  if (e) e.preventDefault();
  const payload = {
    title:        document.getElementById('planModalTitle').value.trim(),
    description:  document.getElementById('planModalDesc').value.trim(),
    durationDays: parseInt(document.getElementById('planModalDays').value, 10),
    amount:       Number(document.getElementById('planModalAmount').value),
    badge:        document.getElementById('planModalBadge').value.trim(),
    featured:     document.getElementById('planModalFeatured').checked,
    enabled:      document.getElementById('planModalEnabled').checked
  };
  if (!payload.title) return showToast('Title required.', 'error');
  if (!payload.durationDays || payload.durationDays < 1) return showToast('Duration must be at least 1 day.', 'error');
  if (!(payload.amount >= 0)) return showToast('Amount invalid.', 'error');

  const btn = document.getElementById('planEditSubmitBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }

  try {
    const url = planId
      ? `${API_BASE}/admin/subscription-plans/${planId}`
      : `${API_BASE}/admin/subscription-plans`;
    const method = planId ? 'PUT' : 'POST';

    const data = await fetchJSON(url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (data.success) {
      showToast('✅ Plan saved.', 'success');
      document.getElementById('planEditModal').remove();
      await fetchSubscriptionPlans();
      renderAdminPlans();
    } else {
      showToast(data.message || 'Failed.', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Server error.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Save'; }
  }
}

async function togglePlanEnabled(planId, enabled) {
  try {
    const data = await fetchJSON(`${API_BASE}/admin/subscription-plans/${planId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    if (data.success) {
      showToast(enabled ? 'Plan enabled.' : 'Plan disabled.', 'success');
      await fetchSubscriptionPlans();
      renderAdminPlans();
    } else showToast(data.message || 'Failed.', 'error');
  } catch (e) { showToast(e.message || 'Server error.', 'error'); }
}

async function deleteAdminPlan(planId, title) {
  if (!confirm(`Delete plan "${title}"? Students will no longer see it.`)) return;
  try {
    const data = await fetchJSON(`${API_BASE}/admin/subscription-plans/${planId}`, { method: 'DELETE' });
    if (data.success) {
      showToast('Plan deleted.', 'info');
      await fetchSubscriptionPlans();
      renderAdminPlans();
    } else showToast(data.message || 'Failed.', 'error');
  } catch (e) { showToast(e.message || 'Server error.', 'error'); }
}

/* ---------------- ADMIN: COUPONS TAB ---------------- */
async function renderAdminCoupons() {
  const el = document.getElementById('adminTabCoupons');
  if (!el) return;
  el.classList.add('active');
  el.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>Loading coupons…</p></div>`;

  let coupons = [];
  try {
    const data = await fetchJSON(`${API_BASE}/admin/coupons?t=${Date.now()}`);
    if (data.success) coupons = data.coupons || [];
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><p style="color:var(--rose-500);">${escapeHtml(e.message)}</p></div>`;
    return;
  }

  let html = `
    <div class="editor-section">
      <div class="editor-section-header">
        <div class="editor-section-title">
          <i class="fas fa-tag"></i> Coupon Codes
          <span style="font-size:12px;color:var(--text-tertiary);font-weight:500;margin-left:8px;">
            ${coupons.length} code${coupons.length === 1 ? '' : 's'}
          </span>
        </div>
        <button class="btn btn-success" onclick="openCreateCouponModal()">
          <i class="fas fa-plus"></i> New Coupon
        </button>
      </div>
      <p class="editor-hint">
        Each coupon gives a fixed percentage discount on any plan. Students enter the code at checkout.
        Coupons are one-time per purchase and can be limited by total uses or expiry date.
      </p>
    </div>
  `;

  if (coupons.length === 0) {
    html += `<div class="empty-state"><i class="fas fa-tag"></i><p>No coupons yet. Create your first one.</p></div>`;
  } else {
    html += `<div class="coupons-table"><table class="data-table">
      <thead>
        <tr>
          <th>Code</th>
          <th>Discount</th>
          <th>Uses</th>
          <th>Expires</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>`;

    coupons.forEach(c => {
      const usage = c.maxUses > 0 ? `${c.usedCount}/${c.maxUses}` : `${c.usedCount} / ∞`;
      const expires = c.expiresAt
        ? new Date(c.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
        : '—';
      const statusBadge = c.active ? '<span class="status-badge published">ACTIVE</span>' : '<span class="status-badge draft">DISABLED</span>';

      html += `
        <tr>
          <td><code class="coupon-code">${escapeHtml(c.code)}</code></td>
          <td><strong>${c.discountPercent}%</strong></td>
          <td>${usage}</td>
          <td>${expires}</td>
          <td>${statusBadge}</td>
          <td class="actions-cell">
            <button class="btn btn-outline btn-sm" onclick="copyToClipboard(${jsStr(c.code)}).then(ok=>showToast(ok?'Copied!':'Copy failed',ok?'success':'error'))" title="Copy code">
              <i class="fas fa-copy"></i>
            </button>
            <button class="btn btn-outline btn-sm" onclick="toggleCouponActive(${jsStr(c._id)}, ${!c.active})">
              <i class="fas fa-${c.active ? 'eye-slash' : 'eye'}"></i>
            </button>
            <button class="btn btn-danger btn-sm" onclick="deleteAdminCoupon(${jsStr(c._id)}, ${jsStr(c.code)})">
              <i class="fas fa-trash"></i>
            </button>
          </td>
        </tr>
      `;
    });

    html += `</tbody></table></div>`;
  }
  el.innerHTML = html;
}

function openCreateCouponModal() {
  let modal = document.getElementById('couponCreateModal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'couponCreateModal';
  modal.className = 'modal-overlay active';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:480px;">
      <h3><i class="fas fa-tag"></i> Create Coupon</h3>
      <p class="modal-sub">Generate a discount code for your students.</p>

      <form onsubmit="saveNewCoupon(event)">
        <div class="form-group">
          <label>Coupon Code *</label>
          <input type="text" id="couponCodeInput" maxlength="30" required
                 placeholder="e.g. WELCOME20"
                 style="text-transform:uppercase;font-family:ui-monospace,'SF Mono',monospace;font-weight:700;"
                 oninput="this.value = this.value.toUpperCase().replace(/[^A-Z0-9_-]/g,'')">
          <span class="hint">A–Z, 0–9, _ and - only. 3–30 characters.</span>
        </div>
        <div class="form-group">
          <label>Discount (%) *</label>
          <input type="number" id="couponPctInput" min="1" max="100" value="20" required>
        </div>
        <div class="form-group">
          <label>Description (optional)</label>
          <input type="text" id="couponDescInput" maxlength="200" placeholder="e.g. Welcome offer for new students">
        </div>
        <div class="editor-grid-2">
          <div class="form-group">
            <label>Max Uses</label>
            <input type="number" id="couponMaxUsesInput" min="0" value="0" placeholder="0 = unlimited">
            <span class="hint">0 = unlimited uses</span>
          </div>
          <div class="form-group">
            <label>Expires On</label>
            <input type="date" id="couponExpiresInput">
            <span class="hint">Leave empty for no expiry</span>
          </div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-outline" onclick="document.getElementById('couponCreateModal').remove()">Cancel</button>
          <button type="submit" class="btn btn-primary" id="couponSubmitBtn">
            <i class="fas fa-save"></i> Create Coupon
          </button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function saveNewCoupon(e) {
  if (e) e.preventDefault();
  const code = document.getElementById('couponCodeInput').value.trim().toUpperCase();
  const discountPercent = parseInt(document.getElementById('couponPctInput').value, 10);
  const description = document.getElementById('couponDescInput').value.trim();
  const maxUses = parseInt(document.getElementById('couponMaxUsesInput').value, 10) || 0;
  const expiresAt = document.getElementById('couponExpiresInput').value || null;

  if (!code || code.length < 3) return showToast('Code must be at least 3 characters.', 'error');
  if (!discountPercent || discountPercent < 1 || discountPercent > 100) return showToast('Discount must be 1–100.', 'error');

  const btn = document.getElementById('couponSubmitBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating…'; }

  try {
    const data = await fetchJSON(`${API_BASE}/admin/coupons`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, discountPercent, description, maxUses, expiresAt })
    });
    if (data.success) {
      showToast('✅ Coupon created.', 'success');
      document.getElementById('couponCreateModal').remove();
      renderAdminCoupons();
    } else showToast(data.message || 'Failed.', 'error');
  } catch (err) {
    showToast(err.message || 'Server error.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Create Coupon'; }
  }
}

async function toggleCouponActive(id, active) {
  try {
    const data = await fetchJSON(`${API_BASE}/admin/coupons/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active })
    });
    if (data.success) { showToast('Updated.', 'success'); renderAdminCoupons(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch (e) { showToast(e.message || 'Server error.', 'error'); }
}

async function deleteAdminCoupon(id, code) {
  if (!confirm(`Delete coupon "${code}"?`)) return;
  try {
    const data = await fetchJSON(`${API_BASE}/admin/coupons/${id}`, { method: 'DELETE' });
    if (data.success) { showToast('Coupon deleted.', 'info'); renderAdminCoupons(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch (e) { showToast(e.message || 'Server error.', 'error'); }
}

/* ---------------- ADMIN: REFERRALS TAB ---------------- */
async function renderAdminReferrals() {
  const el = document.getElementById('adminTabReferrals');
  if (!el) return;
  el.classList.add('active');
  el.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>Loading referrals…</p></div>`;

  let data;
  try {
    data = await fetchJSON(`${API_BASE}/admin/referrals?t=${Date.now()}`);
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><p style="color:var(--rose-500);">${escapeHtml(e.message)}</p></div>`;
    return;
  }

  const s = data.settings || {};
  const totals = data.totals || {};
  const referrers = data.referrers || [];

  let html = `
    <div class="editor-section">
      <div class="editor-section-title">
        <i class="fas fa-gift"></i> Referral Program Settings
      </div>
      <p class="editor-hint">
        Every student gets a unique code automatically. When a friend registers with that code, the referrer's count goes up.
        When the count hits the threshold, the student's premium is automatically extended.
      </p>

      <div class="sub-toggle-row" style="margin-bottom:14px;">
        <label>
          <input type="checkbox" id="refEnabledInput" ${s.enabled ? 'checked' : ''}>
          <span>Enable referral program</span>
        </label>
      </div>

      <div class="editor-grid-2">
        <div class="form-group">
          <label>Referral Threshold *</label>
          <input type="number" id="refThresholdInput" value="${s.threshold || 3}" min="1" max="100">
          <span class="hint">How many referrals needed per reward</span>
        </div>
        <div class="form-group">
          <label>Reward Duration (days) *</label>
          <input type="number" id="refRewardDaysInput" value="${s.rewardDays || 30}" min="1" max="3650">
          <span class="hint">Free premium days granted per reward</span>
        </div>
      </div>

      <div class="form-group">
        <label>Reward Title (shown to students)</label>
        <input type="text" id="refRewardTitleInput" value="${escapeHtml(s.rewardTitle || '')}" maxlength="80" placeholder="e.g. 1 Month Free Premium">
      </div>

      <div class="form-group">
        <label>Reward Description</label>
        <textarea id="refRewardDescInput" rows="2" maxlength="240">${escapeHtml(s.rewardDesc || '')}</textarea>
      </div>

      <div class="editor-footer" style="position:static;box-shadow:none;padding:14px 0 0;border:none;background:none;">
        <div class="editor-footer-left"></div>
        <div class="editor-footer-right">
          <button class="btn btn-primary" onclick="saveReferralSettings()">
            <i class="fas fa-save"></i> Save Settings
          </button>
        </div>
      </div>
    </div>

    <div class="editor-section">
      <div class="editor-section-header">
        <div class="editor-section-title">
          <i class="fas fa-chart-simple"></i> Program Overview
        </div>
      </div>
      <div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr));">
        <div class="stat-card">
          <div class="stat-icon tone-brand"><i class="fas fa-users"></i></div>
          <div class="stat-info">
            <div class="num">${totals.totalWithCode || 0}</div>
            <div class="label">Students with code</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon tone-emerald"><i class="fas fa-user-plus"></i></div>
          <div class="stat-info">
            <div class="num">${totals.totalReferred || 0}</div>
            <div class="label">Total referred</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon tone-gold"><i class="fas fa-trophy"></i></div>
          <div class="stat-info">
            <div class="num">${referrers.length}</div>
            <div class="label">Active referrers</div>
          </div>
        </div>
      </div>
    </div>

    <div class="editor-section">
      <div class="editor-section-header">
        <div class="editor-section-title">
          <i class="fas fa-ranking-star"></i> Top Referrers
        </div>
      </div>
  `;

  if (referrers.length === 0) {
    html += `<div class="empty-state"><i class="fas fa-users"></i><p>No referrals yet.</p></div>`;
  } else {
    html += `<div class="coupons-table"><table class="data-table">
      <thead>
        <tr>
          <th>Student</th>
          <th>Code</th>
          <th>Referred</th>
          <th>Subscribed</th>
          <th>Rewards</th>
          <th>Premium Until</th>
          <th></th>
        </tr>
      </thead>
      <tbody>`;

    referrers.forEach(r => {
      const exp = r.subscriptionExpiresAt
        ? new Date(r.subscriptionExpiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
        : '—';
      const premiumBadge = r.isSubscribed
        ? '<span class="status-badge published">PREMIUM</span>'
        : '<span class="status-badge draft">FREE</span>';

      html += `
        <tr>
          <td>
            <strong>${escapeHtml(r.fullName || r.username)}</strong>
            <div style="font-size:11.5px;color:var(--text-tertiary);">@${escapeHtml(r.username)}</div>
          </td>
          <td><code class="coupon-code">${escapeHtml(r.referralCode || '—')}</code></td>
          <td><strong>${r.totalReferred}</strong></td>
          <td>${r.totalSubscribed}</td>
          <td>${r.rewardsEarned}</td>
          <td>${exp} ${premiumBadge}</td>
          <td class="actions-cell">
            <button class="btn btn-success btn-sm" onclick="adminGrantReferralReward(${jsStr(r._id)}, ${jsStr(r.username)})" title="Grant manual reward">
              <i class="fas fa-gift"></i> Grant
            </button>
          </td>
        </tr>
      `;
    });

    html += `</tbody></table></div>`;
  }

  html += `</div>`;
  el.innerHTML = html;
}

async function saveReferralSettings() {
  const payload = {
    enabled:     document.getElementById('refEnabledInput').checked,
    threshold:   parseInt(document.getElementById('refThresholdInput').value, 10),
    rewardDays:  parseInt(document.getElementById('refRewardDaysInput').value, 10),
    rewardTitle: document.getElementById('refRewardTitleInput').value.trim(),
    rewardDesc:  document.getElementById('refRewardDescInput').value.trim()
  };
  if (!payload.threshold || payload.threshold < 1) return showToast('Threshold must be ≥ 1.', 'error');
  if (!payload.rewardDays || payload.rewardDays < 1) return showToast('Reward days must be ≥ 1.', 'error');

  try {
    const data = await fetchJSON(`${API_BASE}/admin/referral-settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (data.success) {
      showToast('✅ Referral settings saved.', 'success');
      renderAdminReferrals();
    } else showToast(data.message || 'Failed.', 'error');
  } catch (e) { showToast(e.message || 'Server error.', 'error'); }
}

async function adminGrantReferralReward(userId, username) {
  const days = prompt(`Grant how many days of free premium to @${username}?`, '30');
  if (days === null) return;
  const d = parseInt(days, 10);
  if (!d || d < 1) return showToast('Invalid number.', 'error');

  try {
    const data = await fetchJSON(`${API_BASE}/admin/referrals/${userId}/grant-reward`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: d })
    });
    if (data.success) { showToast(`✅ ${d} days granted to @${username}.`, 'success'); renderAdminReferrals(); }
    else showToast(data.message || 'Failed.', 'error');
  } catch (e) { showToast(e.message || 'Server error.', 'error'); }
}

/* ============================================================
   BOOT: load plans + program info
   ============================================================ */
(async function bootMonetizationModule() {
  try {
    await fetchSubscriptionPlans();
    // Auto-open the register form with ref if the URL had ?ref=CODE
    const pending = sessionStorage.getItem('aero_pending_ref');
    if (pending && !currentUser) {
      // Auto-open the register modal for convenience
      setTimeout(() => {
        if (typeof showRegisterModal === 'function') {
          try { showRegisterModal(); } catch (e) {}
          // Pre-fill hidden ref state on the register form
          const form = document.getElementById('registerForm');
          if (form && !document.getElementById('regReferralCode')) {
            const hidden = document.createElement('input');
            hidden.type = 'hidden';
            hidden.id = 'regReferralCode';
            hidden.value = pending;
            form.appendChild(hidden);
          }
        }
      }, 900);
    }
  } catch (e) { console.warn('[monetization boot]', e.message); }
})();

/* Patch registerStudent() to send the referral code */
const _origRegisterStudent = window.registerStudent;
window.registerStudent = function (e) {
  if (e && e.preventDefault) e.preventDefault();
  // Call original but inject referral code into tempRegisterData
  try {
    const code = (document.getElementById('regReferralCode')?.value ||
                  sessionStorage.getItem('aero_pending_ref') || '').trim().toUpperCase();
    const fullName = document.getElementById('regFullName')?.value.trim();
    const username = document.getElementById('regUsername')?.value.trim();
    const email    = document.getElementById('regEmail')?.value.trim();
    const phone    = document.getElementById('regPhone')?.value.trim();
    const password = document.getElementById('regPassword')?.value.trim();

    if (!fullName || !username || !password || !email || !phone) {
      return showToast('Please fill all fields.', 'error');
    }

    showToast('Sending OTP…', 'info');
    fetch(`${API_BASE}/send-otp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username, phone })
    }).then(r => r.json()).then(data => {
      if (data.success) {
        tempRegisterData = { fullName, username, email, phone, password, referralCode: code };
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
    }).catch(() => showToast('Server network error.', 'error'));
  } catch (err) {
    console.error('[registerStudent]', err);
    if (typeof _origRegisterStudent === 'function') _origRegisterStudent.call(this, e);
  }
};
function showMyPlanModal() {
  if (!currentUser || !currentUser.subscription) return;
  const sub = currentUser.subscription;
  const exp = sub.expiresAt
    ? new Date(sub.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
    : '—';
  const started = sub.startedAt
    ? new Date(sub.startedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
    : '—';

  const old = document.getElementById('myPlanModal');
  if (old) old.remove();

  const modal = document.createElement('div');
  modal.id = 'myPlanModal';
  modal.className = 'modal-overlay active';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:480px;">
      <div class="modal-icon-header">
        <div class="modal-icon-tile tone-emerald" style="background:linear-gradient(135deg,#fbbf24,#f59e0b);color:#422006;">
          <i class="fas fa-crown"></i>
        </div>
        <div>
          <h3>Your Premium Plan</h3>
          <p class="modal-sub" style="margin:2px 0 0;">Active subscription details</p>
        </div>
      </div>

      <div class="checkout-plan-summary">
        <div class="checkout-plan-row">
          <div>
            <strong>${escapeHtml(sub.planTitle || 'Premium')}</strong>
            <div class="checkout-plan-meta">
              <i class="fas fa-clock"></i> ${sub.planDurationDays || 30} days · ${sub.paymentMode === 'one-time' ? 'One-time' : 'Auto-renew'}
            </div>
          </div>
          <div class="checkout-plan-price">₹${sub.amount || 0}</div>
        </div>
        <p class="checkout-plan-desc">
          Started: <strong>${started}</strong><br>
          ${sub.paymentMode === 'subscription' ? 'Renews' : 'Expires'}: <strong>${exp}</strong>
        </p>
      </div>

      <div class="modal-actions">
        <button class="btn btn-outline" onclick="document.getElementById('myPlanModal').remove()">
          <i class="fas fa-times"></i> Close
        </button>
        ${sub.autoRenew
          ? `<button class="btn btn-danger" onclick="document.getElementById('myPlanModal').remove(); cancelSubscription();">
               <i class="fas fa-times-circle"></i> Cancel Auto-Pay
             </button>`
          : ''}
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}
/* ============================================================
   SUBJECTIVE ANSWER UPLOAD HELPERS
   ------------------------------------------------------------
   Students upload photos of their handwritten solutions during
   the proctored exam. We suppress the window-blur violation
   while the file picker is open (otherwise the OS dialog would
   trigger an auto-submit).
   ============================================================ */
async function handleSubjectiveUpload(qi, input) {
  const st = quizPlayerState;
  if (!st || st.submitted) return;

  const files = Array.from(input.files || []);
  if (files.length === 0) {
    window.__examAllowBlur = false;
    return;
  }

  if (!Array.isArray(st.answers[qi])) st.answers[qi] = [];

  for (const file of files) {
    if (!file.type.startsWith('image/')) {
      showToast(`"${file.name}" is not an image. Only JPG/PNG allowed.`, 'error');
      continue;
    }
    if (file.size > 10 * 1024 * 1024) {
      showToast(`"${file.name}" is too large (max 10 MB).`, 'error');
      continue;
    }

    // Insert placeholder so the student sees progress
    const placeholder = { url: '', fileName: file.name, uploading: true, progress: 0 };
    st.answers[qi].push(placeholder);
    renderSubjectiveUploads(qi);
    updateQuizQuestionCard(qi);
    updateQuizProgressUI();

    try {
      const result = await uploadFileToServer(file, pct => {
        placeholder.progress = pct;
        updateSubjectiveUploadProgress(qi, placeholder);
      });
      placeholder.url = result.url;
      placeholder.uploading = false;
      delete placeholder.progress;
      persistQuizAnswers();
      renderSubjectiveUploads(qi);
      updateQuizQuestionCard(qi);
      updateQuizProgressUI();
    } catch (err) {
      console.error('[subjective upload]', err);
      showToast('Upload failed: ' + err.message, 'error');
      const idx = st.answers[qi].indexOf(placeholder);
      if (idx >= 0) st.answers[qi].splice(idx, 1);
      renderSubjectiveUploads(qi);
    }
  }

  input.value = '';
  // Release the blur-grace flag after a short delay so any leftover
  // OS window transitions don't accidentally trigger a violation.
  setTimeout(() => { window.__examAllowBlur = false; }, 1500);
}

function renderSubjectiveUpload(u, qi, idx) {
  if (u.uploading) {
    return `
      <div class="subjective-upload-tile uploading" data-upload-idx="${idx}">
        <div class="subjective-upload-spinner"><i class="fas fa-spinner fa-spin"></i></div>
        <div class="subjective-upload-progress">
          <div class="subjective-upload-bar" style="width:${u.progress || 0}%"></div>
        </div>
        <div class="subjective-upload-name">${escapeHtml(u.fileName || 'Uploading…')}</div>
      </div>`;
  }
  return `
    <div class="subjective-upload-tile">
      <img src="${escapeHtml(u.url)}" alt="Solution" loading="lazy">
      <div class="subjective-upload-name">${escapeHtml(u.fileName || '')}</div>
      <button type="button" class="subjective-upload-remove" onclick="removeSubjectiveUpload(${qi}, ${idx})" title="Remove">
        <i class="fas fa-times"></i>
      </button>
    </div>`;
}

function renderSubjectiveUploads(qi) {
  const st = quizPlayerState;
  if (!st) return;
  const box = document.getElementById('subjectiveUploads-' + qi);
  if (!box) return;
  const list = Array.isArray(st.answers[qi]) ? st.answers[qi] : [];
  box.innerHTML = list.map((u, i) => renderSubjectiveUpload(u, qi, i)).join('');
}

function updateSubjectiveUploadProgress(qi, placeholder) {
  const st = quizPlayerState;
  if (!st) return;
  const box = document.getElementById('subjectiveUploads-' + qi);
  if (!box) return;
  const list = Array.isArray(st.answers[qi]) ? st.answers[qi] : [];
  const idx = list.indexOf(placeholder);
  if (idx < 0) return;
  const tile = box.querySelector(`.subjective-upload-tile[data-upload-idx="${idx}"]`);
  if (!tile) return;
  const bar = tile.querySelector('.subjective-upload-bar');
  if (bar) bar.style.width = (placeholder.progress || 0) + '%';
}

function removeSubjectiveUpload(qi, idx) {
  const st = quizPlayerState;
  if (!st || st.submitted) return;
  if (!Array.isArray(st.answers[qi])) return;
  if (!confirm('Remove this uploaded photo?')) return;
  st.answers[qi].splice(idx, 1);
  persistQuizAnswers();
  renderSubjectiveUploads(qi);
  updateQuizQuestionCard(qi);
  updateQuizProgressUI();
}

async function downloadContribution(contributionId, fileName) {
  try {
    showToast('Preparing download…', 'info');
    
    // The global fetch interceptor in app.js automatically attaches the Bearer token
    const res = await fetch(`${API_BASE}/admin/contributions/${contributionId}/download`);

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.message || 'Download failed.');
    }

    // Convert the response to a Blob and trigger native download
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'contribution';
    document.body.appendChild(a);
    a.click();
    
    // Cleanup
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 500);
    
    showToast('✅ Download started.', 'success');
  } catch (err) {
    console.error('[downloadContribution]', err);
    showToast(err.message || 'Network error while downloading.', 'error');
  }
}
/* ============================================================
   ════════════════════════════════════════════════════════════
   LIVE ACTIVITY HEARTBEAT — Real-Time Edition (client side)
   ════════════════════════════════════════════════════════════
   • Heartbeat every 20s + on navigation + on visibility change.
   • sendBeacon / fetch-keepalive on beforeunload → instant offline.
   • Admin panel subscribes to SSE — no polling while connected.
   • Auto-fallback to slow polling if SSE fails 3 times.
   ============================================================ */
let _activityHeartbeatTimer = null;
const ACTIVITY_HEARTBEAT_MS = 20000;   // was 45s — now faster for real-time

/* ---- Compute what the user is currently looking at ---- */
function computeActivityContext() {
  let currentPage = 'home';
  let courseId = null;
  let materialId = null;

  try {
    if (typeof quizEditingCourseId !== 'undefined' && quizEditingCourseId) {
      currentPage = 'admin-quiz-editor';
    } else if (typeof editingCourseId !== 'undefined' && editingCourseId) {
      currentPage = 'admin-editor';
    } else if (typeof addingCourse !== 'undefined' && addingCourse) {
      currentPage = 'admin-add-course';
    } else if (typeof addingProfessor !== 'undefined' && addingProfessor) {
      currentPage = 'admin-add-professor';
    } else if (typeof addingMaterialCourseId !== 'undefined' && addingMaterialCourseId) {
      currentPage = 'admin-add-material';
      courseId = addingMaterialCourseId;
    } else if (typeof addingStudent !== 'undefined' && addingStudent) {
      currentPage = 'admin-add-student';
    } else if (typeof currentCourseId !== 'undefined' && currentCourseId) {
      currentPage = 'course-detail';
      courseId = currentCourseId;
    } else if (typeof isAdmin === 'function' && isAdmin(currentUser)) {
      currentPage = 'admin-' + (adminTab || 'overview');
    } else {
      currentPage = 'student-' + (studentNav || 'home');
    }
  } catch (e) { /* never break the client */ }

  return { currentPage, courseId, materialId };
}

/* ---- Fire one heartbeat ---- */
async function sendActivityHeartbeat() {
  try {
    if (!currentUser || !currentUser._id) return;
    let token = null;
    try { token = sessionStorage.getItem('aero_token'); } catch (e) {}
    if (!token) return;

    const ctx = computeActivityContext();

    await fetch(`${API_BASE}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId:      currentUser._id,
        username:    currentUser.username,
        fullName:    currentUser.fullName || currentUser.username,
        role:        currentUser.role,
        currentPage: ctx.currentPage,
        courseId:    ctx.courseId,
        materialId:  ctx.materialId
      })
    });
  } catch (e) { /* silent */ }
}

function startActivityHeartbeat() {
  stopActivityHeartbeat();
  setTimeout(sendActivityHeartbeat, 700);
  _activityHeartbeatTimer = setInterval(sendActivityHeartbeat, ACTIVITY_HEARTBEAT_MS);
}

function stopActivityHeartbeat() {
  if (_activityHeartbeatTimer) {
    clearInterval(_activityHeartbeatTimer);
    _activityHeartbeatTimer = null;
  }
}

/* ---- Self-supervising start/stop every 5s ---- */
setInterval(() => {
  try {
    const hasSession = !!(currentUser && currentUser._id);
    if (hasSession && !_activityHeartbeatTimer && !_sessionKilled) {
      startActivityHeartbeat();
    } else if (!hasSession && _activityHeartbeatTimer) {
      stopActivityHeartbeat();
    }
  } catch (e) { /* silent */ }
}, 5000);

/* ---- Immediate heartbeat on visibility + navigation ---- */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentUser && currentUser._id) sendActivityHeartbeat();
});

window.addEventListener('hashchange', () => {
  if (!currentUser || !currentUser._id) return;
  clearTimeout(window.__activityNavDebounce);
  window.__activityNavDebounce = setTimeout(sendActivityHeartbeat, 300);
});

/* ---- Instant offline signal on tab close / navigate away ---- */
window.addEventListener('beforeunload', () => {
  try {
    if (!currentUser || !currentUser._id) return;
    const body = JSON.stringify({ userId: currentUser._id });
    fetch(`${API_BASE}/heartbeat/offline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true
    }).catch(() => {});
  } catch (e) {}
});

/* ============================================================
   ADMIN — Live Activity (SSE-driven, polling fallback)
   ============================================================ */
let _liveActivityES       = null;
let _liveActivityESFails  = 0;
let _liveActivityTimer    = null;   // polling fallback only
let _liveActivityData     = null;

async function renderAdminLiveActivity() {
  /* ---- Ensure the container exists ---- */
  let container = document.getElementById('adminTabLive');
  if (!container) {
    const adminView = document.getElementById('adminView');
    if (!adminView) return;
    container = document.createElement('div');
    container.id = 'adminTabLive';
    container.className = 'admin-tab-content';
    adminView.appendChild(container);
  }

  /* ---- Ensure it's the active tab content ---- */
  if (!container.classList.contains('active')) {
    document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
    container.classList.add('active');
  }

  /* ---- Header ---- */
  const titleEl = document.getElementById('adminPageTitle');
  if (titleEl) titleEl.innerHTML = '<i class="fas fa-signal"></i> Live Activity';

  const actionsEl = document.getElementById('adminHeaderActions');
  if (actionsEl) {
    actionsEl.innerHTML =
      '<span class="live-activity-pill" id="liveActivityPill">' +
        '<span class="live-pulse-dot"></span> <span id="liveActivityStatus">Connecting…</span>' +
      '</span>' +
      '<button class="btn btn-outline" onclick="fetchAndRenderLiveActivity()">' +
        '<i class="fas fa-rotate"></i> <span class="btn-text">Refresh Now</span>' +
      '</button>';
  }

  /* ---- Skeleton on first mount ---- */
  if (!container.querySelector('.live-activity-wrap')) {
    container.innerHTML = `
      <div class="live-activity-wrap">
        <div class="live-stats-row" id="liveStatsRow">
          <div class="live-stat-card">
            <div class="live-stat-icon tone-emerald"><i class="fas fa-signal"></i></div>
            <div class="live-stat-body">
              <div class="live-stat-num">—</div>
              <div class="live-stat-lbl">Loading…</div>
            </div>
          </div>
        </div>
        <div class="live-list" id="liveList">
          <div class="live-empty">
            <i class="fas fa-spinner fa-spin"></i>
            <p>Connecting to live stream…</p>
          </div>
        </div>
      </div>`;
  }

  /* ---- Open SSE stream (server sends snapshot immediately) ---- */
  openLiveActivityStream();

  /* ---- Safety net: if no data in 3s, do a one-shot fetch ---- */
  setTimeout(() => {
    if (!_liveActivityData) fetchAndRenderLiveActivity();
  }, 3000);
}

/* ---- SSE connection ---- */
function openLiveActivityStream() {
  closeLiveActivityStream();
  try {
    const token = sessionStorage.getItem('aero_token');
    if (!token) { startLiveActivityPolling(); return; }

    const url = `${API_BASE}/admin/online-users/stream?auth=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    _liveActivityES = es;

    es.onopen = () => {
      _liveActivityESFails = 0;
      setLiveStatus('Live', true);
    };

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data && data.success) {
          _liveActivityData = data;
          renderLiveActivityData(data);
        }
      } catch (e) { /* silent */ }
    };

    es.onerror = () => {
      _liveActivityESFails++;
      setLiveStatus('Reconnecting…', false);
      if (_liveActivityESFails >= 3) {
        closeLiveActivityStream();
        startLiveActivityPolling();
      }
      /* EventSource auto-reconnects on transient errors — no action needed */
    };
  } catch (e) {
    startLiveActivityPolling();
  }
}

function closeLiveActivityStream() {
  if (_liveActivityES) {
    try { _liveActivityES.close(); } catch (e) {}
    _liveActivityES = null;
  }
}

function startLiveActivityPolling() {
  if (_liveActivityTimer) return;
  setLiveStatus('Polling', false);
  _liveActivityTimer = setInterval(() => {
    const c = document.getElementById('adminTabLive');
    if (!c || !c.classList.contains('active')) {
      clearInterval(_liveActivityTimer);
      _liveActivityTimer = null;
      return;
    }
    if (document.hidden) return;
    fetchAndRenderLiveActivity();
  }, 5000);
  fetchAndRenderLiveActivity();
}

function setLiveStatus(label, isLive) {
  const el = document.getElementById('liveActivityStatus');
  const pill = document.getElementById('liveActivityPill');
  if (el) el.textContent = label;
  if (pill) pill.classList.toggle('is-live', !!isLive);
}

/* ---- One-shot fetch (used by Refresh button + fallback) ---- */
async function fetchAndRenderLiveActivity() {
  try {
    const data = await fetchJSON(`${API_BASE}/admin/online-users?_t=${Date.now()}`);
    if (!data.success) throw new Error(data.message || 'Could not load.');
    _liveActivityData = data;
    renderLiveActivityData(data);
  } catch (err) {
    const list = document.getElementById('liveList');
    if (list) {
      list.innerHTML = `
        <div class="live-empty" style="border-color: var(--rose-500);">
          <i class="fas fa-triangle-exclamation" style="color: var(--rose-500);"></i>
          <p style="color: var(--rose-500); font-weight: 600;">Could not load live activity</p>
          <p style="margin-top: 6px; font-size: 12.5px; color: var(--text-tertiary);">${escapeHtml(err.message || 'Unknown error')}</p>
          <button class="btn btn-outline btn-sm" style="margin-top: 12px;" onclick="fetchAndRenderLiveActivity()">
            <i class="fas fa-rotate"></i> Retry
          </button>
        </div>`;
    }
  }
}

/* ---- Render (identical to before, plus a live "age" re-tick) ---- */
function renderLiveActivityData(data) {
  const statsRow = document.getElementById('liveStatsRow');
  const list     = document.getElementById('liveList');
  if (!statsRow || !list) return;

  const c        = data.counts || {};
  const users    = data.users  || [];
  const students = users.filter(u => u.role === 'student');

  const clock = new Date().toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  statsRow.innerHTML = `
    <div class="live-stat-card">
      <div class="live-stat-icon tone-emerald"><i class="fas fa-signal"></i></div>
      <div class="live-stat-body">
        <div class="live-stat-num">${c.students || 0}</div>
        <div class="live-stat-lbl">Students Online</div>
      </div>
    </div>
    <div class="live-stat-card">
      <div class="live-stat-icon tone-brand"><i class="fas fa-users"></i></div>
      <div class="live-stat-body">
        <div class="live-stat-num">${c.total || 0}</div>
        <div class="live-stat-lbl">Total Sessions</div>
      </div>
    </div>
    <div class="live-stat-card">
      <div class="live-stat-icon tone-gold"><i class="fas fa-book-open-reader"></i></div>
      <div class="live-stat-body">
        <div class="live-stat-num">${c.studying || 0}</div>
        <div class="live-stat-lbl">Actively Studying</div>
      </div>
    </div>
    <div class="live-stat-card">
      <div class="live-stat-icon tone-cyan"><i class="fas fa-clock"></i></div>
      <div class="live-stat-body">
        <div class="live-stat-num" style="font-size:18px;letter-spacing:0;">${clock}</div>
        <div class="live-stat-lbl">Last Updated</div>
      </div>
    </div>
  `;

  if (students.length === 0) {
    list.innerHTML = `
      <div class="live-empty">
        <i class="fas fa-user-slash"></i>
        <p>No students online right now.</p>
        <p style="margin-top: 6px; font-size: 12.5px; color: var(--text-tertiary);">
          Updates are pushed live — no refresh needed.
        </p>
      </div>`;
    return;
  }

  const PAGE_LABELS = {
    'home':                'Home',
    'courses':             'Browsing courses',
    'analytics':           'Analytics dashboard',
    'saved':               'Saved courses',
    'ai':                  'AI Doubt Solver',
    'course-detail':       'Studying',
    'student-home':        'Home',
    'student-courses':     'Browsing courses',
    'student-analytics':   'Analytics dashboard',
    'student-saved':       'Saved courses',
    'student-ai':          'AI Doubt Solver',
    'admin-overview':      'Admin · Overview',
    'admin-courses':       'Admin · Courses',
    'admin-editor':        'Admin · Editing a course',
    'admin-students':      'Admin · Students',
    'admin-live':          'Admin · Live Activity'
  };

  let html = '';
  students.forEach(u => {
    const initials = String(u.fullName || u.username || '?')
      .split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

    const secondsAgo = Math.max(0, Math.round((Date.now() - u.lastSeen) / 1000));
    const sinceText =
      secondsAgo < 15 ? 'just now' :
      secondsAgo < 60 ? secondsAgo + 's ago' :
      Math.round(secondsAgo / 60) + 'm ago';

    const isStudying = !!u.courseId;

    let activityHtml = `<span class="live-activity-label">${escapeHtml(PAGE_LABELS[u.currentPage] || u.currentPage)}</span>`;
    if (u.courseName) {
      activityHtml = `<strong>${escapeHtml(u.courseName)}</strong>`;
      if (u.courseCode) {
        activityHtml += ` <span class="live-activity-code">· ${escapeHtml(u.courseCode)}</span>`;
      }
      if (u.materialTitle) {
        activityHtml += `<span class="live-activity-material"><i class="fas fa-book-open"></i> ${escapeHtml(u.materialTitle)}</span>`;
      }
    }

    html += `
      <div class="live-user-row${isStudying ? ' studying' : ''}">
        <div class="live-user-avatar">${escapeHtml(initials)}</div>
        <div class="live-user-info">
          <div class="live-user-name">
            ${escapeHtml(u.fullName || u.username)}
            <span class="live-user-handle">@${escapeHtml(u.username)}</span>
            ${isStudying ? '<span class="live-user-badge"><i class="fas fa-fire"></i> Studying</span>' : ''}
          </div>
          <div class="live-user-activity">${activityHtml}</div>
        </div>
        <div class="live-user-seen" data-last-seen="${u.lastSeen}">${sinceText}</div>
      </div>`;
  });
  list.innerHTML = html;
}

/* ---- Re-tick the "Xs ago" labels every 5s so they stay fresh ---- */
setInterval(() => {
  const container = document.getElementById('adminTabLive');
  if (!container || !container.classList.contains('active')) return;
  const now = Date.now();
  container.querySelectorAll('.live-user-seen[data-last-seen]').forEach(el => {
    const lastSeen = parseInt(el.dataset.lastSeen, 10);
    if (!lastSeen) return;
    const s = Math.max(0, Math.round((now - lastSeen) / 1000));
    el.textContent =
      s < 15 ? 'just now' :
      s < 60 ? s + 's ago' :
      Math.round(s / 60) + 'm ago';
  });
}, 5000);

/* ============================================================
   ROUTING WATCHER — MutationObserver on #adminTabLive
   ============================================================ */
(function installLiveActivityWatcher() {
  const boot = () => {
    let el = document.getElementById('adminTabLive');
    if (!el) {
      const adminView = document.getElementById('adminView');
      if (adminView) {
        el = document.createElement('div');
        el.id = 'adminTabLive';
        el.className = 'admin-tab-content';
        adminView.appendChild(el);
      }
    }
    if (!el) return;

    let wasActive = false;

    const activate = () => {
      setTimeout(() => {
        if (typeof renderAdminLiveActivity === 'function') {
          renderAdminLiveActivity().catch(err =>
            console.warn('[Live Activity] render failed:', err)
          );
        }
      }, 30);
    };

    const deactivate = () => {
      closeLiveActivityStream();
      if (_liveActivityTimer) {
        clearInterval(_liveActivityTimer);
        _liveActivityTimer = null;
      }
    };

    const obs = new MutationObserver(() => {
      const isActive = el.classList.contains('active');
      if (isActive && !wasActive) { wasActive = true;  activate(); }
      else if (!isActive && wasActive) { wasActive = false; deactivate(); }
    });
    obs.observe(el, { attributes: true, attributeFilter: ['class'] });

    if (el.classList.contains('active')) {
      wasActive = true;
      setTimeout(activate, 200);
    }

    let coldChecks = 0;
    const coldTimer = setInterval(() => {
      coldChecks++;
      const active = el.classList.contains('active');
      if (active && !wasActive) {
        wasActive = true;
        activate();
        clearInterval(coldTimer);
      } else if (coldChecks > 30) {
        clearInterval(coldTimer);
      }
    }, 200);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

/* ============================================================
   END Live Activity block
   ============================================================ */
/* ============================================================
   MOBILE BOTTOM NAVIGATION
   ============================================================ */
function mobileNavGo(dest) {
  if (typeof navigateStudent === 'function') {
    navigateStudent(dest);
  }
  updateMobileNavActive();
  try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) {}
}

function updateMobileNavActive() {
  const nav = document.getElementById('mobileBottomNav');
  if (!nav) return;

  // Show only for logged-in students
  const shouldShow = !!(currentUser && !isAdmin(currentUser));
  nav.style.display = shouldShow ? '' : 'none';
  if (!shouldShow) return;

  let active = studentNav || 'home';
  if (currentCourseId) active = '';   // in course detail — no tab active
  if (studentNav === 'ai') active = 'ai';

  nav.querySelectorAll('.mbn-item').forEach(item => {
    item.classList.toggle('active', item.dataset.nav === active);
  });

  const savedCount = (currentUser.bookmarks || []).length;
  const badge = document.getElementById('mbnSavedBadge');
  if (badge) {
    if (savedCount > 0) {
      badge.textContent = savedCount > 9 ? '9+' : savedCount;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }
}

/* Auto-update active state whenever the app renders */
(function hookMobileNavToRender() {
  if (typeof window._renderAppNow === 'function') {
    const orig = window._renderAppNow;
    window._renderAppNow = function () {
      orig.apply(this, arguments);
      setTimeout(updateMobileNavActive, 0);
    };
  }
  if (typeof window.renderApp === 'function') {
    const orig = window.renderApp;
    window.renderApp = function () {
      orig.apply(this, arguments);
      setTimeout(updateMobileNavActive, 60);
    };
  }
})();

   initApp();