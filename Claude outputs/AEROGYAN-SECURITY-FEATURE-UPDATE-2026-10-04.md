# AeroGyan — Security, UX & Feature Update (2026-10-04)

**Status:** built and tested in staging. **Not deployed.** Nothing in your live folder or on the VPS has changed.
**Files changed:** `server.js`, `app.js`, `index.html`, `landing.html`, `styles.css`, `media-viewer.js`, `sw.js`, `models/User.js`, `package.json`, `.gitignore`. New files: `scripts/test-auth-core.js`, `scripts/test-security-helpers.js`, `scripts/smoke-test.sh`.
**No new npm packages.** `npm install` is not needed.

---

## 1. Security audit: what was found and fixed

| # | Severity | Problem (before) | Fix |
|---|----------|------------------|-----|
| S1 | **Critical** | Every `/api/user/*` route trusted the `userId` in the URL/body. Without logging in, anyone could read any student's profile (email, purchases, quiz results, notifications), mark progress, start or submit quizzes, and toggle bookmarks *as another student*. | New `requireUser` + `requireSelfOrAdmin` middleware on 25 routes. Students can only touch their own record. Admins can touch any record. The frontend already sent the token, so no client changes were needed. |
| S2 | **Critical** | `/api/upload`, `/api/upload/init`, `/chunk` and `/complete` had **no auth**. Anyone could write unlimited files to the VPS disk and to Cloudinary (disk-fill or malware hosting). | Login is required. Upload sessions are bound to the uploader. Chunk indexes are validated. Size caps: 60 MB for students, 4 GB for admins. Max 6 uploads in flight per user. Guests (alumni/supporter form) get a separate `/api/upload/public-photo` route: JPEG/PNG/WebP only, ≤5 MB, content-sniffed, 8 per IP per hour. |
| S3 | **Critical** | `JWT_SECRET` fell back to the hard-coded `'SuperSecretAeroKey'`. If the env var was ever missing, anyone could forge an admin token. | The fallback is removed. A missing secret now gives a random per-process secret plus a loud error. The algorithm is pinned to HS256 in all 8 `jwt.verify` calls. |
| S4 | **High** | One-time subscription replay: re-sending a valid `(order, payment, signature)` to `/api/subscribe/verify-order` extended the subscription **every time**. The client call and the webhook also *both* extended it, so one payment gave 2× days, counted the coupon twice and bumped the referrer twice. | The order must equal `user.subscription.lastOrderId`. It is re-checked with Razorpay (`notes.userId` and `status: paid`). A new `paymentAlreadyApplied()` check makes the client verify, the subscription verify and the webhook all idempotent per payment id. |
| S5 | **High** | Logout, "signed in on another device" and password changes did not invalidate tokens on API routes. An old or stolen token kept working for up to 24 h. The admin middleware never checked the session either. | One `resolveSessionUser()` checks signature → account → not suspended → `sessionId` matches. It is used by every protected route, including admin routes and admin SSE streams. Password reset (self or by admin) ends all sessions. |
| S6 | **High** | `GET /api/courses/:id` sent each material's raw **Cloudinary URL**, which bypassed the premium paywall. It also sent every doubt-asker's **email** to all students, and the Q&A UI showed it (`isAdmin` was a function reference, so it was always truthy). | The public payload now sends `cloudUrl: 'cloud'` (a flag only) and strips emails from doubts. The UI bug is fixed (`isAdminUser`). |
| S7 | **High** | Doubts and replies used the identity from the request body. A student could post as `authorRole: "admin"`, accept answers by spoofing `acceptedBy`, or edit any doubt's answer (`PUT …/doubts/:id` had no auth). | The name, username and role now come from the session. `PUT …/doubts/:id` is admin-only. |
| S8 | Medium | OTPs used `Math.random()`. | Switched to `crypto.randomInt` (6 places). |
| S9 | Medium | NoSQL operator injection (`{"username":{"$ne":null}}`) and `__proto__` keys reached handlers. | A global scrubber strips `$`-prefixed and prototype keys from JSON bodies. Values are untouched, so LaTeX like `$x^2$` still works. The recovery stores now use `Object.create(null)`. |
| S10 | Medium | `/setup-admin` used a default password `AeroAdmin123` and printed it in the response. | It now requires `ADMIN_PASSWORD` (10+ characters) and never echoes it. |
| S11 | Low | `/api/ai/solve-doubt` (paid LLM calls) and contributions could be called anonymously. The contribution identity came from the form. | Login is required, and the identity comes from the session. |

**Still public by design:** login/registration/recovery, course list and detail, professors, settings, plans, alumni/friends/feedback (rate-limited), version/SSE pings, and the Razorpay webhook (HMAC-verified).

## 2. Bugs and stability

- **Final JSON error handler + JSON 404 for `/api/*`.** The old multer error handler was registered before ~95% of the routes, so errors from those routes fell through to Express's HTML page. The client then showed "Unexpected token <".
- **Graceful shutdown** on SIGTERM/SIGINT: the server drains in-flight requests (10 s max), closes SSE streams so browsers reconnect, then closes Mongo. `pm2 reload` becomes zero-downtime.
- **`keepAliveTimeout` 65 s and `headersTimeout` 66 s.** These are longer than nginx's 60 s default, which stops the sporadic 502s caused by Node closing a socket nginx is about to reuse.
- **Login now fails clearly** if the session can't be written. Before, it handed out a token that every route would reject.
- **Session DB hiccups return 503, not 401.** Before, the client logged the user out on any brief Mongo blip.
- **`fetch` interceptor:** it dropped all headers when a `Headers` object was passed. It now shows the server's real reason for a 401 (suspended, signed in elsewhere, signed out by admin).
- **Direct uploads (XHR) never sent the auth token.** Fixed.
- **Event-loop block:** `fs.writeFileSync` on uploads of up to 30 MB is now async.
- **Referral card** crashed if `program` was missing. It now has a guard.
- `/api/user/me` no longer loads `activityLog` and `videoProgress` on every navigation.

## 3. UI/UX

- **One animated sun ⇄ moon switch** replaces the cycle button **and** the header Settings gear, in both the app and the landing page. Settings is still in the profile menu.
  - The switch flips Light ↔ dark. Dim vs Night is picked once in Settings → Appearance; the switch remembers it in `aero_theme_dark`.
  - The settings modal had three overlapping controls (Night switch + Dim sub-switch + picker). It now has one Light/Dim/Night picker.
  - It is a 44 px touch target, has `role="switch"` with `aria-checked`, and respects reduced motion.
- **Pre-paint theme script** in both HTML heads, so dark-mode users no longer see a white flash.
- **Logged-out top bar** stays on one row on phones. Before, the toggle wrapped to a second row.
- Dark-mode contrast fixes: the active login tab and the Back link.

## 4. New features

**Video watch progress (synced across devices)**
- The player reports its position every ~15 s, on close, on playlist switch and at the end of a video. Storage is `User.videoProgress`, using `$max` so progress never goes backwards.
- Video cards show a progress bar, "35% watched · resume at 7:00", and a **Resume** or **Rewatch** button.
- Playlist cards show "2 of 5 watched · 48%". The button becomes **Continue · video 3** and starts at the first unfinished video.
- The playlist panel inside the player shows a ✓ and a mini bar per video.
- Crossing 90% auto-marks the lecture as completed (same XP/streak path as "Mark done").
- Resume falls back to the server position when this device has none.
- Endpoints: `POST /api/user/video-progress` and `GET /api/user/video-progress?courseId=`.

**Course navigation**
- Breadcrumb on the course page: Home › Courses › *Course*.
- "Your progress 4/12 · 33%" bar in the course header.
- An **Up next** button that opens the first unfinished material, or "Course complete" when done.

**Admin user management**
- A **Manage** panel per student shows: last active, streak, videos finished, quizzes, and current device. It also has suspend/re-activate (with reason), sign out everywhere, per-course premium access switches, and per-course progress bars.
- **Bulk actions** on the selection: Sign out, Suspend, Re-activate, Course access (unlock/remove).
- The status filter adds Active and Suspended. Cards show a Suspended or Signed-in badge and last-active time.
- The selection now works for students without email too. Email still only goes to those with an address, and the modal says how many will be skipped.
- Suspended students can't log in, and their live session ends immediately.
- Endpoints: `POST /api/admin/students/:id/suspend`, `POST …/force-logout`, `PUT …/course-access`, `POST /api/admin/students/bulk`, `GET …/:id/overview`.

## 5. Performance

- **Content-hash cache busting.** `app.js`, `styles.css` and the viewers are cached as `immutable` for 1 year, but the HTML pointed at a hand-typed `?v=136`. A forgotten bump meant users ran stale code. The server now injects `?v=<sha1>` into `/`, `/app` and the HTML automatically. Every deploy is picked up on the next load, and unchanged files are never re-downloaded.
- **Pre-compressed assets.** Brotli-11 and gzip-9 copies are built once per deploy, in the background, warmed at boot. Before, the server gzipped on every request. Result: about 20% fewer bytes than gzip on slow connections and no per-request CPU for the 785 KB `app.js`, 450 KB CSS and 1.1 MB PDF worker. `ETag` and `304` are supported.

---

## 6. What was tested (staging)

| Check | Result |
|---|---|
| `node --check` on every changed JS file | ✅ |
| Stubbed boot of `server.js` + route→middleware map (185 routes) | ✅ every non-public `/api` route has auth |
| `npm test` → auth core (24 assertions: forged/expired/pending tokens, replaced/ended sessions, suspended, DB outage → 503, IDOR, admin, query tokens) | ✅ |
| `npm test` → sanitiser and payment idempotency | ✅ |
| Browser (Chromium, mocked API): login, landing, student home, course page, playlists, Q&A, analytics, settings, admin tabs, Manage modal, bulk bar. Desktop 1280 and phone 390, light and dark | ✅ no page errors from our code |
| Video player end-to-end with a real WebM: progress POSTs, 96% → completed, auto mark-done, card repaint | ✅ |

**Not testable here:** the npm registry was blocked by this session's network policy and there is no MongoDB in the sandbox, so the real server could not be booted. The PDF viewer was not exercised (the `vendor/pdfjs` files weren't copied over). Run the checklist below on your machine before pushing.

---

## 7. Safe deployment protocol

### A. Local staging (your machine)
```bash
cd "Aerospace Portal IIT KGP"
git checkout -b release/2026-10-04
git apply --check aerogyan-2026-10-04.patch   # dry run
git apply aerogyan-2026-10-04.patch           # or copy the files from this folder
npm test                                      # 2 suites must pass
```
Use a **separate test database**. Copy `.env` to `.env.staging`, change `MONGO_URI` to a test DB, and use Razorpay **test** keys. Then:
```bash
PORT=5055 NODE_ENV=production node -r dotenv/config server.js dotenv_config_path=.env.staging
BASE_URL=http://localhost:5055 npm run smoke
```
Then click through: student login → course → play a video for 20 s → close → bar appears → reopen → resumes. Admin login → Students → Manage → suspend a test student → that student's open tab is signed out with the "suspended" message → re-activate. Check the theme switch on the login page, the app and the landing page.

### B. Env checks before deploy
- `JWT_SECRET` must be set and **≥ 32 characters**. If it's shorter, the server warns. To rotate: `openssl rand -hex 48`. Rotating logs everyone out once.
- `ADMIN_PASSWORD` is only needed for first-time `/setup-admin` and must be 10+ characters.
- Optional: `ALLOWED_ORIGINS=https://your-domain` to lock CORS.

### C. Deploy (zero-downtime)
```bash
git add -A && git commit -m "Security hardening, video progress, admin user tools, theme switch, perf"
git push origin release/2026-10-04
# on the VPS
git fetch && git checkout release/2026-10-04
npm test
pm2 reload <app-name>       # graceful: drains connections (SIGTERM handler)
```
After deploy, run `BASE_URL=https://<your-domain> npm run smoke` against production.

### D. Expected one-time effects
- **Everyone with an open session stays logged in** unless they had already logged out (old logged-out tokens now correctly stop working).
- Students on an old cached `app.js` get the new one on the next page load, thanks to the content-hash URLs.

### E. Rollback
`git checkout <previous-commit> && pm2 reload <app-name>`. The schema changes are additive (`videoProgress` and `suspended` are new optional fields), so rolling back is safe.

---

## 8. Recommended next steps (not done in this round)
- Move the JWT out of `sessionStorage` into an `HttpOnly; Secure; SameSite=Strict` cookie. This is a bigger change across ~60 frontend call sites.
- Add a real `Content-Security-Policy` once the inline `onclick=` handlers are migrated.
- Delete `server.js.bak`, `server.js.before-dedup` and `server.js.broken-*` from the project folder. They are now git-ignored but still on disk.
- Run `npm audit` on your machine (it was blocked here).
