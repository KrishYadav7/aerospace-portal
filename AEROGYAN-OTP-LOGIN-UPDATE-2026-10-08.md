# AeroGyan — Professor OTP login, admin 3-device limit, new login & professor UI (2026-10-08)

## What changed

### 1. Professor sign-in now needs an email OTP
- `POST /api/login` — professors (approved only) no longer get a token straight away. Like admins, they get
  `requires2FA: true`, `otpRole: "professor"` and a 6-digit code is emailed to their registered address.
- `POST /api/admin/login/verify-otp` — now accepts admin **and** professor codes. It re-checks suspension and
  professor approval at verify time (the account could change during the 10 minutes).
- `POST /api/admin/login/resend-otp` — works for both; max **5 resends** per sign-in, **30 s** apart
  (stops "resend" being used to get unlimited guesses). New nicer HTML email for the code.
- Professors stay **single-device** (signing in elsewhere signs the old device out) — unchanged.

### 2. Admin can be signed in on up to 3 devices at once
- New `sessions[]` list on the User model (admin only). Signing in on a 4th device signs out the
  **least-recently-used** one. Limit can be changed with env `ADMIN_MAX_SESSIONS` (default 3, max 10).
- `activeSession` still mirrors the newest admin device, so **admins already signed in before the deploy stay
  signed in** (their old token keeps working and counts as one of the 3).
- Logout only removes *that* device. Password reset (forgot-password and admin reset) signs out every device.
- New endpoints (admin only):
  - `GET  /api/admin/sessions` — list of signed-in devices
  - `POST /api/admin/sessions/:id/revoke` — sign one device out
  - `POST /api/admin/sessions/revoke-others` — keep only this device
- Admin → **Security** tab has a new **Signed-in devices** card (slots used, device, last active, sign-out buttons).
- Students: unchanged (single device).

### 3. UI
- **Login page**: split layout (brand panel + form), sliding Student / Professor / Admin switch, heading and
  button change per role, show/hide password, Caps Lock warning, note that staff get an email code,
  cleaner links (forgot password next to the field; sign-up buttons side by side). Phone layout stacks.
- **OTP popup**: six code boxes (paste / autofill still works — one real input underneath), auto-verify on the
  6th digit, live expiry countdown, resend unlocks after 30 s, shake on wrong code.
- **Professor window**: new header with greeting, 4 stat tiles (courses, materials, announcements, pending
  requests), tabs **My Courses / Course Requests / Profile**, course cards with per-course counts and last
  update, search when there are more than 3 courses, request list with status dots and admin notes,
  new **Profile** tab (details + account security).

## Files
`server.js`, `models/User.js`, `app.js`, `index.html` (asset version → v139), `styles.css` (new block at the end),
`sw.js` (cache → v140), `package.json` (test script), `scripts/test-admin-sessions.js` (new).

## Before deploying
1. `npm test` — includes the new `test-admin-sessions.js` (no DB needed).
2. Check on staging: professor login → code email arrives → code works; admin on 4 browsers → 1st is signed out.
3. No DB migration needed — `sessions` defaults to an empty list.
