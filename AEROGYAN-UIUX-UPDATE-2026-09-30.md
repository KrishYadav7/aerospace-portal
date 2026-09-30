# AeroGyan Education — UI/UX Hardening Update

**Prepared:** 30 September 2026  
**Scope:** the authenticated app (`/app`) and the landing page  
**Safety model:** every CSS change is an *appended* rule (nothing above section 64 was deleted); every JS change is an added function or a like-for-like replacement. No API contract, DB schema or route was touched.

---

## 0. What was delivered

| # | Requirement | Where |
|---|-------------|-------|
| 1 | Community images constrained (`max-width:100%` + `object-fit:cover`) | `styles.css` §64.3 |
| 2 | Overall mobile responsiveness (flex/grid/proportional, fluid spacing) | `styles.css` §64.3, §64.6 |
| 3 | Team bios: wrapping + **Read More / Show Less** | `app.js` (bio helpers), `styles.css` §64.4, §64.8, §64.9 |
| 4 | Full-screen post-login shell (100vh/100dvh, no outer gutters) | `styles.css` §64.2 |
| 5 | Centralized Night Mode config + settings toggle | `app.js` (THEME_CONFIG), `index.html` (Settings modal), `styles.css` §64.7 |
| 6 | 0.3s ease theme transitions | `styles.css` §64.1, `app.js` `applyTheme()` |
| 7 | Lazy loading for community images | already `loading="lazy"`; `decoding="async"` added to all 16 `<img>` |
| 8 | 44×44 touch targets | `styles.css` §64.5, §64.7 |

> **A pre-existing mobile bug was also found and fixed:** the notifications dropdown overflowed the screen by 73px at 390px wide (see §9).

---

## 1. Safety baseline

**Pre-change backup (roll back to this):**

```
/Users/Programming Content/_AeroGyan-Safety-Backups/20260930-122431/
```

**Post-change snapshot (the delivered state):**

```
/Users/Programming Content/_AeroGyan-Safety-Backups/20260930-123850/
  app.js  index.html  landing.html  styles.css  sw.js  server.js  manifest.json
  shots/  (verification screenshots)
```

Both live **outside the deployable tree** so they can never be shipped to the live server by an rsync/CI glob.

### Checksums of the delivered files

| file | bytes | sha256 (first 16) |
|------|-------|-------------------|
| `app.js` | 655493 | `f1e3defca96128a4` |
| `index.html` | 82852 | `17aa3f38a802f59c` |
| `landing.html` | 149011 | `686b93ec594cb398` |
| `styles.css` | 357145 | `dd50419a591c8ade` |
| `sw.js` | 3174 | `19029f7062c3f443` |
| `server.js` | 369137 | `6fd2693110567e7a` |
| `manifest.json` | 1313 | `9fc9eedce47bf259` |

---

## 2. Verification evidence

### Automated UI assertions (headless Chrome, real CSS + real extracted functions)

| viewport | horizontal overflow | assertions |
|----------|--------------------:|-----------:|
| 1440px | 0px | 86/86 |
| 1280px | 0px | 86/86 |
| 1024px | 0px | 87/87 |
| 834px | 0px | 87/87 |
| 768px | 0px | 87/87 |
| 640px | 0px | 88/88 |
| 480px | 0px | 88/88 |
| 414px | 0px | 88/88 |
| 390px | 0px | 88/88 |
| 360px | 0px | 88/88 |
| 320px | 0px | 88/88 |

Coverage includes: theme config integrity, `applyTheme` + localStorage, transition class add/remove timing,
Night/Dim/three-way switching, settings-UI ↔ theme sync, bio overflow detection, expand/collapse, the
expanded-bio regression, community image constraint against a real 2400×1800 photo, `object-fit`, touch-target
sizes, full-bleed shell, viewport-height fill and fluid padding.

> ⚠️ **Testing note:** Chrome's headless `--window-size` enforces a **500px minimum**, so narrow-viewport tests
> are unreliable that way. These results were produced by driving Chrome over the DevTools Protocol with
> `Emulation.setDeviceMetricsOverride`, which gives a *true* CSS viewport (verified: `innerWidth` equalled the
> requested width at every step).

### Manual/visual verification

- **Community section, 390px:** a 2400×1800 upload renders inside a 46×46 circular avatar; before the fix it filled the entire screen.
- **Team cards, 1280px:** the two long bios show *Read more*; the short bio shows no button; expanding shows *Show less* and the full text.
- **Settings, 390px:** Night switch, Dim sub-toggle (only visible in Night), three-way picker — all ≥44px.
- **Night mode, 1280px:** dark-grey surfaces, off-white text, softened accents across cards, buttons and badges.
- **Landing page, dark:** retuned neutrals applied (`landing.html` had 6 hard-coded navy values).
- **`app.js` load smoke test:** loaded in a real browser with **zero** console errors; all 26 new globals defined.

### Static checks

| check | result |
|-------|--------|
| `node --check` on all 5 JS files | OK |
| `manifest.json` / `package.json` parse | OK |
| duplicate element IDs in `index.html` (249 ids) | none |
| duplicate top-level function/const declarations in `app.js` | none |
| CSS brace balance (2491 pairs) | balanced |
| HTML tag balance (div/section/main/header/footer/button/form/p/span) | balanced |
---

## 3. Change 1 — Community section images (and the unstyled community block)

**Root cause.** `.community-*` had **no CSS rules at all** except a fallback-text rule:

```
.community-list  .community-item  .community-avatar  .community-avatar-img
.community-info  .community-meta  .community-bio     .community-contact
.community-actions  .community-group-head  .community-count  .community-empty
   -> all MISSING from styles.css
```

The only global guard was `img { max-width: 100% }`, which caps an image to its **parent's** width. With the
parent unstyled, a 2400×1800 upload rendered at its natural size and dominated the page.

**Fix — `styles.css`, APPEND (new section 64.3):**

````css
/* ------------------------------------------------------------
   64.3  COMMUNITY SECTION — complete styling.
   The .community-* block had NO rules at all, so uploaded
   photos rendered at their natural size and dominated the
   screen (especially on mobile). Images are now locked into a
   square, cover-cropped avatar box.
   ------------------------------------------------------------ */
.community-group-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 22px 0 12px;
  font-size: 13px;
  font-weight: 800;
  letter-spacing: .4px;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.community-group-head::before {
  content: '';
  flex: 0 0 auto;
  width: 4px;
  height: 18px;
  border-radius: 999px;
  background: linear-gradient(180deg, var(--brand-500), var(--accent-500));
}
.community-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  background: var(--bg-surface-3);
  color: var(--text-secondary);
  font-size: 11.5px;
  font-weight: 800;
}
.community-empty {
  padding: 14px 16px;
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--text-tertiary);
  background: var(--bg-surface-2);
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-md);
}
.community-list {
  display: grid;
  /* min() keeps the track from ever exceeding the viewport */
  grid-template-columns: repeat(auto-fill, minmax(min(420px, 100%), 1fr));
  gap: 12px;
  margin-bottom: 8px;
}
.community-item {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  min-width: 0;
  padding: 14px 16px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  transition: border-color .2s var(--ease), box-shadow .2s var(--ease);
}
.community-item:hover {
  border-color: var(--brand-300);
  box-shadow: var(--shadow-sm);
}
[data-theme="dark"] .community-item:hover,
[data-theme="dim"]  .community-item:hover { border-color: var(--brand-500); }

/* ⭐ Community image constraint — square box + cover crop */
.community-avatar {
  flex: 0 0 auto;
  width: 52px;
  height: 52px;
  max-width: 52px;
  max-height: 52px;
  aspect-ratio: 1 / 1;
  overflow: hidden;
  border-radius: 50%;
  background: var(--bg-surface-3);
  border: 2px solid var(--brand-500);
  display: flex;
  align-items: center;
  justify-content: center;
}
.community-avatar-img {
  display: block;
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  object-fit: cover;
  object-position: center 25%;
  border-radius: 50%;
}
.community-avatar-fallback {
  font-size: 18px;
  font-weight: 900;
  color: var(--brand-500);
  letter-spacing: -.5px;
}

.community-info { flex: 1 1 auto; min-width: 0; }
.community-info h4 {
  margin: 0 0 2px;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.community-meta {
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}
.community-bio {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-secondary);
  white-space: normal;
  overflow-wrap: anywhere;
}
.community-contact {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}
.community-contact i { margin-right: 4px; color: var(--brand-500); }
.community-actions {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}
.community-actions .btn { white-space: nowrap; }

@media (max-width: 640px) {
  .community-list { grid-template-columns: 1fr; }
  .community-item { flex-wrap: wrap; gap: 12px; padding: 13px 14px; }
  .community-avatar { width: 46px; height: 46px; max-width: 46px; max-height: 46px; }
  .community-info { flex: 1 1 calc(100% - 60px); }
  .community-actions {
    flex: 1 1 100%;
    flex-direction: row;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .community-actions .btn { flex: 1 1 auto; min-width: 92px; }
}
````

The image itself is locked with `max-width: 100%`, `width/height: 100%`, `object-fit: cover` and
`object-position: center 25%` inside a fixed `aspect-ratio: 1/1` box — so it is always a small circle, never a wall of photo.

---

## 4. Change 2 — Overall mobile responsiveness

**Fix A — `styles.css` §64.6, APPEND (fluid spacing/type + overflow guards):**

````css
/* ------------------------------------------------------------
   64.6  FLUID RESPONSIVE SPACING & TYPE
   ------------------------------------------------------------ */
.main-content {
  padding:
    clamp(14px, 2.2vw, 28px)
    clamp(12px, 2.4vw, 32px)
    clamp(28px, 4vw, 56px);
}
.section-card {
  padding:
    clamp(16px, 2vw, 26px)
    clamp(14px, 2vw, 24px);
}
.section-card h2 { font-size: clamp(16px, 2.2vw, 20px); }
.dash-header h2 { font-size: clamp(16px, 2.2vw, 19px); }
.admin-tab { font-size: clamp(11.5px, 1.4vw, 12.5px); }

/* Nothing may create a horizontal scrollbar */
img, video, svg, canvas, iframe, table, pre { max-width: 100%; }
.section-card, .modal-box, .admin-tab-content { min-width: 0; }

/* Long words / URLs wrap instead of overflowing their card */
.community-bio, .community-meta, .community-contact,
.alumni-bio, .alumni-work, .alumni-meta,
.professor-card p, .friend-card p,
.settings-row-text span { overflow-wrap: anywhere; }

@media (max-width: 480px) {
  .community-group-head { font-size: 12px; }
  .section-card h2 { font-size: 16px; }
}
````

**Fix B — the community grid/rows collapse properly** (inside §64.3, shown above): the grid uses
`minmax(min(420px, 100%), 1fr)` so a track can never exceed the viewport, and at ≤640px the rows switch to
`flex-wrap: wrap` with the action buttons on their own full-width row.

**Fix C — the real mobile overflow bug** is documented separately in §9.

---

## 5. Change 3 — Team member descriptions: wrapping + Read More / Show Less

**Root cause.** Section 62 of `styles.css` deliberately clipped bios:

```css
.professor-card p, .alumni-bio, .friend-card p {
  display: -webkit-box !important;
  -webkit-line-clamp: 4 !important;      /* ← text cut off, no way to read it */
  overflow: hidden !important;
}
```

The clamp is a good idea (it stopped card overlap) — what was missing was a way to reveal the rest.

**New behaviour:** the 4-line clamp becomes the *collapsed* state; a `Read more` button appears **only when the
bio genuinely overflows**; tapping expands to the full text and the button becomes `Show less`. Long unbroken
strings now wrap (`white-space: normal` + `overflow-wrap: anywhere`).

### 5.1 `styles.css` §64.4 + §64.8 + §64.9 — APPEND

````css
/* ------------------------------------------------------------
   64.4  TEAM / ALUMNI BIOS — Read More / Show Less
   The 4-line clamp stays as the COLLAPSED state (clean UI);
   `.is-expanded` lifts it so the full text is readable.
   Long unbroken words can never overflow (white-space: normal
   + overflow-wrap: anywhere).
   ------------------------------------------------------------ */
.professor-card p.bio-text,
.alumni-card  .alumni-bio.bio-text,
.friend-card  p.bio-text {
  display: -webkit-box !important;
  -webkit-box-orient: vertical !important;
  -webkit-line-clamp: 4 !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: normal !important;
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
  line-height: 1.55 !important;
  flex: 1 1 auto !important;
}
.professor-card p.bio-text.is-expanded,
.alumni-card  .alumni-bio.bio-text.is-expanded,
.friend-card  p.bio-text.is-expanded {
  display: block !important;
  -webkit-line-clamp: unset !important;
  overflow: visible !important;
  text-overflow: clip !important;
}

.bio-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 44px;          /* ⭐ 44px touch target */
  min-width: 44px;
  margin: 2px auto 10px;
  padding: 8px 14px;
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: .2px;
  color: var(--brand-600);
  background: transparent;
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-pill);
  cursor: pointer;
  transition: background .2s var(--ease), color .2s var(--ease), border-color .2s var(--ease);
}
.bio-toggle:hover { background: rgba(99,102,241,.10); border-color: var(--brand-400); }
.bio-toggle i { transition: transform .3s var(--ease); }
.bio-toggle.is-open i { transform: rotate(180deg); }
[data-theme="dark"] .bio-toggle,
[data-theme="dim"]  .bio-toggle { color: var(--brand-300); }
.bio-toggle[hidden] { display: none !important; }
````

````css
/* ------------------------------------------------------------
   64.8  BIO / ALUMNI BODY LAYOUT DETERMINISM
   .alumni-body had no rules, so it shrink-wrapped its content
   instead of filling the card. Making it an explicit flex
   column keeps the bio + toggle full width and lets the
   existing `margin-top:auto` on .alumni-contact actually pin
   the contact row to the bottom of the card.
   ------------------------------------------------------------ */
.alumni-body {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

/* Bios always fill their card so line-clamp wrapping is predictable */
.professor-card .bio-text,
.friend-card    .bio-text,
.alumni-card    .bio-text { width: 100%; }

/* The toggle sits centred under the bio */
.professor-card .bio-toggle,
.friend-card    .bio-toggle,
.alumni-card    .bio-toggle { align-self: center; }

/* Community cards must never be squashed by a wide neighbour */
.community-info, .community-bio { min-width: 0; }

/* ------------------------------------------------------------
   64.9  COMMUNITY ROW BIOS — clamp + Read More
   The admin community list used to hard-slice bios at 200
   characters. It now renders the full text, clamped to 3 lines,
   with the same Read More / Show Less control as team cards.
   ------------------------------------------------------------ */
.community-bio.bio-text {
  display: -webkit-box !important;
  -webkit-box-orient: vertical !important;
  -webkit-line-clamp: 3 !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: normal !important;
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
}
.community-bio.bio-text.is-expanded {
  display: block !important;
  -webkit-line-clamp: unset !important;
  overflow: visible !important;
  text-overflow: clip !important;
}
.community-info .bio-toggle {
  align-self: flex-start;
  margin: 6px 0 0;
}
````

### 5.2 `app.js` — the bio helpers (ADD)

Insert with the theme block (immediately after `initBioToggles()`), or anywhere at top level:

````js
const BIO_MORE_HTML = '<i class="fas fa-chevron-down"></i> Read more';
const BIO_LESS_HTML = '<i class="fas fa-chevron-up"></i> Show less';

/* Markup for one biography: clamped text + its toggle button.
   The button is a SIBLING of the text node and sits IMMEDIATELY
   after it, because toggleBio() walks to previousElementSibling.
   `tag` lets the same helper serve <p> (team cards) and
   <div> (community admin rows). */
function bioMarkup(text, extraClass, tag) {
  const safe = escapeHtml(text || '');
  if (!safe) return '';
  const el = tag || 'p';
  const cls = 'bio-text' + (extraClass ? ' ' + extraClass : '');
  return `<${el} class="${cls}">${safe}</${el}>` +
         `<button type="button" class="bio-toggle" hidden aria-expanded="false" ` +
         `onclick="toggleBio(this)">${BIO_MORE_HTML}</button>`;
}

function toggleBio(btn) {
  if (!btn) return;
  const text = btn.previousElementSibling;
  if (!text) return;

  const expanded = text.classList.toggle('is-expanded');
  btn.classList.toggle('is-open', expanded);
  btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  btn.innerHTML = expanded ? BIO_LESS_HTML : BIO_MORE_HTML;
}

function expandAllBios() {
  document.querySelectorAll('.bio-toggle').forEach(btn => {
    const text = btn.previousElementSibling;
    if (text) text.classList.add('is-expanded');
    btn.hidden = true;              // the control is redundant when forced open
    btn.classList.remove('is-open');
  });
}

function collapseAllBios() {
  document.querySelectorAll('.bio-toggle').forEach(btn => {
    const text = btn.previousElementSibling;
    if (text) text.classList.remove('is-expanded');
    btn.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = BIO_MORE_HTML;
  });
  revealOverflowingBios();
}

/* Reveals a toggle only where the clamped bio actually overflows. */
function revealOverflowingBios() {
  document.querySelectorAll('.bio-toggle').forEach(btn => {
    if (prefersExpandedBios()) { btn.hidden = true; return; }
    const text = btn.previousElementSibling;
    if (!text) { btn.hidden = true; return; }
    /* ⚠️ A bio the user has already expanded must KEEP its "Show less"
       control — an expanded bio no longer overflows, so the overflow test
       below would otherwise hide the button and trap the user in the
       expanded state. */
    if (text.classList.contains('is-expanded')) { btn.hidden = false; return; }
    btn.hidden = text.scrollHeight <= text.clientHeight + 2;
  });
}

/* Call after rendering any grid that contains biographies. */
function initBioToggles() {
  if (prefersExpandedBios()) { expandAllBios(); return; }
  revealOverflowingBios();
  /* Re-measure once webfonts settle — clamp height can shift slightly. */
  if (document.fonts && document.fonts.ready && !initBioToggles._wired) {
    initBioToggles._wired = true;
    document.fonts.ready.then(() => { try { revealOverflowingBios(); } catch (e) {} });
  }
}
````

> The `is-expanded` guard in `revealOverflowingBios()` fixes a bug found during visual verification: without it,
> the `document.fonts.ready` re-measure would hide the `Show less` button the moment a bio was expanded,
> leaving the user unable to collapse it again. There is a dedicated regression assertion for this.

### 5.3 `app.js` — wire it into the three renderers (REPLACE)

**`renderProfessorsGrid()` — before**

````js
        <div class="prof-title">${escapeHtml(p.title)}</div>
        <p>${escapeHtml(p.description) || ''}</p>
        ${contactButtons.length ? `<div class="team-contact-row">${contactButtons.join('')}</div>` : ''}
      </div>`;
  });

  grid.innerHTML = html;
}
````

**after**

````js
        <div class="prof-title">${escapeHtml(p.title)}</div>
        ${bioMarkup(p.description)}
        ${contactButtons.length ? `<div class="team-contact-row">${contactButtons.join('')}</div>` : ''}
      </div>`;
  });

  grid.innerHTML = html;
  initBioToggles();          /* ⭐ reveal Read more only where needed */
}
````

**`renderAlumniSection()` — before / after**

````js
// BEFORE
${a.bio ? `<p class="alumni-bio">${escapeHtml(a.bio)}</p>` : ''}
// AFTER
${a.bio ? bioMarkup(a.bio, 'alumni-bio') : ''}
````

**`renderFriendsSection()` — before / after**

````js
// BEFORE
<div class="prof-title">${escapeHtml(f.role || 'Supporter')}</div><p>${escapeHtml(f.bio || '')}</p>
// AFTER
<div class="prof-title">${escapeHtml(f.role || 'Supporter')}</div>${bioMarkup(f.bio)}
````

All three renderers also gained `initBioToggles();` immediately after `grid.innerHTML = html;`.

### 5.4 `app.js` — the admin community rows (REPLACE)

`renderCommunityList()` used to hard-slice the bio; it now renders the full text with the same control.

**Before**

````js
          ${x.bio ? `<div class="community-bio">${escapeHtml(x.bio.slice(0, 200))}${x.bio.length > 200 ? '…' : ''}</div>` : ''}
````

**After**

````js
          ${x.bio ? bioMarkup(x.bio, 'community-bio', 'div') : ''}
````

**And in `renderAdminCommunity()`, after `container.innerHTML = html;`:**

````js
    container.innerHTML = html;
    initBioToggles();        /* ⭐ reveal Read more only where needed */
````
---

## 6. Change 4 — Full-screen post-login shell

**Fix — `styles.css` §64.2 (APPEND):**

````css
/* ------------------------------------------------------------
   64.2  FULL-SCREEN POST-LOGIN SHELL
   The dashboard always fills the viewport height, and on
   tablets/phones the desktop "floating card" side gutters are
   removed so the app is genuinely edge-to-edge.
   ------------------------------------------------------------ */
#app {
  min-height: 100vh;
  min-height: 100dvh;          /* correct height with mobile browser chrome */
}
.main-content { flex: 1 1 auto; min-width: 0; }
.app-footer   { margin-top: auto; }
.view         { min-width: 0; }

@media (max-width: 1024px) {
  #app {
    max-width: 100%;
    box-shadow: none;
    border-left: 0;
    border-right: 0;
  }
}

@media (max-width: 860px) {
  /* background-attachment:fixed is janky on iOS — pin it to scroll */
  body { background-attachment: scroll; }
}
````

`100dvh` is the dynamic viewport height: it accounts for the collapsing URL bar on iOS/Android Safari, which
`100vh` does not — that is what causes the classic "dashboard doesn't quite reach the bottom" gap.

---

## 7. Change 5 — Night Mode (centralized theme configuration)

**What already existed:** a three-way `light → dim → dark` cycle on a header button, `localStorage` persistence
and `prefers-color-scheme` detection. **What was missing:** a single configuration source, a settings UI, a real
toggle switch, and a dark palette matching the brief (dark grey / off-white / softer accents).

### 7.1 `styles.css` — retune the Night palette

Applied to the existing `[data-theme="dark"]` block. The **id stays `dark`** on purpose: 322 existing
`[data-theme="dark"]` component overrides keep working, so no component CSS had to be rewritten.

**Before**

````css
/* ─── DARK THEME — "Midnight Launch" (deep space blue-violet) ─── */
[data-theme="dark"] {
  --bg-page: #05060e;
  --bg-page-accent-1: rgba(99,102,241,.16);
  --bg-page-accent-2: rgba(6,182,212,.10);
  --bg-surface: #0c1020;
  --bg-surface-2: #131832;
  --bg-surface-3: #1c2246;
  --bg-elevated: #131832;

  --border-subtle: #1a2142;
  --border-default: #262f5a;
  --border-strong: #3b4781;

  --text-primary: #eef0f6;
  --text-secondary: #b8bdd1;
  --text-tertiary: #7b82a3;
  --text-inverse: #05060e;

  --shadow-xs: 0 1px 2px rgba(0,0,0,.6);
  --shadow-sm: 0 1px 3px rgba(0,0,0,.7);
  --shadow-md: 0 8px 20px rgba(0,0,0,.65);
  --shadow-lg: 0 20px 48px rgba(0,0,0,.7);
  --shadow-xl: 0 32px 72px rgba(0,0,0,.8);

  --header-bg: linear-gradient(135deg, #02030a 0%, #080d24 50%, #14093a 100%);
  --header-border: rgba(129,140,248,.35);
}
````

**After**

````css
/* ─── NIGHT THEME ("dark") — neutral dark grey · off-white text ·
       softer accents. Kept under the data-theme="dark" id so every
       existing [data-theme="dark"] component override keeps working. ─── */
[data-theme="dark"] {
  --bg-page: #101216;          /* page = darkest layer */
  --bg-page-accent-1: rgba(99,102,241,.10);   /* softened glows */
  --bg-page-accent-2: rgba(6,182,212,.06);
  --bg-surface: #181b20;       /* cards / app shell */
  --bg-surface-2: #1f2329;
  --bg-surface-3: #272c33;
  --bg-elevated: #1f2329;

  --border-subtle: #262b32;
  --border-default: #333a43;
  --border-strong: #47505c;

  --text-primary: #eceef1;     /* off-white, ~13:1 on --bg-surface */
  --text-secondary: #b6bac1;
  --text-tertiary: #868c96;
  --text-inverse: #101216;

  --shadow-xs: 0 1px 2px rgba(0,0,0,.50);
  --shadow-sm: 0 1px 3px rgba(0,0,0,.60);
  --shadow-md: 0 8px 20px rgba(0,0,0,.55);
  --shadow-lg: 0 20px 48px rgba(0,0,0,.60);
  --shadow-xl: 0 32px 72px rgba(0,0,0,.70);

  --header-bg: linear-gradient(135deg, #0c0e12 0%, #15181e 55%, #1d2129 100%);
  --header-border: rgba(255,255,255,.10);
}
````

**Also retuned** — 7 hard-coded values in `styles.css` and 6 in `landing.html` still used the old near-black navy
(`rgba(5,6,14,…)`, `#02030a`, `#0a0f30`, `#1a0b4a`, `#0c1020`), which would have clashed with the neutral grey
surfaces:

```
rgba(5,6,14,  ->  rgba(16,18,22,
linear-gradient(135deg, #02030a 0%, #0a0f30 50%, #1a0b4a 100%)   ->  ..(#14171c 0%, #1b1f26 50%, #242a3a 100%)
linear-gradient(135deg, #02030a 0%, #0a0f30 55%, #1a0b4a 100%)   ->  ..(#14171c 0%, #1b1f26 55%, #242a3a 100%)
var(--bg-surface, #0c1020)                                       ->  var(--bg-surface, #181b20)
```

### 7.2 `styles.css` §64.1 — the 0.3s transition contract

````css
   64.1  CENTRALIZED THEME TRANSITION CONTRACT
   One place to tune the Light <-> Night colour animation.
   `aero-theme-anim` is applied to <html> for ~320ms around a
   theme change so the colour fade is smooth without
   permanently overriding any component's own transitions.
   ------------------------------------------------------------ */
:root {
  --theme-dur: .3s;
  --theme-ease: ease;
  --theme-transition:
    background-color var(--theme-dur) var(--theme-ease),
    border-color     var(--theme-dur) var(--theme-ease),
    color            var(--theme-dur) var(--theme-ease),
    box-shadow       var(--theme-dur) var(--theme-ease);
}

html.aero-theme-anim,
html.aero-theme-anim *,
html.aero-theme-anim *::before,
html.aero-theme-anim *::after {
  transition:
    background-color var(--theme-dur) var(--theme-ease),
    border-color     var(--theme-dur) var(--theme-ease),
    color            var(--theme-dur) var(--theme-ease),
    fill             var(--theme-dur) var(--theme-ease),
    stroke           var(--theme-dur) var(--theme-ease),
    box-shadow       var(--theme-dur) var(--theme-ease) !important;
  transition-delay: 0s !important;
}

/* The always-on shell surfaces use the same contract */
body { transition: var(--theme-transition); }
#app { transition: var(--theme-transition); }

/* Softer accent glow in Night mode */
[data-theme="dark"] .btn-primary {
  box-shadow: 0 0 0 1px rgba(129,140,248,.18), 0 6px 18px rgba(99,102,241,.22);
}
[data-theme="dark"] .btn-accent {
  box-shadow: 0 0 0 1px rgba(34,211,238,.20), 0 6px 18px rgba(6,182,212,.22);
}
[data-theme="dark"] .premium-badge { box-shadow: 0 3px 10px rgba(245,158,11,.18); }
````

`html.aero-theme-anim` is added for 320ms around a theme change and then removed, so component animations are
never permanently overridden. `prefers-reduced-motion` disables it entirely.

### 7.3 `styles.css` §64.7 — Settings panel styling

````css
/* ------------------------------------------------------------
   64.7  SETTINGS PANEL (Night Mode control)
   ------------------------------------------------------------ */
.settings-section { margin-bottom: 22px; }
.settings-section:last-of-type { margin-bottom: 6px; }
.settings-section > h4 {
  margin-bottom: 10px;
  font-size: 11.5px;
  font-weight: 800;
  letter-spacing: .7px;
  text-transform: uppercase;
  color: var(--text-tertiary);
}
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 44px;
  padding: 12px 14px;
  background: var(--bg-surface-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}
.settings-row + .settings-row,
.settings-row + .theme-choices { margin-top: 8px; }
.settings-row-text { flex: 1 1 auto; min-width: 0; }
.settings-row-text strong {
  display: block;
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text-primary);
}
.settings-row-text span {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-tertiary);
}
.settings-row[hidden] { display: none !important; }

/* On/off switch — 60x44 hit area, 30px visual track */
.switch {
  position: relative;
  flex: 0 0 auto;
  width: 60px;
  height: 44px;
  min-width: 60px;
  min-height: 44px;
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.switch-track {
  position: relative;
  width: 54px;
  height: 30px;
  border-radius: 999px;
  background: var(--border-strong);
  transition: background var(--theme-dur) var(--theme-ease);
}
.switch-thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 2px 6px rgba(0,0,0,.35);
  transition: transform var(--theme-dur) var(--theme-ease);
}
.switch[aria-checked="true"] .switch-track {
  background: linear-gradient(135deg, var(--brand-600), var(--brand-500));
}
.switch[aria-checked="true"] .switch-thumb { transform: translateX(24px); }
.switch:focus-visible .switch-track { outline: 2px solid var(--brand-500); outline-offset: 3px; }

/* 3-way theme picker (Light / Dim / Night) */
.theme-choices { display: flex; gap: 8px; flex-wrap: wrap; }
.theme-choice {
  flex: 1 1 84px;
  min-width: 84px;
  min-height: 44px;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border: 2px solid var(--border-default);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color .2s var(--ease), background .2s var(--ease),
              color .2s var(--ease), box-shadow .2s var(--ease);
}
.theme-choice i { font-size: 14px; }
.theme-choice:hover { border-color: var(--brand-400); color: var(--text-primary); }
.theme-choice[aria-checked="true"] {
  border-color: var(--brand-500);
  background: rgba(99,102,241,.12);
  color: var(--brand-600);
  box-shadow: 0 0 0 3px rgba(99,102,241,.12);
}
[data-theme="dark"] .theme-choice[aria-checked="true"],
[data-theme="dim"]  .theme-choice[aria-checked="true"] { color: var(--brand-200); }
.theme-choice[hidden] { display: none !important; }

@media (prefers-reduced-motion: reduce) {
  html.aero-theme-anim,
  html.aero-theme-anim *,
  html.aero-theme-anim *::before,
  html.aero-theme-anim *::after { transition: none !important; }
  .switch-track, .switch-thumb { transition: none !important; }
}
````

### 7.4 `app.js` — replace the old theme block

**Before**

````js
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
````

**After** (the whole `THEME_CONFIG` registry + transition handling + settings + bio helpers block)

````js
/* ============================================================
   ⭐ CENTRALIZED THEME CONFIGURATION
   ------------------------------------------------------------
   Single source of truth for every theme in the app.

     id       → the value written to <html data-theme="...">
     family   → 'light' | 'dark'  (drives the Night Mode switch)
     label    → user-facing name
     icon     → Font Awesome class for the header button
     palette  → human description shown in Settings
     next     → what the header quick-cycle button moves to

   Adding a theme later = one entry here + one [data-theme="x"]
   CSS variable block. Nothing else in the codebase changes.
   ============================================================ */
const THEME_CONFIG = {
  order: ['light', 'dim', 'dark'],
  themes: {
    light: {
      id: 'light', family: 'light', label: 'Light', icon: 'fa-sun',
      palette: 'warm, bright, high contrast', next: 'dim',
      ariaLabel: 'Light mode — click for Dim'
    },
    dim: {
      id: 'dim', family: 'dark', label: 'Dim', icon: 'fa-circle-half-stroke',
      palette: 'soft dark grey, low glare', next: 'dark',
      ariaLabel: 'Dim mode — click for Night'
    },
    dark: {
      id: 'dark', family: 'dark', label: 'Night', icon: 'fa-moon',
      palette: 'dark grey surfaces with off-white text', next: 'light',
      ariaLabel: 'Night mode — click for Light'
    }
  }
};
const THEME_CYCLE = THEME_CONFIG.order;

function getThemeMeta(theme) {
  return THEME_CONFIG.themes[theme] || THEME_CONFIG.themes.light;
}
function getCurrentTheme() {
  const t = document.documentElement.getAttribute('data-theme') || 'light';
  return THEME_CONFIG.themes[t] ? t : 'light';
}
function isNightMode() {
  return getThemeMeta(getCurrentTheme()).family === 'dark';
}

/* ------------------------------------------------------------
   ⭐ 0.3s EASE COLOUR TRANSITION around every theme change.
   `aero-theme-anim` is added to <html> for ~320ms so the whole
   UI cross-fades, then removed so no component's own animation
   is permanently overridden.
   ------------------------------------------------------------ */
const THEME_ANIM_CLASS = 'aero-theme-anim';
const THEME_ANIM_MS = 320;              // slightly > the .3s CSS duration
let _themeAnimTimer = null;

function _prefersReducedMotion() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) { return false; }
}

function _withThemeTransition(mutate) {
  const root = document.documentElement;
  if (!_prefersReducedMotion()) root.classList.add(THEME_ANIM_CLASS);
  try {
    mutate();
  } finally {
    if (_themeAnimTimer) clearTimeout(_themeAnimTimer);
    _themeAnimTimer = setTimeout(() => {
      root.classList.remove(THEME_ANIM_CLASS);
      _themeAnimTimer = null;
    }, THEME_ANIM_MS);
  }
}

function applyTheme(theme) {
  const id = THEME_CONFIG.themes[theme] ? theme : 'light';

  _withThemeTransition(() => {
    document.documentElement.setAttribute('data-theme', id);
  });

  try { localStorage.setItem('aero_theme', id); } catch (e) {}
  updateThemeIcon();
  renderSettingsThemeUI();
}

function cycleTheme() {
  applyTheme(getThemeMeta(getCurrentTheme()).next);
}

function updateThemeIcon() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const meta = getThemeMeta(getCurrentTheme());
  btn.innerHTML = `<i class="fas ${meta.icon}" aria-hidden="true"></i>`;
  btn.setAttribute('aria-label', meta.ariaLabel);
  btn.setAttribute('title', meta.ariaLabel);
}

/* ============================================================
   ⭐ SETTINGS PANEL — Night Mode + reading preferences
   ============================================================ */
function closeUserDropdown() {
  const wrap = document.getElementById('userProfileWrap');
  if (wrap) wrap.classList.remove('open');
}

function renderSettingsThemeUI() {
  const theme = getCurrentTheme();
  const meta = getThemeMeta(theme);
  const night = meta.family === 'dark';

  const nightSwitch = document.getElementById('nightModeSwitch');
  if (nightSwitch) nightSwitch.setAttribute('aria-checked', night ? 'true' : 'false');

  /* The "Dim instead of Night" row only matters while Night mode is on */
  const dimRow = document.getElementById('dimModeRow');
  if (dimRow) dimRow.hidden = !night;

  const dimSwitch = document.getElementById('dimModeSwitch');
  if (dimSwitch) dimSwitch.setAttribute('aria-checked', theme === 'dim' ? 'true' : 'false');

  document.querySelectorAll('[data-theme-choice]').forEach(btn => {
    const on = btn.getAttribute('data-theme-choice') === theme;
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  });

  const hint = document.getElementById('nightModeHint');
  if (hint) {
    hint.textContent = night
      ? `${meta.label} theme active — ${meta.palette}.`
      : 'Dark grey background with off-white text — easier on the eyes at night.';
  }
}

function openSettingsModal() {
  renderSettingsThemeUI();
  renderExpandBiosUI();
  openModal('settingsModal');
}

/* Header switch: OFF → Light, ON → Night. Never lands on Dim by accident. */
function toggleNightMode() {
  applyTheme(isNightMode() ? 'light' : 'dark');
}

/* Sub-option of Night mode */
function toggleDimMode() {
  applyTheme(getCurrentTheme() === 'dim' ? 'dark' : 'dim');
}

function setThemeFromSettings(theme) {
  applyTheme(theme);
}

/* ------------------------------------------------------------
   ⭐ "Always expand biographies" preference
   ------------------------------------------------------------ */
const EXPAND_BIOS_KEY = 'aero_expand_bios';

function prefersExpandedBios() {
  try { return localStorage.getItem(EXPAND_BIOS_KEY) === '1'; } catch (e) { return false; }
}
function renderExpandBiosUI() {
  const sw = document.getElementById('expandBiosSwitch');
  if (sw) sw.setAttribute('aria-checked', prefersExpandedBios() ? 'true' : 'false');
}
function toggleExpandBios() {
  const next = !prefersExpandedBios();
  try { localStorage.setItem(EXPAND_BIOS_KEY, next ? '1' : '0'); } catch (e) {}
  renderExpandBiosUI();
  if (prefersExpandedBios()) expandAllBios(); else collapseAllBios();
}

/* ------------------------------------------------------------
   ⭐ BIO "READ MORE / SHOW LESS"
   ------------------------------------------------------------
   Bios are clamped to 4 lines by CSS (clean cards, no overlap).
   The toggle only appears when the text genuinely overflows its
   clamp, so short bios never show a pointless button.
   ------------------------------------------------------------ */
const BIO_MORE_HTML = '<i class="fas fa-chevron-down"></i> Read more';
const BIO_LESS_HTML = '<i class="fas fa-chevron-up"></i> Show less';

/* Markup for one biography: clamped text + its toggle button.
   The button is a SIBLING of the text node and sits IMMEDIATELY
   after it, because toggleBio() walks to previousElementSibling.
   `tag` lets the same helper serve <p> (team cards) and
   <div> (community admin rows). */
function bioMarkup(text, extraClass, tag) {
  const safe = escapeHtml(text || '');
  if (!safe) return '';
  const el = tag || 'p';
  const cls = 'bio-text' + (extraClass ? ' ' + extraClass : '');
  return `<${el} class="${cls}">${safe}</${el}>` +
         `<button type="button" class="bio-toggle" hidden aria-expanded="false" ` +
         `onclick="toggleBio(this)">${BIO_MORE_HTML}</button>`;
}

function toggleBio(btn) {
  if (!btn) return;
  const text = btn.previousElementSibling;
  if (!text) return;

  const expanded = text.classList.toggle('is-expanded');
  btn.classList.toggle('is-open', expanded);
  btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  btn.innerHTML = expanded ? BIO_LESS_HTML : BIO_MORE_HTML;
}

function expandAllBios() {
  document.querySelectorAll('.bio-toggle').forEach(btn => {
    const text = btn.previousElementSibling;
    if (text) text.classList.add('is-expanded');
    btn.hidden = true;              // the control is redundant when forced open
    btn.classList.remove('is-open');
  });
}

function collapseAllBios() {
  document.querySelectorAll('.bio-toggle').forEach(btn => {
    const text = btn.previousElementSibling;
    if (text) text.classList.remove('is-expanded');
    btn.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = BIO_MORE_HTML;
  });
  revealOverflowingBios();
}

/* Reveals a toggle only where the clamped bio actually overflows. */
function revealOverflowingBios() {
  document.querySelectorAll('.bio-toggle').forEach(btn => {
    if (prefersExpandedBios()) { btn.hidden = true; return; }
    const text = btn.previousElementSibling;
    if (!text) { btn.hidden = true; return; }
    /* ⚠️ A bio the user has already expanded must KEEP its "Show less"
       control — an expanded bio no longer overflows, so the overflow test
       below would otherwise hide the button and trap the user in the
       expanded state. */
    if (text.classList.contains('is-expanded')) { btn.hidden = false; return; }
    btn.hidden = text.scrollHeight <= text.clientHeight + 2;
  });
}

/* Call after rendering any grid that contains biographies. */
function initBioToggles() {
  if (prefersExpandedBios()) { expandAllBios(); return; }
  revealOverflowingBios();
  /* Re-measure once webfonts settle — clamp height can shift slightly. */
  if (document.fonts && document.fonts.ready && !initBioToggles._wired) {
    initBioToggles._wired = true;
    document.fonts.ready.then(() => { try { revealOverflowingBios(); } catch (e) {} });
  }
}
````

**And `initTheme()` — before / after:**

````js
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('aero_theme'); } catch {}
  const valid = ['light', 'dim', 'dark'];
  const prefers = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initial = valid.includes(saved) ? saved : (prefers ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', initial);
})();
````

````js
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('aero_theme'); } catch (e) {}
  const valid = THEME_CONFIG.order;                       // ⭐ centralized list
  const prefers = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const fallback = prefers ? 'dark' : 'light';
  const initial = valid.includes(saved) ? saved : fallback;
  /* Set before first paint — no transition, no flash. */
  document.documentElement.setAttribute('data-theme', initial);
})();
````

Adding a fourth theme later = one entry in `THEME_CONFIG.themes` + one `[data-theme="x"]` CSS block. Nothing else.

### 7.5 `index.html` — a Settings entry point in the header (ADD)

Insert inside `.user-info`, immediately **before** the existing `#themeToggle` button:

````html
        <!-- ⭐ Settings (contains the Night Mode toggle) -->
        <button class="icon-btn" id="settingsBtn" aria-label="Open settings" title="Settings"
                onclick="openSettingsModal()">
          <i class="fas fa-gear"></i>
        </button>

        <button class="icon-btn theme-toggle" id="themeToggle" aria-label="Toggle theme" title="Toggle theme">
          <i class="fas fa-moon"></i>
        </button>
````

### 7.6 `index.html` — a Settings item in the profile dropdown (ADD)

Insert between the `.user-dropdown-divider` and the Logout button:

````html
            <button class="user-dropdown-item" onclick="closeUserDropdown(); openSettingsModal();">
              <i class="fas fa-gear"></i> Settings
            </button>
````

### 7.7 `index.html` — the Settings modal (ADD)

Insert after the `grantPremiumModal` block:

````html
  <!-- ============ ⭐ SETTINGS MODAL — APPEARANCE / NIGHT MODE ============ -->
  <div class="modal-overlay" id="settingsModal">
    <div class="modal-box" style="max-width:520px;">
      <h3><i class="fas fa-gear"></i> Settings</h3>
      <p class="modal-sub">Personalise how AeroGyan looks on this device. Your choice is remembered.</p>

      <div class="settings-section">
        <h4><i class="fas fa-palette"></i> Appearance</h4>

        <!-- Primary Night Mode switch -->
        <div class="settings-row">
          <div class="settings-row-text">
            <strong>Night mode</strong>
            <span id="nightModeHint">Dark grey background with off-white text — easier on the eyes at night.</span>
          </div>
          <button type="button" class="switch" id="nightModeSwitch" role="switch"
                  aria-checked="false" aria-label="Toggle Night mode"
                  onclick="toggleNightMode()">
            <span class="switch-track"><span class="switch-thumb"></span></span>
          </button>
        </div>

        <!-- Sub-option: softer "Dim" dark theme (only when Night mode is on) -->
        <div class="settings-row" id="dimModeRow" hidden>
          <div class="settings-row-text">
            <strong>Dim instead of Night</strong>
            <span>Softer, lower-contrast grey — good for dim rooms and OLED screens.</span>
          </div>
          <button type="button" class="switch" id="dimModeSwitch" role="switch"
                  aria-checked="false" aria-label="Use the softer Dim theme"
                  onclick="toggleDimMode()">
            <span class="switch-track"><span class="switch-thumb"></span></span>
          </button>
        </div>

        <!-- Full three-way picker (Light / Dim / Night) -->
        <div class="theme-choices" id="themeChoices" role="radiogroup" aria-label="Theme">
          <button type="button" class="theme-choice" data-theme-choice="light" role="radio"
                  aria-checked="false" onclick="setThemeFromSettings('light')">
            <i class="fas fa-sun"></i> Light
          </button>
          <button type="button" class="theme-choice" data-theme-choice="dim" role="radio"
                  aria-checked="false" onclick="setThemeFromSettings('dim')">
            <i class="fas fa-circle-half-stroke"></i> Dim
          </button>
          <button type="button" class="theme-choice" data-theme-choice="dark" role="radio"
                  aria-checked="false" onclick="setThemeFromSettings('dark')">
            <i class="fas fa-moon"></i> Night
          </button>
        </div>
      </div>

      <div class="settings-section">
        <h4><i class="fas fa-mobile-screen-button"></i> Reading</h4>

        <div class="settings-row">
          <div class="settings-row-text">
            <strong>Always expand biographies</strong>
            <span>Show full team, alumni and supporter bios without a “Read more” tap.</span>
          </div>
          <button type="button" class="switch" id="expandBiosSwitch" role="switch"
                  aria-checked="false" aria-label="Always expand biographies"
                  onclick="toggleExpandBios()">
            <span class="switch-track"><span class="switch-thumb"></span></span>
          </button>
        </div>
      </div>

      <div class="modal-actions">
        <button type="button" class="btn btn-primary" onclick="closeModal('settingsModal')">
          <i class="fas fa-check"></i> Done
        </button>
      </div>
    </div>
  </div>
````

> `closeUserDropdown()` is new in `app.js`; it removes the `.open` class from `#userProfileWrap`.

### 7.8 Fix: the theme toggle was hidden on small phones

`styles.css` had, at `max-width: 380px`:

```css
.theme-toggle { display: none; }   /* the only way to change theme disappeared */
```

§64.5 overrides it (later in the file, so it wins the cascade):

```css
@media (max-width: 380px) {
  .theme-toggle { display: inline-flex !important; }
}
```
---

## 8. Changes 6–8 — Transitions, lazy loading, touch targets

### 8.1 Smooth 0.3s transitions

Covered in §7.2. Summary: one CSS custom-property pair (`--theme-dur: .3s`, `--theme-ease: ease`), one
temporary `.aero-theme-anim` class on `<html>`, one `_withThemeTransition()` wrapper in `applyTheme()`.
Tune it in exactly one place — the `:root` block in §64.1.

### 8.2 Lazy loading

`loading="lazy"` was already present on every content image in the app. The remaining gap was decode-time
jank, so **`decoding="async"` was added to all 16 `<img>` tags in `app.js`** (a mechanical, behaviour-neutral change):

```
app.js: 16 <img> tags -> all now carry decoding="async"  (14 of 16 also carry loading="lazy")
```

The two without `loading="lazy"` are the local file-preview images (`.thumbnail-preview`, `.owner-preview-img`),
which are deliberately eager so a freshly chosen file shows immediately.

Layout shift is prevented for free now that every community/team avatar has a CSS-defined square box.

### 8.3 44×44 touch targets

**`styles.css` §64.5 (APPEND):**

````css
/* ------------------------------------------------------------
   64.5  TOUCH TARGETS — 44x44 minimum
   Dense media-player internals (zoom/scrub/crayon controls) are
   deliberately excluded: inflating them breaks the player.
   ------------------------------------------------------------ */
.icon-btn,
.nav-toggle {
  width: 44px;
  height: 44px;
  min-width: 44px;
  min-height: 44px;
}

/* The header theme button is the primary Night Mode switch —
   it must never disappear on small phones. */
@media (max-width: 380px) {
  .theme-toggle { display: inline-flex !important; }
}

@media (pointer: coarse), (max-width: 640px) {
  .btn,
  .contact-chip,
  .admin-tab,
  .main-nav a,
  .user-dropdown-item,
  .user-profile-btn,
  .link-inline,
  .notif-mark-all,
  .selection-master-checkbox,
  .bio-toggle,
  .theme-choice,
  .settings-row,
  .section-card a.link-inline,
  .app-footer a {
    min-height: 44px;
  }
  .btn-sm { padding: 10px 14px; }
  .admin-tab { display: inline-flex; align-items: center; }
  .user-dropdown-item { display: flex; align-items: center; }
  .main-nav a { display: flex; align-items: center; }
}
````

Measured at 390px: header gear / theme / notifications / search = **44×44**, Night switch = **60×44**,
theme choices = **≥44** tall, `Read more` = **44** tall.

> **Deliberate exception:** the dense media-player internals (`.pdfv-color`, video scrubber, `.vp-btn`) keep their
> compact sizing. Inflating a 20px colour swatch or a video toolbar button to 44px makes the player unusable —
> those controls are already ≥34px and sit in a dedicated full-screen surface.

---

## 9. Bonus fix — mobile horizontal overflow (pre-existing)

**Symptom:** at 390px wide the document was **463px** wide — a 73px horizontal overflow (page could be dragged
sideways).

**Cause:** `.notif-wrap` is `position: relative`, so the notification dropdown's containing block was that
**44px-wide** wrapper. The mobile rule `left: 8px; right: 8px` then produced a 360px-wide box anchored to the
button — its right edge landed at ~463px.

```
div#notifDropdown.notif-dropdown   right=463  w=360   (viewport = 390)
```

**Fix — `styles.css` §64.10 (APPEND):**

````css
/* ------------------------------------------------------------
   64.10  MOBILE HORIZONTAL-OVERFLOW FIX (notifications dropdown)
   ------------------------------------------------------------
   Pre-existing bug: `.notif-wrap` is `position: relative`, so the
   dropdown's containing block was that 44px-wide wrapper. The
   ≤640px rule `left: 8px; right: 8px` then produced a 360px-wide
   box starting at the button (right edge ~463px on a 390px
   screen) — a horizontal overflow of ~73px.
   Dropping the wrapper's positioning context lets the dropdown
   anchor to #appHeader (position: sticky) and span the viewport.
   Safe because the unread badge is positioned by `.notif-btn`
   (`position: relative`), not by `.notif-wrap`.
   ------------------------------------------------------------ */
@media (max-width: 640px) {
  .notif-wrap { position: static; }
  .user-info  { position: static; }
  .notif-dropdown {
    top: calc(100% + 6px);
    left: 8px;
    right: 8px;
    width: auto;
    max-width: none;
  }
}
````

Safe because the unread badge is positioned by `.notif-btn` (`position: relative`), **not** by `.notif-wrap`.
Result: `scrollWidth == innerWidth` at 320 / 360 / 390 / 414 / 480 / 640 / 768 / 834 / 1024 / 1280 / 1440.

---

## 10. Cache-busting (REQUIRED)

| file | change |
|------|--------|
| `index.html` | every `?v=106` → `?v=107` (10 URLs) |
| `index.html` | `navigator.serviceWorker.register('/sw.js?v=104')` → `?v=107` |
| `landing.html` | every `?v=106` → `?v=107` (8 URLs) |
| `sw.js` | `aero-shell-v106` → `aero-shell-v107`, header comment `v51` → `v52` |

`server.js` serves `app.js` / `styles.css` / `media-viewer.js` with an mtime-based ETag + `immutable` caching, so
JS/CSS are picked up automatically; the `?v=` bump is belt-and-braces and forces the service worker to re-install.

---

## 11. Deploy checklist

1. Upload: `app.js`, `index.html`, `landing.html`, `styles.css`, `sw.js`
   (`server.js` and `manifest.json` are **unchanged** in this round — they were already deployed with the previous update.)
2. **No server restart is required** — no route, middleware or schema changed. Only if you also re-upload `server.js` from the previous round would a restart be needed.
3. Hard-refresh `/app` (the new `?v=107` URLs plus the SW cache bump handle the rest).
4. Verify by hand:
   - Open Settings (gear icon, or profile menu → Settings). Flip **Night mode** — the whole UI should cross-fade over ~0.3s and stay dark after a reload.
   - Open the browser at ~380px wide and confirm the Settings gear and theme button are still visible and tappable.
   - Admin → Community: no image should be larger than a 52px circle.
   - Our Team: a long bio shows **Read more** → expands → **Show less** → collapses.
   - Drag the page sideways on a phone — it should not move.

---

## 12. Rollback

```bash
cd "/Users/Programming Content/Aerospace Portal IIT KGP"
cp /Users/Programming Content/_AeroGyan-Safety-Backups/20260930-122431/{app.js,index.html,landing.html,styles.css,sw.js} .
# restart is NOT required; clear the SW cache in DevTools or let the version change take effect
```

`sw.js`'s `CACHE_NAME` bump makes the service worker self-healing: the next load deletes the old cache and
re-installs the shell assets.

---

## 13. Deliberately NOT changed

- No API route, request shape, response field or DB schema was touched (`server.js` is byte-identical to the previous deployment).
- No existing CSS selector was deleted or rewritten — everything is an appended rule in section 64, plus the `[data-theme="dark"]` variable block and 13 hard-coded colours.
- The other two themes (`light`, `dim`) keep their exact palettes; `dim` is now presented as a sub-option of Night mode.
- Login, OTP, payments, quizzes, proctoring, premium gating, the 10-minute inactivity logout and the favicon work are untouched.
- Media-player internal control sizes are intentionally left compact (see §8.3).
- Feedback / Contributions admin lists still truncate long submission text at 200 characters; that truncation is
  intentional for scannability in review queues and is outside the "team member description" scope.
