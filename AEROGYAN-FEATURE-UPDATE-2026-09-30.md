# AeroGyan Education — Feature Update

**Prepared:** 30 September 2026  
**Target:** live site (`server.js` + `app.js` + `index.html` + `landing.html` + `styles.css` + `sw.js` + `manifest.json` + icon assets)  
**Safety model:** every edit is additive or a like-for-like replacement. No existing selector, route, API contract or DB schema was removed or renamed.

---

## 0. What was delivered

| # | Feature | Files touched |
|---|---------|---------------|
| 1 | 10-minute inactivity auto-logout with on-screen warning + countdown | `app.js`, `styles.css` |
| 2 | Custom favicon — aircraft on an Indian tricolour circle, `AeroGyan Education` wrapping the border | `favicon.svg` (new) + 9 regenerated PNGs, `index.html`, `landing.html`, `server.js`, `sw.js`, `manifest.json` |
| 3 | Premium access control — search/filter students in the management dashboard and grant premium access directly | `server.js`, `index.html`, `app.js`, `styles.css` |
| 4 | Live-server safety — backups, syntax checks, 58 automated assertions, exact replacement format | this document + external backup dir |

---

## 1. Safety baseline (do this first)

A timestamped backup of every modified file already exists **outside the deployable tree** (so it can never be accidentally shipped to the live server):

```
/Users/Programming Content/_AeroGyan-Safety-Backups/20260930-114050/
  app.js  index.html  landing.html  manifest.json
  server.js  styles.css  sw.js
```

To restore everything:

```bash
cd "/Users/Programming Content/Aerospace Portal IIT KGP"
cp /Users/Programming Content/_AeroGyan-Safety-Backups/20260930-114050/{app.js,index.html,landing.html,manifest.json,server.js,styles.css,sw.js} .
```

### Checksums of the new versions

| file | bytes | sha256 (first 16) |
|------|-------|-------------------|
| `server.js` | 369137 | `6fd2693110567e7a` |
| `app.js` | 646618 | `6d4081819daf88d8` |
| `index.html` | 78888 | `03c2aa32f83b5c6a` |
| `landing.html` | 149005 | `dd35af98f0aadcc7` |
| `styles.css` | 338754 | `9ab74add0de1bd85` |
| `sw.js` | 3174 | `078cc2cdd972f7ae` |
| `manifest.json` | 1313 | `9fc9eedce47bf259` |
| `favicon.svg` | 3190 | `98740b9ebc7213ee` |
| `favicon-16.png` | 949 | `8f0f842674908b8a` |
| `favicon-32.png` | 3041 | `1f7c43797aac03d1` |
| `favicon-48.png` | 5793 | `20de88712d29a3c8` |
| `favicon-96.png` | 15667 | `41e9032241bd5229` |
| `apple-touch-icon.png` | 37539 | `49a2541bf95e6499` |
| `icon-192.png` | 40047 | `784153fe8cade067` |
| `icon-256.png` | 58141 | `468eddb675602d09` |
| `icon-384.png` | 97687 | `313ad4848120be6b` |
| `icon-512.png` | 137960 | `06f7c875168b42a8` |

---
---

## 2. FEATURE 1 — 10-minute inactivity auto-logout

**Behaviour:** after 9 minutes of no mouse/keyboard/touch/scroll activity an overlay appears with a live 60-second countdown; any activity (or the *Stay Signed In* button) dismisses it and restarts the full 10-minute window; at 10 minutes the existing `logout()` path runs and the user is told why.

### 2.1 `app.js` — hook the watch into the session lifecycle

**REPLACE** inside `startSessionHeartbeat()` (currently near line 1067):

**Before**

````js
function startSessionHeartbeat() {
  stopSessionHeartbeat();
  _sessionKilled = false;
  _lastSessionCheck = 0;

  // First check shortly after login, so any immediate device clash is caught
````

**After**

````js
function startSessionHeartbeat() {
  stopSessionHeartbeat();
  _sessionKilled = false;
  _lastSessionCheck = 0;

  /* ⭐ Start the 10-minute inactivity auto-logout with the session */
  try { startInactivityWatch(); } catch (e) { console.error('[inactivity] start failed:', e); }

  // First check shortly after login, so any immediate device clash is caught
````

**REPLACE** inside `stopSessionHeartbeat()` (currently near line 1097):

**Before**

````js
function stopSessionHeartbeat() {
  if (_sessionHeartbeatTimer) {
    clearTimeout(_sessionHeartbeatTimer);
    _sessionHeartbeatTimer = null;
  }
}
````

**After**

````js
function stopSessionHeartbeat() {
  if (_sessionHeartbeatTimer) {
    clearTimeout(_sessionHeartbeatTimer);
    _sessionHeartbeatTimer = null;
  }
  /* ⭐ Never leave the inactivity countdown running after logout */
  try { stopInactivityWatch(); } catch (e) {}
}
````

> Why this hook: `startSessionHeartbeat()` is already called by all three login paths (lines ~2497, ~2818, ~11302) and `stopSessionHeartbeat()` by every logout/stale-session route — so the watch can never run while logged out.

### 2.2 `app.js` — ADD the watch module

**Insert immediately BEFORE** the line `/* ============================================================` that starts the `STALE SESSION HANDLER` block (i.e. directly after the `window.addEventListener('online', ...)` block, currently near line 1170):

````js
const INACTIVITY_LIMIT_MS = 10 * 60 * 1000;   // 10 minutes → logout
const INACTIVITY_WARN_MS  = 60 * 1000;        // warning shows 60s before

let _inactivityWarnTimer  = null;
let _inactivityOutTimer   = null;
let _inactivityCountdown  = null;   // 1s interval that drives the counter
let _inactivityRunning    = false;
let _inactivityLoggingOut = false;
let _lastActivityReset    = 0;

function startInactivityWatch() {
  stopInactivityWatch();
  if (!currentUser) return;
  _inactivityRunning = true;
  _inactivityLoggingOut = false;
  _lastActivityReset = Date.now();
  _armInactivityTimers();
}

function stopInactivityWatch() {
  _inactivityRunning = false;
  _inactivityLoggingOut = false;
  if (_inactivityWarnTimer) { clearTimeout(_inactivityWarnTimer); _inactivityWarnTimer = null; }
  if (_inactivityOutTimer)  { clearTimeout(_inactivityOutTimer);  _inactivityOutTimer  = null; }
  hideInactivityWarning();
}

function _armInactivityTimers() {
  if (_inactivityWarnTimer) { clearTimeout(_inactivityWarnTimer); _inactivityWarnTimer = null; }
  if (_inactivityOutTimer)  { clearTimeout(_inactivityOutTimer);  _inactivityOutTimer  = null; }

  /* ① Warning at 9 minutes */
  _inactivityWarnTimer = setTimeout(() => {
    _inactivityWarnTimer = null;
    if (!_inactivityRunning || !currentUser || _inactivityLoggingOut) return;
    showInactivityWarning();
  }, INACTIVITY_LIMIT_MS - INACTIVITY_WARN_MS);

  /* ② Hard logout at 10 minutes */
  _inactivityOutTimer = setTimeout(() => {
    _inactivityOutTimer = null;
    if (!_inactivityRunning || !currentUser || _inactivityLoggingOut) return;

    _inactivityLoggingOut = true;
    stopInactivityWatch();

    try {
      logout();                     // existing, well-tested logout path
    } catch (e) {
      console.error('[inactivity] logout threw:', e);
    }

    if (typeof showToast === 'function') {
      showToast('You were signed out after 10 minutes of inactivity.', 'info');
    }
  }, INACTIVITY_LIMIT_MS);
}

/* Any real user action resets the clock (throttled to 1/second). */
function _noteUserActivity() {
  if (!_inactivityRunning || !currentUser || _inactivityLoggingOut) return;

  const now = Date.now();
  if (now - _lastActivityReset < 1000) return;
  _lastActivityReset = now;

  if (document.getElementById('inactivityWarning')) hideInactivityWarning();
  _armInactivityTimers();
}

['mousedown', 'mousemove', 'click', 'keydown', 'scroll', 'wheel',
 'touchstart', 'touchmove', 'pointerdown'].forEach(evt => {
  document.addEventListener(evt, _noteUserActivity, { passive: true, capture: true });
});

/* Returning to the tab / window counts as activity too */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) _noteUserActivity();
});
window.addEventListener('focus', _noteUserActivity);

/* ---- On-screen warning overlay (built in JS — no markup dependency) ---- */
function showInactivityWarning() {
  if (document.getElementById('inactivityWarning')) return;

  const totalSeconds = Math.round(INACTIVITY_WARN_MS / 1000);

  const el = document.createElement('div');
  el.id = 'inactivityWarning';
  el.className = 'inactivity-overlay';
  el.setAttribute('role', 'alertdialog');
  el.setAttribute('aria-live', 'assertive');
  el.innerHTML = `
    <div class="inactivity-card">
      <div class="inactivity-icon"><i class="fas fa-hourglass-half"></i></div>
      <h3>Are you still there?</h3>
      <p>You&rsquo;ve been inactive for a while. For your security you&rsquo;ll be signed out in</p>
      <div class="inactivity-count" id="inactivityCount">${totalSeconds}</div>
      <p class="inactivity-hint">Move the mouse, tap the screen, or press any key to stay signed in.</p>
      <div class="inactivity-actions">
        <button type="button" class="btn btn-primary" onclick="staySignedIn()">
          <i class="fas fa-hand"></i> Stay Signed In
        </button>
      </div>
    </div>`;

  document.body.appendChild(el);

  let remaining = totalSeconds;
  const countEl = el.querySelector('#inactivityCount');
  if (countEl) countEl.textContent = String(remaining);

  if (_inactivityCountdown) { clearInterval(_inactivityCountdown); _inactivityCountdown = null; }
  _inactivityCountdown = setInterval(() => {
    remaining -= 1;
    const c = document.getElementById('inactivityCount');
    if (c) c.textContent = String(Math.max(remaining, 0));
    if (remaining <= 0) {
      clearInterval(_inactivityCountdown);
      _inactivityCountdown = null;
    }
  }, 1000);
}

function hideInactivityWarning() {
  if (_inactivityCountdown) { clearInterval(_inactivityCountdown); _inactivityCountdown = null; }
  const el = document.getElementById('inactivityWarning');
  if (el) el.remove();
}

/* Explicit "Stay Signed In" button — also counts as activity. */
function staySignedIn() {
  _lastActivityReset = 0;     // bypass the 1-second throttle
  _noteUserActivity();
  if (typeof showToast === 'function') {
    showToast('Welcome back — your session has been extended.', 'success');
  }
}
````

> Tuning is at the top of the block: `INACTIVITY_LIMIT_MS = 10 * 60 * 1000` and `INACTIVITY_WARN_MS = 60 * 1000`.

### 2.3 `styles.css` — APPEND

Add to the end of `styles.css`:

````css
/* ============================================================
   ⭐ 10-MINUTE INACTIVITY WARNING OVERLAY
   Sits above every modal (max modal z-index is 3000) but below
   the toast stack (9999), so the "signed out" toast is visible.
   ============================================================ */
.inactivity-overlay {
  position: fixed;
  inset: 0;
  z-index: 9500;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(7,11,26,.62);
  backdrop-filter: blur(7px);
  -webkit-backdrop-filter: blur(7px);
  animation: inactivityFadeIn .22s var(--ease-out) both;
}
@keyframes inactivityFadeIn { from { opacity: 0 } to { opacity: 1 } }

.inactivity-card {
  width: 100%;
  max-width: 400px;
  padding: 30px 26px 26px;
  text-align: center;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-xl);
  animation: inactivityPop .3s var(--ease-spring) both;
}
@keyframes inactivityPop {
  from { opacity: 0; transform: translateY(14px) scale(.96) }
  to   { opacity: 1; transform: translateY(0)    scale(1)   }
}

.inactivity-icon {
  width: 62px; height: 62px;
  margin: 0 auto 16px;
  display: flex; align-items: center; justify-content: center;
  font-size: 25px;
  color: #fff;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--gold-400), var(--gold-600));
  box-shadow: 0 10px 26px rgba(245,158,11,.38);
  animation: inactivityPulse 1.9s var(--ease) infinite;
}
@keyframes inactivityPulse {
  0%, 100% { transform: scale(1);    box-shadow: 0 10px 26px rgba(245,158,11,.38) }
  50%      { transform: scale(1.07); box-shadow: 0 14px 34px rgba(245,158,11,.55) }
}

.inactivity-card h3 {
  font-size: 18.5px;
  font-weight: 800;
  letter-spacing: -.3px;
  color: var(--text-primary);
  margin-bottom: 8px;
}
.inactivity-card p {
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.inactivity-count {
  margin: 14px auto;
  font-size: 46px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: -2px;
  font-variant-numeric: tabular-nums;
  color: var(--gold-500);
  text-shadow: 0 2px 18px rgba(245,158,11,.35);
}
[data-theme="dark"] .inactivity-count,
[data-theme="dim"]  .inactivity-count { color: var(--gold-400); }

.inactivity-hint {
  font-size: 12.5px !important;
  color: var(--text-tertiary) !important;
  margin-bottom: 20px;
}
.inactivity-actions { display: flex; justify-content: center; }
.inactivity-actions .btn { min-width: 190px; justify-content: center; }

@media (prefers-reduced-motion: reduce) {
  .inactivity-overlay,
  .inactivity-card,
  .inactivity-icon { animation: none; }
}
````

---

## 3. FEATURE 2 — Custom favicon (aircraft · Indian tricolour · circular border text)

### 3.1 NEW FILE `favicon.svg` (master vector — the single source of truth)

````xml
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="AeroGyan Education">
  <title>AeroGyan Education</title>

  <defs>
    <!-- Annulus that clips the tricolour bands into a ring -->
    <mask id="agRingMask">
      <circle cx="256" cy="256" r="172" fill="none" stroke="#ffffff" stroke-width="40"/>
    </mask>

    <!-- Soft saffron / green wash behind the aircraft -->
    <linearGradient id="agWash" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0"    stop-color="#FF9933" stop-opacity="0.20"/>
      <stop offset="0.40" stop-color="#FFFFFF" stop-opacity="0"/>
      <stop offset="0.60" stop-color="#FFFFFF" stop-opacity="0"/>
      <stop offset="1"    stop-color="#138808" stop-opacity="0.20"/>
    </linearGradient>
    <clipPath id="agInnerClip"><circle cx="256" cy="256" r="150"/></clipPath>
  </defs>

  <!-- 1 · Outer white disc + navy border -->
  <circle cx="256" cy="256" r="254" fill="#ffffff"/>
  <circle cx="256" cy="256" r="251" fill="none" stroke="#000080" stroke-width="6"/>

  <!-- 2 · Indian tricolour ring -->
  <g mask="url(#agRingMask)">
    <rect x="0" y="0"       width="512" height="198.67" fill="#FF9933"/>
    <rect x="0" y="198.67"  width="512" height="114.66" fill="#ffffff"/>
    <rect x="0" y="313.33"  width="512" height="198.67" fill="#138808"/>
  </g>
  <circle cx="256" cy="256" r="192" fill="none" stroke="#000080" stroke-width="4"/>
  <circle cx="256" cy="256" r="152" fill="none" stroke="#000080" stroke-width="4"/>

  <!-- 3 · Inner disc -->
  <circle cx="256" cy="256" r="150" fill="#ffffff"/>
  <rect x="100" y="100" width="312" height="312" fill="url(#agWash)" clip-path="url(#agInnerClip)"/>

  <!-- 4 · Aircraft silhouette (nose up) -->
  <g fill="#000080" transform="translate(256 256) scale(1.08) translate(-256 -256)">
    <path d="M256 148 C272 176 280 216 280 262 L280 350 C280 366 270 376 256 376 C242 376 232 366 232 350 L232 262 C232 216 240 176 256 148 Z"/>
    <path d="M272 236 L372 298 L374 314 L276 290 Z"/>
    <path d="M240 236 L140 298 L138 314 L236 290 Z"/>
    <path d="M270 320 L316 348 L316 360 L268 348 Z"/>
    <path d="M242 320 L196 348 L196 360 L244 348 Z"/>
  </g>

  <!-- 5 · Curved brand text wrapping the border -->
  <g fill="#000080" font-family="Helvetica Neue, Helvetica, Arial, sans-serif"
     font-weight="700" font-size="50" letter-spacing="5.8">
    <path id="agTopArc" d="M107.4 122.2 A200 200 0 0 1 404.6 122.2" fill="none"/>
    <text><textPath href="#agTopArc" xlink:href="#agTopArc" startOffset="50%" text-anchor="middle">AEROGYAN</textPath></text>
  </g>
  <g fill="#000080" font-family="Helvetica Neue, Helvetica, Arial, sans-serif"
     font-weight="700" font-size="50" letter-spacing="3.6">
    <path id="agBottomArc" d="M104.3 436.8 A236 236 0 0 0 407.7 436.8" fill="none"/>
    <text><textPath href="#agBottomArc" xlink:href="#agBottomArc" startOffset="50%" text-anchor="middle">EDUCATION</textPath></text>
  </g>

  <!-- 6 · Side accents -->
  <g fill="#000080">
    <path d="M36 245 L46 256 L36 267 L26 256 Z"/>
    <path d="M476 245 L486 256 L476 267 L466 256 Z"/>
  </g>
</svg>
````

### 3.2 Regenerated PNG assets (same filenames — drop-in replacements)

Rasterised from the SVG master at 1024 px and downscaled with Lanczos:

| file | size |
|------|------|
| `favicon-16.png` | 16×16 |
| `favicon-32.png` | 32×32 |
| `favicon-48.png` | 48×48 |
| `favicon-96.png` | 96×96 |
| `apple-touch-icon.png` | 180×180 |
| `icon-192.png` | 192×192 |
| `icon-256.png` | 256×256 |
| `icon-384.png` | 384×384 |
| `icon-512.png` | 512×512 |

Transparent corners are preserved (matching the previous assets).

### 3.3 `index.html` — REPLACE the favicon `<link>` block

**Before**

````html
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png?v=49">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png?v=49">
  <link rel="icon" type="image/png" sizes="48x48" href="/favicon-48.png?v=49">
  <link rel="icon" type="image/png" sizes="96x96" href="/favicon-96.png?v=49">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=49">
  <link rel="shortcut icon" href="/favicon-32.png?v=49">
````

**After**

````html
  <!-- Logo / Favicon -->
  <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=106">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png?v=106">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png?v=106">
  <link rel="icon" type="image/png" sizes="48x48" href="/favicon-48.png?v=106">
  <link rel="icon" type="image/png" sizes="96x96" href="/favicon-96.png?v=106">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=106">
  <link rel="shortcut icon" href="/favicon-32.png?v=106">
````

### 3.4 `landing.html` — REPLACE the same block

**Before** = the six `v=49` lines above.  **After:**

````html
  <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=106">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png?v=106">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png?v=106">
  <link rel="icon" type="image/png" sizes="48x48" href="/favicon-48.png?v=106">
  <link rel="icon" type="image/png" sizes="96x96" href="/favicon-96.png?v=106">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=106">
  <link rel="shortcut icon" href="/favicon-32.png?v=106">
````

### 3.5 `server.js` — ADD a route (the app serves assets explicitly, so a missing route = 404)

**After** the existing `/logo.svg` line (currently line 838):

````js
app.get('/logo.svg',             (req, res) => sendCached(res, 'logo.svg', 604800));
app.get('/favicon.svg',          (req, res) => sendCached(res, 'favicon.svg', 604800));
````

### 3.6 Cache-busting (REQUIRED — otherwise browsers keep the old icons)

| file | change |
|------|--------|
| `index.html` | `styles.css?v=104` → `styles.css?v=106` |
| `index.html` | `media-viewer.js?v=105` → `?v=106` |
| `index.html` | `app.js?v=105` → `app.js?v=106` |
| `landing.html` | `styles.css?v=104` → `styles.css?v=106` |
| `sw.js` | `const CACHE_NAME = 'aero-shell-v105';` → `'aero-shell-v106';` and add `'./favicon.svg',` to `SHELL_ASSETS` |

### 3.7 `manifest.json` — ADD the SVG icon as the first entry of `icons[]`

````json
    {
      "src": "/favicon.svg",
      "sizes": "any",
      "type": "image/svg+xml",
      "purpose": "any"
    },
````
---

## 4. FEATURE 3 — Premium access control (search · filter · grant)

**Behaviour:** the *Students* tab gets a search box (name / username / email / phone), an access-level filter (all / premium / no-premium) and a sort selector. Every card shows a Premium-or-Free badge and a **Grant Premium** (or **Extend Premium**) button that opens a duration modal and calls the existing, already-deployed `POST /api/admin/subscription/:userId/grant` endpoint.

> The server is hit **once per refresh**. Typing only re-renders from a local cache, so searching can never spam or slow the live server.

### 4.1 `server.js` — REPLACE the `/api/students` handler body

**Before**

````js
app.get('/api/students', requireAdminAuth, async (req, res) => {
  try {
    /* ⚡ Only the fields the admin UI actually renders. Excluding
       activityLog / quizResults / notifications cuts the payload
       from tens of MB down to a few hundred KB. */
    const students = await User.find({ role: 'student' })
      .select('username fullName email phone role createdAt')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, students });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
````

**After**

````js
app.get('/api/students', requireAdminAuth, async (req, res) => {
  try {
    /* ⚡ Only the fields the admin UI actually renders. Excluding
       activityLog / quizResults / notifications cuts the payload
       from tens of MB down to a few hundred KB. */
    const students = await User.find({ role: 'student' })
      .select('username fullName email phone role createdAt subscription')
      .sort({ createdAt: -1 })
      .lean();

    /* ⭐ PREMIUM-ACCESS FLAGS (admin Students tab search/filter).
       Computed here so the client never has to interpret raw
       subscription state, and so the payload stays small — the
       subscription history array is deliberately NOT shipped. */
    const now = Date.now();
    const studentsOut = students.map(s => {
      const sub = s.subscription || {};
      const expiresMs = sub.expiresAt ? new Date(sub.expiresAt).getTime() : null;
      const premiumActive = !!(sub.active === true && sub.status === 'active' &&
        (expiresMs === null || expiresMs > now));
      return {
        _id: s._id,
        username: s.username,
        fullName: s.fullName,
        email: s.email,
        phone: s.phone,
        role: s.role,
        createdAt: s.createdAt,
        premium: {
          active: premiumActive,
          status: sub.status || 'none',
          expiresAt: sub.expiresAt || null,
          daysLeft: expiresMs === null ? null : Math.ceil((expiresMs - now) / 86400000)
        }
      };
    });

    res.json({ success: true, students: studentsOut });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});
````

> Purely additive to the JSON contract: every pre-existing field is still returned; `premium` is new. The subscription `history` array is deliberately **not** shipped, so the payload stays small.

### 4.2 `index.html` — ADD the search / filter toolbar

Insert inside `<div id="adminTabStudents" class="admin-tab-content">`, **directly after the closing `</div>` of the `.tab-toolbar`** (currently near line 561):

````html
          <!-- ⭐ FEATURE: Premium Access Control — search & filter students -->
          <div class="student-filter-bar">
            <div class="student-search-wrap">
              <i class="fas fa-search"></i>
              <input type="text"
                     id="studentSearchInput"
                     class="student-search-input"
                     placeholder="Search student by name, username or email…"
                     autocomplete="off"
                     spellcheck="false"
                     oninput="setStudentSearchFilter(this.value)">
              <button type="button" class="student-search-clear" id="studentSearchClear"
                      title="Clear search" hidden onclick="clearStudentSearch()">
                <i class="fas fa-times"></i>
              </button>
            </div>

            <select id="studentPremiumFilter" class="student-filter-select"
                    title="Filter by premium access"
                    onchange="setStudentPremiumFilter(this.value)">
              <option value="all">All access levels</option>
              <option value="premium">Premium access only</option>
              <option value="free">No premium access</option>
            </select>

            <select id="studentSortSelect" class="student-filter-select"
                    title="Sort students"
                    onchange="setStudentSort(this.value)">
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="name">Name (A–Z)</option>
            </select>

            <button class="btn btn-outline btn-sm" id="studentFilterClearBtn"
                    title="Clear search &amp; filters" onclick="clearStudentFilters()">
              <i class="fas fa-filter-circle-xmark"></i> Clear
            </button>
          </div>

          <div class="student-filter-summary" id="studentFilterSummary" hidden></div>
````

### 4.3 `index.html` — ADD the Grant-Premium modal

Insert with the other modals, **directly after the `credentialsModal` block** (currently near line 959):

````html
  <!-- ============ GRANT PREMIUM ACCESS MODAL (Admin → Students) ============ -->
  <div class="modal-overlay" id="grantPremiumModal">
    <div class="modal-box" style="max-width:520px;">
      <h3><i class="fas fa-crown"></i> Grant Premium Access</h3>
      <p class="modal-sub">
        Unlock every premium course, material and quiz for
        <strong id="grantPremiumStudentName">this student</strong>.
      </p>

      <div class="form-group">
        <label>Access duration</label>
        <select id="grantPremiumDuration" onchange="onGrantPremiumDurationChange()">
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="180">180 days</option>
          <option value="365" selected>1 year (365 days)</option>
          <option value="custom">Custom…</option>
        </select>
      </div>

      <div class="form-group" id="grantPremiumCustomWrap" hidden>
        <label>Custom duration (days)</label>
        <input type="number" id="grantPremiumCustomDays" min="1" max="3650" step="1"
               value="365" oninput="updateGrantPremiumSummary()">
      </div>

      <div class="form-group">
        <label>Note <span style="font-weight:400;color:var(--text-tertiary);">(optional — stored in the grant history)</span></label>
        <input type="text" id="grantPremiumNote" maxlength="140"
               placeholder="e.g. Scholarship grant, support resolution…">
      </div>

      <div class="grant-premium-summary" id="grantPremiumSummary"></div>

      <div class="modal-actions">
        <button type="button" class="btn btn-outline" onclick="closeModal('grantPremiumModal')">
          Cancel
        </button>
        <button type="button" class="btn btn-success" id="grantPremiumSubmitBtn" onclick="submitGrantPremium()">
          <i class="fas fa-crown"></i> Grant Premium
        </button>
      </div>
    </div>
  </div>
````

### 4.4 `app.js` — ADD the filter engine + cached renderer

**Insert immediately BEFORE** `async function renderAdminStudents() {`:

````js
let _allStudentsCache = [];        // last full roster from /api/students
let _studentSearch = '';           // free-text query
let _studentPremiumFilter = 'all'; // all | premium | free
let _studentSort = 'newest';       // newest | oldest | name

function _studentHasPremium(s) {
  return !!(s && s.premium && s.premium.active);
}

function _studentMatchesSearch(s, q) {
  if (!q) return true;
  const hay = `${s.fullName || ''} ${s.username || ''} ${s.email || ''} ${s.phone || ''}`.toLowerCase();
  // Every whitespace-separated token must match → "rahul sharma" also finds "Sharma Rahul"
  return q.split(/\s+/).filter(Boolean).every(tok => hay.includes(tok));
}

function _getFilteredStudents() {
  let list = _allStudentsCache.slice();

  list = list.filter(s => _studentMatchesSearch(s, _studentSearch.trim().toLowerCase()));

  if (_studentPremiumFilter === 'premium')   list = list.filter(_studentHasPremium);
  else if (_studentPremiumFilter === 'free') list = list.filter(s => !_studentHasPremium(s));

  if (_studentSort === 'name') {
    list.sort((a, b) => String(a.fullName || a.username || '')
      .localeCompare(String(b.fullName || b.username || ''), 'en', { sensitivity: 'base' }));
  } else if (_studentSort === 'oldest') {
    list.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  } else {
    list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }
  return list;
}

/* ---- Event handlers wired from index.html ---- */
function setStudentSearchFilter(value) {
  _studentSearch = String(value == null ? '' : value);
  /* Keep the static input in sync if we were called programmatically
     (guarded so normal typing never has its caret disturbed). */
  const inp = $('studentSearchInput');
  if (inp && inp.value !== _studentSearch) inp.value = _studentSearch;
  const clearBtn = $('studentSearchClear');
  if (clearBtn) clearBtn.hidden = _studentSearch.length === 0;
  renderStudentListFromCache();
}

function clearStudentSearch() {
  _studentSearch = '';
  const inp = $('studentSearchInput');
  if (inp) { inp.value = ''; try { inp.focus(); } catch (e) {} }
  const clearBtn = $('studentSearchClear');
  if (clearBtn) clearBtn.hidden = true;
  renderStudentListFromCache();
}

function setStudentPremiumFilter(value) {
  _studentPremiumFilter = (value === 'premium' || value === 'free') ? value : 'all';
  const sel = $('studentPremiumFilter');
  if (sel && sel.value !== _studentPremiumFilter) sel.value = _studentPremiumFilter;
  renderStudentListFromCache();
}

function setStudentSort(value) {
  _studentSort = (value === 'oldest' || value === 'name') ? value : 'newest';
  const srt = $('studentSortSelect');
  if (srt && srt.value !== _studentSort) srt.value = _studentSort;
  renderStudentListFromCache();
}

function clearStudentFilters() {
  _studentSearch = '';
  _studentPremiumFilter = 'all';
  _studentSort = 'newest';
  const inp = $('studentSearchInput');   if (inp) inp.value = '';
  const sel = $('studentPremiumFilter'); if (sel) sel.value = 'all';
  const srt = $('studentSortSelect');    if (srt) srt.value = 'newest';
  const clearBtn = $('studentSearchClear'); if (clearBtn) clearBtn.hidden = true;
  renderStudentListFromCache();
}

/* Renders the roster from cache applying search / filter / sort.
   NEVER hits the network — safe to call on every keystroke. */
function renderStudentListFromCache() {
  const container = $('adminStudentList');
  if (!container) return;

  const total = _allStudentsCache.length;
  const list = _getFilteredStudents();
  const query = _studentSearch.trim();
  const filtersActive = !!query || _studentPremiumFilter !== 'all';

  const countEl = $('studentCountLabel');
  if (countEl) {
    countEl.textContent = filtersActive
      ? `${list.length} of ${total} student${total === 1 ? '' : 's'}`
      : `${total} student${total === 1 ? '' : 's'}`;
  }

  /* ---- Filter summary strip ---- */
  const summary = $('studentFilterSummary');
  if (summary) {
    if (filtersActive) {
      const bits = [];
      if (query) bits.push(`matching “${escapeHtml(query)}”`);
      if (_studentPremiumFilter === 'premium') bits.push('with premium access');
      if (_studentPremiumFilter === 'free')    bits.push('without premium access');
      summary.hidden = false;
      summary.innerHTML = `<i class="fas fa-filter"></i> Showing <strong>${list.length}</strong> of <strong>${total}</strong> students ${bits.join(' ')}`;
    } else {
      summary.hidden = true;
      summary.innerHTML = '';
    }
  }

  /* Drop selections for students that no longer exist */
  const validIds = new Set(_allStudentsCache.map(s => String(s._id)));
  Array.from(_emailSelectedIds).forEach(id => {
    if (!validIds.has(id)) _emailSelectedIds.delete(id);
  });

  renderStudentSelectionBar(
    _emailSelectedIds.size,
    list.filter(s => s.email && s.email.trim()).length
  );

  if (total === 0) {
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

  if (list.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-magnifying-glass"></i>
        <p>No students match your search.</p>
        <p style="margin-top:6px;font-size:13px;color:var(--text-tertiary);">Try a different name, username or email.</p>
        <button class="btn btn-outline" style="margin-top:16px;" onclick="clearStudentFilters()">
          <i class="fas fa-filter-circle-xmark"></i> Clear Filters
        </button>
      </div>`;
    return;
  }

  let html = `<div class="student-grid">`;
  list.forEach(s => {
    const sid = String(s._id);
    const selected = _emailSelectedIds.has(sid);
    const hasEmail = !!(s.email && s.email.trim());
    const name = s.fullName || s.username || 'Student';
    const initials = name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
    const created = s.createdAt
      ? new Date(s.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : '—';

    /* ⭐ Premium-access badge */
    const prem = s.premium || {};
    const hasPremium = !!prem.active;
    let premiumBadge;
    if (hasPremium) {
      const until = prem.expiresAt
        ? new Date(prem.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
        : null;
      premiumBadge = `<span class="student-premium-badge active" title="Premium access active">
          <i class="fas fa-crown"></i> Premium${until ? ' · till ' + escapeHtml(until) : ''}
        </span>`;
    } else {
      premiumBadge = `<span class="student-premium-badge" title="No active premium access">
          <i class="fas fa-lock"></i> Free
        </span>`;
    }

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
          <div class="student-meta-row">
            ${premiumBadge}
          </div>
        </div>
        <div class="student-card-actions">
          <button class="btn ${hasPremium ? 'btn-outline' : 'btn-success'} btn-sm student-grant-btn"
                  onclick="openGrantPremiumModal('${sid}')"
                  title="${hasPremium ? 'Extend or renew premium access' : 'Grant access to all premium courses'}">
            <i class="fas fa-crown"></i> ${hasPremium ? 'Extend Premium' : 'Grant Premium'}
          </button>
          <button class="btn btn-outline btn-sm" onclick="resetStudentPassword('${sid}', ${jsStr(name)})">
            <i class="fas fa-key"></i> Reset Password
          </button>
          <button class="btn btn-danger btn-sm" onclick="deleteStudent('${sid}', ${jsStr(name)})">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>`;
  });
  html += `</div>`;
  container.innerHTML = html;
}
````

### 4.5 `app.js` — REPLACE `renderAdminStudents()` with the cached version

Keep the existing `catch` block exactly as it is; only the body above it changes. **After:**

````js
async function renderAdminStudents() {
  const container = $('adminStudentList');
  if (!container) return;
  container.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>Loading students...</p></div>`;

  try {
    // fetchJSON → interceptor attaches token + surfaces clean errors
    const data = await fetchJSON(`${API_BASE}/students?_t=${Date.now()}`);

    if (!data.success) throw new Error(data.message || 'Failed to load students');

    /* ⭐ Keep the module query in sync with the static search input
       (the input survives re-renders; this state is the source of truth). */
    const inp = $('studentSearchInput');
    if (inp && inp.value !== _studentSearch) _studentSearch = inp.value;
    const clearBtn = $('studentSearchClear');
    if (clearBtn) clearBtn.hidden = !_studentSearch;

    _allStudentsCache = Array.isArray(data.students) ? data.students : [];
    renderStudentListFromCache();
  } catch (err) {
    console.error('renderAdminStudents:', err);
    renderStudentSelectionBar(0, 0);
    container.innerHTML = `<div class="empty-state"><p style="color:var(--rose-500);">Error loading students.</p></div>`;
  }
}
````

### 4.6 `app.js` — ADD the Grant-Premium modal functions

**Insert directly AFTER** `adminRevokeSubscription()` and BEFORE `/* ---- Selection helpers ---- */`:

````js
let _grantPremiumUserId = null;

function openGrantPremiumModal(userId) {
  const sid = String(userId);
  const student = _allStudentsCache.find(s => String(s._id) === sid);
  if (!student) {
    return showToast('Student not found in the current list. Refresh and try again.', 'error');
  }

  _grantPremiumUserId = sid;

  const nameEl = $('grantPremiumStudentName');
  if (nameEl) nameEl.textContent = student.fullName || student.username || 'this student';

  const durEl = $('grantPremiumDuration');
  if (durEl) durEl.value = '365';

  const customWrap = $('grantPremiumCustomWrap');
  if (customWrap) customWrap.hidden = true;
  const customEl = $('grantPremiumCustomDays');
  if (customEl) customEl.value = '365';

  const noteEl = $('grantPremiumNote');
  if (noteEl) noteEl.value = '';

  const btn = $('grantPremiumSubmitBtn');
  if (btn) btn.disabled = false;

  updateGrantPremiumSummary();
  openModal('grantPremiumModal');
}

function onGrantPremiumDurationChange() {
  const durEl = $('grantPremiumDuration');
  const customWrap = $('grantPremiumCustomWrap');
  const isCustom = !!durEl && durEl.value === 'custom';
  if (customWrap) customWrap.hidden = !isCustom;
  updateGrantPremiumSummary();
}

function _grantPremiumDays() {
  const durEl = $('grantPremiumDuration');
  if (!durEl) return 0;

  if (durEl.value === 'custom') {
    const customEl = $('grantPremiumCustomDays');
    const n = parseInt(customEl ? customEl.value : '', 10);
    return (Number.isFinite(n) && n > 0) ? Math.min(n, 3650) : 0;
  }

  const n = parseInt(durEl.value, 10);
  return (Number.isFinite(n) && n > 0) ? n : 0;
}

function updateGrantPremiumSummary() {
  const el = $('grantPremiumSummary');
  if (!el) return;

  const days = _grantPremiumDays();
  if (!days) {
    el.classList.add('warn');
    el.innerHTML = `<i class="fas fa-triangle-exclamation"></i> Enter a valid number of days (1–3650).`;
    return;
  }

  el.classList.remove('warn');
  const until = new Date(Date.now() + days * 86400000)
    .toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  el.innerHTML = `<i class="fas fa-circle-info"></i> Premium access for <strong>${days} day${days === 1 ? '' : 's'}</strong> — until <strong>${until}</strong>.`;
}

async function submitGrantPremium() {
  if (!_grantPremiumUserId) return showToast('No student selected.', 'error');

  const days = _grantPremiumDays();
  if (!days) return showToast('Enter a valid number of days (1–3650).', 'error');

  const noteEl = $('grantPremiumNote');
  const note = noteEl ? noteEl.value.trim() : '';
  const btn = $('grantPremiumSubmitBtn');
  if (btn) btn.disabled = true;

  try {
    const data = await fetchJSON(`${API_BASE}/admin/subscription/${_grantPremiumUserId}/grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        days,
        note: note || `Admin granted ${days} day(s) from Students tab`
      })
    });

    if (!data || !data.success) {
      if (btn) btn.disabled = false;
      return showToast((data && data.message) || 'Could not grant premium access.', 'error');
    }

    closeModal('grantPremiumModal');
    showToast(`👑 Premium access granted for ${days} day${days === 1 ? '' : 's'}.`, 'success');

    /* Refresh the roster so the new badge + expiry show immediately */
    await renderAdminStudents();
  } catch (err) {
    if (btn) btn.disabled = false;
    showToast(err.message || 'Server error while granting premium access.', 'error');
  }
}
````

### 4.7 `app.js` — REPLACE the recipient-name lookup in `openEmailStudentsModal()`

Needed because a selected student can now be hidden by the search filter; without this the bulk-email preview would drop their name. **Before**

````js
  const selectedCards = Array.from(_emailSelectedIds)
    .map(id => document.querySelector(`.student-card[data-student-id="${id}"]`))
    .filter(Boolean);

  const names = selectedCards.map(card => {
    const h4 = card.querySelector('.student-card-info h4');
    return h4 ? h4.textContent.trim() : 'Student';
  });
````

**After**

````js
  /* ⭐ Search/filter-safe: a selected student may currently be hidden
     by the Students-tab filter, so fall back to the cached roster for
     the display name instead of dropping them from the preview. */
  const _nameById = new Map(
    _allStudentsCache.map(s => [String(s._id), s.fullName || s.username || 'Student'])
  );

  const names = Array.from(_emailSelectedIds).map(id => {
    const card = document.querySelector(`.student-card[data-student-id="${id}"]`);
    const h4 = card ? card.querySelector('.student-card-info h4') : null;
    return (h4 && h4.textContent.trim()) || _nameById.get(String(id)) || 'Student';
  });
````

### 4.8 `styles.css` — APPEND

````css
/* ============================================================
   ⭐ PREMIUM ACCESS CONTROL — Students tab search / filter bar,
      premium badge and grant-premium modal.
      Additive only: no existing selector is modified.
   ============================================================ */
.student-filter-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  padding: 12px 14px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}

.student-search-wrap {
  position: relative;
  flex: 1 1 320px;
  min-width: 220px;
  display: flex;
  align-items: center;
}

.student-search-wrap > i.fa-search {
  position: absolute;
  left: 13px;
  font-size: 13px;
  color: var(--text-tertiary);
  pointer-events: none;
  transition: color .2s var(--ease);
}
.student-search-wrap:focus-within > i.fa-search { color: var(--brand-500); }

.student-search-input {
  width: 100%;
  padding: 10px 38px 10px 36px;
  font-size: 13.5px;
  font-family: inherit;
  color: var(--text-primary);
  background: var(--bg-surface-2);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  outline: none;
  transition: .2s var(--ease);
}
.student-search-input::placeholder { color: var(--text-tertiary); }
.student-search-input:focus {
  border-color: var(--brand-500);
  background: var(--bg-surface);
  box-shadow: 0 0 0 3px rgba(99,102,241,.15);
}

.student-search-clear {
  position: absolute;
  right: 8px;
  width: 24px; height: 24px;
  display: inline-flex; align-items: center; justify-content: center;
  border: none;
  border-radius: 50%;
  background: var(--bg-surface-3);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: .18s var(--ease);
}
.student-search-clear:hover { background: var(--rose-500); color: #fff; }

.student-filter-select {
  flex: 0 0 auto;
  padding: 10px 12px;
  font-size: 13px;
  font-family: inherit;
  font-weight: 500;
  color: var(--text-primary);
  background: var(--bg-surface-2);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  cursor: pointer;
  outline: none;
  transition: .2s var(--ease);
}
.student-filter-select:focus {
  border-color: var(--brand-500);
  box-shadow: 0 0 0 3px rgba(99,102,241,.15);
}

.student-filter-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
  padding: 9px 14px;
  font-size: 12.5px;
  color: var(--text-secondary);
  background: linear-gradient(135deg, rgba(99,102,241,.08), rgba(6,182,212,.05));
  border: 1px solid rgba(99,102,241,.2);
  border-radius: var(--radius-sm);
}
.student-filter-summary i { color: var(--brand-500); }
.student-filter-summary strong { color: var(--brand-600); font-weight: 800; }
[data-theme="dark"] .student-filter-summary strong,
[data-theme="dim"] .student-filter-summary strong { color: var(--brand-300); }

/* ---- Premium / free badge on the student card ---- */
.student-premium-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .2px;
  border-radius: var(--radius-pill);
  color: var(--text-tertiary);
  background: var(--bg-surface-3);
  border: 1px solid var(--border-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.student-premium-badge.active {
  color: #7c4a03;
  background: linear-gradient(135deg, rgba(251,191,36,.22), rgba(245,158,11,.14));
  border-color: rgba(245,158,11,.45);
}
[data-theme="dark"] .student-premium-badge.active,
[data-theme="dim"] .student-premium-badge.active { color: var(--gold-300); }

/* ---- Grant-premium modal summary line ---- */
.grant-premium-summary {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 4px 0 14px;
  padding: 10px 13px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-secondary);
  background: var(--bg-surface-2);
  border: 1px solid var(--border-subtle);
  border-left: 3px solid var(--brand-500);
  border-radius: var(--radius-sm);
}
.grant-premium-summary i { color: var(--brand-500); margin-top: 2px; flex-shrink: 0; }
.grant-premium-summary strong { color: var(--text-primary); font-weight: 700; }
.grant-premium-summary.warn {
  border-left-color: var(--gold-500);
  color: var(--gold-600);
}
.grant-premium-summary.warn i { color: var(--gold-500); }

@media (max-width: 640px) {
  .student-search-wrap { flex: 1 1 100%; }
  .student-filter-select { flex: 1 1 auto; }
}
````

Then also append the layout corrections:

````css
/* ------------------------------------------------------------
   ⭐ Premium Access Control — layout corrections
   `[hidden]` must win over the `display` set on these rules,
   and the card action row needs to wrap now that it carries a
   third (full-width) "Grant / Extend Premium" button.
   ------------------------------------------------------------ */
.student-search-clear[hidden],
.student-filter-summary[hidden] { display: none !important; }

.student-grid .student-card-actions { flex-wrap: wrap; row-gap: 6px; }
.student-grid .student-card-actions .student-grant-btn {
  flex: 1 1 100%;
  justify-content: center;
  font-weight: 700;
}
````

> The `[hidden]` rules are required: `.student-search-clear` and `.student-filter-summary` set `display: flex/inline-flex`, which otherwise beats the browser's built-in `[hidden] { display: none }` and leaves an empty bar visible.

---

## 5. Verification that was performed

| Check | Result |
|-------|--------|
| `node --check server.js app.js sw.js media-viewer.js verify-razorpay.js` | all OK |
| `manifest.json` / `package.json` JSON parse | OK |
| Duplicate element IDs in `index.html` (241 ids) | none |
| Search / filter / sort engine — 37 assertions run in headless Chrome against the **real extracted functions** | 37/37 PASS |
| Inactivity watch — 21 assertions (warning timing, countdown, reset on activity, hard logout, stop, logged-out guard) | 21/21 PASS |
| Favicon rendered at 16/32/48/96/180/192/256/384/512 px | legible, no text/ring collision (measured: text band r 199–237, ring ends r 192, border starts r 248) |
| `index.html` / `landing.html` favicon URLs resolve to a served route | `/favicon.svg` route added |

Automated coverage highlights for Feature 3:

- case-insensitive search, multi-token search across fields, partial email, phone
- premium / free filtering, combined search + filter, invalid-value fallback
- three sort modes, invalid-value fallback
- empty-roster and no-match empty states
- premium badge + grant button rendering, count label (`2 of 5 students`)
- custom duration (500 days), clamping to 3650, invalid 0-day warning state
- email selection survives filtering; search text is HTML-escaped (XSS-safe)

---

## 6. Deploy checklist

1. `cp /Users/Programming Content/_AeroGyan-Safety-Backups/20260930-114050/{app.js,index.html,landing.html,manifest.json,server.js,styles.css,sw.js} .` is the **rollback**, not the deploy.
2. Upload the changed files, preserving relative paths:
   - Code: `server.js`, `app.js`, `index.html`, `landing.html`, `styles.css`, `sw.js`, `manifest.json`
   - New icon: `favicon.svg`
   - Replaced icons: `favicon-16.png`, `favicon-32.png`, `favicon-48.png`, `favicon-96.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-256.png`, `icon-384.png`, `icon-512.png`
3. Restart the Node process (the `/favicon.svg` route is new, so a restart is required).
4. Verify:
   - `GET /favicon.svg` → 200, `image/svg+xml`
   - Hard-refresh `/app`; the tab icon shows the aircraft badge (new `?v=106` URLs).
   - Log in, wait ~9 minutes without touching anything → the countdown overlay appears; touch the mouse → it disappears.
   - Admin → Students → type a name → the roster narrows instantly; click **Grant Premium** → pick a duration → **Grant Premium** → the badge flips to gold with the expiry date.

---

## 7. Rollback

```bash
cd "/Users/Programming Content/Aerospace Portal IIT KGP"
cp /Users/Programming Content/_AeroGyan-Safety-Backups/20260930-114050/{app.js,index.html,landing.html,manifest.json,server.js,styles.css,sw.js} .
# then delete favicon.svg and restore the old PNGs from version control:
git checkout -- favicon-16.png favicon-32.png favicon-48.png favicon-96.png \
                apple-touch-icon.png icon-192.png icon-256.png icon-384.png icon-512.png
# restart the Node process
```

Because `sw.js` bumps `CACHE_NAME`, the service worker self-heals: on the next load it deletes the old cache and re-installs the new shell assets. No user action is required beyond a page refresh.

---

## 8. Things deliberately NOT changed

- No database schema, index or migration change.
- No existing API path, request shape or response field removed or renamed.
- No existing CSS selector rewritten (every CSS change is an appended rule).
- No change to the login, OTP, payment, quiz or proctoring flows.
- `server.js.bak`, `server.js.before-dedup`, `server.js.broken-1790348432` and `logo.svg` were left untouched.
