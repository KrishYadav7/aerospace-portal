# AeroGyan Education — Full-Width Layout & UI/UX Pass

**Prepared:** 30 September 2026
**Round:** 2 (supersedes the incomplete full-bleed draft from the previous round)
**Scope:** the public landing page (`landing.html`) and the authenticated app (`index.html` + `styles.css` + `app.js`)
**Safety model:** every CSS change is an **appended** rule — nothing above it was edited or deleted. Every JS change is a **new, defensive function** placed after `initApp();`. No API route, request shape, response field, DB model or schema was touched. `server.js`, `manifest.json`, `media-viewer.js` and every file in `models/` are **byte-identical**.

---

## 0. Why the previous attempt did not fix it

The last round appended a `§65 FULL-BLEED SHELL` block to `styles.css` and reported it as done. Three problems:

1. **It was never deployed.** The block was an uncommitted working-tree change; `HEAD` — which is what the live server serves — still had `#app { max-width: 1280px; margin: 0 auto }`. The live site therefore still showed the 1280px column.
2. **It only covered the app.** The most visible side gaps were on the **landing page**, which was never touched. `.landing-container` and `.landing-nav-inner` were both capped at `max-width: 1240px`, so the public front page showed **340px of empty space on each side on a 1920px screen** and **660px on a 2560px screen**.
3. **It was half-finished.** The JS for the `.aero-scroll-progress` / `.aero-to-top` nodes the block styled was never added, and its `§65` heading collided with the existing `65. LIVE ACTIVITY` section.

This round fixes the shell, the landing page and the vertical waste, and finishes what was started.

---

## 1. What "empty space on the sides" actually was

Measured on the pristine `HEAD` build, in headless Chrome, with the real stylesheets:

### The app (`index.html`)

| viewport | shell width | usable content | dead gutter each side |
|---------:|------------:|---------------:|----------------------:|
| 1280px | 1280 | 1219 | 31 |
| 1440px | **1280** | 1216 | **112** |
| 1600px | **1280** | 1216 | **192** |
| 1920px | **1280** | 1216 | **352** |
| 2560px | **1280** | 1216 | **672** |

### The landing page (`landing.html`)

| viewport | content column | dead gutter each side |
|---------:|---------------:|----------------------:|
| 1024px | 976 | 24 |
| 1280px | 1232 | 24 |
| 1440px | **1240** | **100** |
| 1920px | **1240** | **340** |
| 2560px | **1240** | **660** |

A second, less obvious problem: **every one of the 13 landing sections was `min-height: 100vh` and vertically centred**, so the page ran to **13,464px** at 1440px wide — about fifteen screens, most of it empty.

---

## 2. The fix — one width system, three layers

The mistake a naive "make it all 100%" pass makes is that a lone card, a form, or the AI chat panel becomes an unreadable slab. So the width system separates three ideas that were previously conflated:

| layer | behaviour | where |
|---|---|---|
| **Shell** | edge-to-edge. Header, page canvas and footer always cover the whole window. | `styles.css` §70.2 / §70.3 |
| **Structure** (card grids, tables, dashboards) | fluid: grids **add columns** as the window grows instead of stretching cards | `styles.css` §70.4 / §70.11 |
| **Prose & tools** (running text, chat answers, lone forms) | keep a readable measure, centred on the canvas | `styles.css` §70.5 / §70.6 |

### The single number that drives it

```css
--content-max: min(2048px, 100%);
--shell-inset: max(var(--shell-pad), calc((100% - var(--content-max)) / 2));
```

`--shell-inset` is applied as `padding-inline` to `#appHeader`, `.main-content` and `.app-footer`. Because percentage padding resolves against the *parent's* inline size, all three compute an **identical** inset, so the brand, the cards and the footer line up pixel-perfect at every width. Any screen up to ~2170px wide is used **edge-to-edge with nothing but the gutter**; only a true ultrawide sees a margin, capped at 256px per side.

The landing page uses the same idea with its own scale (`--lp-gutter: clamp(20px, 2.5vw, 88px)`, `--lp-max: min(2320px, 100%)`).

---

## 3. Evidence — measured, not claimed

Harness: headless Chrome driven over the DevTools Protocol (`Emulation.setDeviceMetricsOverride`, so the CSS viewport is real, not Chrome's 500px minimum). Both builds — pristine `HEAD` on one origin, the modified build on another — were measured with **identical** scripts.

### 3.1 Side space is gone

**App** (`index.html`, login shell + `.main-content`):

| viewport | shell before → after | content before → after | gutter before → after |
|---------:|:--------------------:|:----------------------:|:---------------------:|
| 1280px | 1280 → 1280 | 1219 → 1226 | 31 → **27** |
| 1440px | 1280 → **1440** | 1216 → **1380** (+13%) | 112 → **30** |
| 1600px | 1280 → **1600** | 1216 → **1533** (+26%) | 192 → **34** |
| 1920px | 1280 → **1920** | 1216 → **1839** (+51%) | 352 → **40** |
| 2560px | 1280 → **2560** | 1216 → **2048** (+68%) | 672 → **256** |

**Landing page** (`.landing-container`):

| viewport | content column before → after | gutter before → after |
|---------:|:-----------------------------:|:---------------------:|
| 1024px | 976 → 973 | 24 → 26 |
| 1280px | 1232 → 1216 | 24 → 32 |
| 1440px | 1240 → **1368** | 100 → **36** |
| 1920px | 1240 → **1824** | 340 → **48** |
| 2560px | 1240 → **2320** | 660 → **120** |

### 3.2 The vertical waste is gone

Landing page document height (`document.documentElement.scrollHeight`):

| viewport | before | after |
|---------:|-------:|------:|
| 1440px | 13,464 | **10,039** (−25%) |
| 1920px | 13,464 | **10,574** |
| 2560px | 13,464 | **10,533** |
| 390px | 16,888 | 16,696 |
| 320px | 17,783 | 17,575 |

The hero keeps its full-window moment (`min-height: 100vh`); the other twelve sections now size to their content with a fluid `clamp()` rhythm.

### 3.3 Nothing overflows, nothing regressed

Full matrix — **14 viewports × 4 page states** (landing, app login, app student home, app admin):

| check | result |
|---|---|
| horizontal overflow (`scrollWidth − innerWidth`) | **0px at every viewport** on both pages |
| landing JS console errors | **0** |
| app JS console errors | identical to `HEAD` (2 — the `/api/...` 404s of a static preview with no backend) |
| elements wider than the viewport | only the pre-existing decorative hero orbs and marquee track, which are intentionally wider and clipped by `overflow-x: hidden` |

**Mobile/tablet are untouched.** The whole inset unification is scoped to `@media (min-width: 1025px)`, because below that the app was *already* edge-to-edge (`§64.2`) and its phone paddings are hand-tuned. A computed-style diff at 1024 / 900 / 834 / 768 / 640 / 480 / 390 / 360 / 320px is **identical, field for field**, to the live `HEAD` build:

```
 1024 IDENTICAL      640 IDENTICAL
  900 IDENTICAL      480 IDENTICAL
  834 IDENTICAL      390 IDENTICAL
  768 IDENTICAL      360 IDENTICAL
                     320 IDENTICAL
```

…including the `!important` rule that reserves 88px of bottom padding for the mobile bottom nav (still 88px), and the header's `14px` phone padding (still 14px).

### 3.4 The new pieces actually work

Verified in the real DOM against the real CSS:

| assertion | result |
|---|---|
| `styles.css` parses, §70 rules present in the CSSOM | 2170 rules, all new selectors found |
| only the cross-origin CDN sheets are opaque to the CSSOM | Google Fonts + Font Awesome (expected) |
| header inset == content inset == footer inset | **true** at 2560/1920/1600/1440/1280/1100 |
| brand's left edge == content column's left edge | **true** (256, 40, 33, 30, 26, 23 → identical) |
| AI "Try asking" chip pre-fills the composer | text matches, input focused |
| reading-progress bar tracks scroll | `12.41%` at 1139/9181 px on the landing page |
| back-to-top appears only after scrolling | hidden at y=0, visible at y>420 |
| `.hero-side` / `.ai-home-side` hidden below 1200px | `display:none` at 1100/1024/900/768/640/390 |
| landing navbar is a centred 3-zone grid | `display:grid`, links centre offset **0px** |
| no duplicate back-to-top on the landing page | landing keeps its own `.lp-btt`; `#aeroToTop` is **not** injected there |
| course grid fills the window | 9 cards → 5 columns × 349px at 1920, gutter 40px |

Screenshots (before/after, real renders): see the `shots/` folder next to this document.

---

## 4. File-by-file

### `styles.css` — `+434 / −0`

The incomplete `§65` draft (208 lines, uncommitted) was **replaced** by a complete, documented `§70 FULL-WIDTH LAYOUT SYSTEM (v2)`. Nothing above line 11204 is touched.

| § | what |
|---|---|
| 70.1 | the width system as tokens (`--content-max`, `--shell-pad`, `--shell-inset`, `--read-max`), plus `scroll-padding-top` so anchor jumps never land under the sticky header |
| 70.2 | `#app` edge-to-edge, bordered/shadowed shell chrome removed, soft brand wash so the former dead band reads as a designed canvas |
| 70.3 | one shared fluid inset for header / content / footer, **scoped to ≥1025px** so phones and tablets are untouched |
| 70.4 | grids stay fluid and add columns |
| 70.5 | prose measure (`82ch`) for running text |
| 70.6 | the AI console: hero and chat span the column; past 1400px only the *conversation* is given a measure (`1120px`) |
| 70.7 | systematic section-header hairline separators |
| 70.8 | wide-screen hero layouts: the student hero becomes `copy │ chips │ rocket`, the AI hero becomes `brand │ example prompts` |
| 70.9 | reading-progress bar + back-to-top chrome, incl. a `:has()` stand-down while an exam / PDF / video / modal owns the viewport (the same guard the mobile bottom nav already uses) |
| 70.10 | text selection + scrollbar polish |
| 70.11 | ultrawide tuning (≥1680px): larger card track minimums, larger banner padding |
| 70.12 | print + `prefers-reduced-motion` safety |

### `landing.html` — `+159 / −8`

* New `<style id="lp-fluid-layout">` **appended after both existing style blocks** (so it wins on equal specificity), covering: edge-to-edge navbar/content/footer, the removal of the per-section `min-height: 100vh`, the hero keeping the full-window moment, a 3-zone optically-centred navbar from **1280px up** (measured: 0px centre offset at 1280/1366/1440/1600/1920/2560 — and the original `space-between` flex row left completely untouched below that, because below 1280px the two `1fr` side tracks cannot be equal and "centring" would push the links 30–110px *off* centre), the `.lp-apps-grid` 1280px cap lifted, and ultrawide track minimums.
* A small self-contained `<script>` that adds **only** the reading-progress bar — the page already owns a back-to-top FAB (`.lp-btt`), so nothing is duplicated.
* `?v=107` → `?v=108` on all 8 asset references.

### `index.html` — `+48 / −11`

* Two **wide-screen-only** presentational blocks added to the two hero banners (both `display:none` below 1200px, neither has an `id` and neither is referenced by any existing JS):
  * `.hero-side` — the "What's inside" chip rail (Video Lectures / Lecture Notes / PYQs / Tutorials / Slides).
  * `.ai-home-side` — four "Try asking" example questions that pre-fill the AI composer.
* `?v=107` → `?v=108` (11 references).

### `app.js` — `+92 / −1`

Appended after the existing `initApp();`. Nothing above that line was edited.

* `aiHomeUsePrompt(btn)` — reads the clicked chip and hands the text to the **existing** `suggestAIPrompt()` helper; falls back to writing the textarea directly. Wrapped in `try/catch`, so a convenience chip can never surface an error.
* `aeroScrollChrome` — creates the progress bar and the back-to-top button in JS (so no markup contract changes), drives them from a single `requestAnimationFrame`-throttled passive scroll listener, and is idempotent (`window.__aeroScrollChromeReady`). If it never runs, the app is unaffected.

### `sw.js` — `+1 / −1`

`aero-shell-v107` → `aero-shell-v108`. The SW still refuses to cache app code (`app.js`, `styles.css`, `index.html`, `landing.html` are network-first), so the bump only purges stale static assets on activate.

### Untouched

`server.js`, `manifest.json`, `media-viewer.js`, `logo.svg`, `favicon.svg`, `logo-generator.html`, `package.json`, all of `models/`, all of `uploads/`, all icon PNGs. **No route, middleware, response shape or DB schema changed — so no server restart is required.**

---

## 5. Deploy

Backups (both live **outside** the deployable tree, so no rsync/CI glob can ever ship them):

```
pre-change   /Users/Programming Content/_AeroGyan-Safety-Backups/20260930-132453-pre-fullwidth/
delivered    /Users/Programming Content/_AeroGyan-Safety-Backups/20260930-140654-fullwidth-delivered/
             └── shots/   (before/after screenshots + comparison montages)
             └── final-matrix.json, key.json   (raw measurements)
```

Checksums (`shasum -a 256`) of the delivered files:

| file | sha256 |
|---|---|
| `styles.css` | `01db7206dfc4c388f573eb582bad17685640b706ecc3c6b935c6041c23f12454` |
| `index.html` | `653bd8e4e07c0f08d6d16a503599a49b00db4f3fa44ef85ad6e63e98bdf8a46f` |
| `landing.html` | `dd2a4472242c15aa50c050ef94b96cf617b9565f0efb79960dc1e13fffba00f3` |
| `app.js` | `815339636f08e8690a0b0432075c9548e8f828358fdebdfc73c01394b8dced36` |
| `sw.js` | `121bbd41908554790be702f07b8d1edd25e72e422b900c083c13c76aad43a9f2` |

Upload the five files (adjust the destination path to the app directory on the server):

```bash
cd "/Users/Programming Content/Aerospace Portal IIT KGP"
rsync -av --progress \
  styles.css index.html landing.html app.js sw.js \
  yadav@62.72.22.80:/var/www/aerogyan/
```

**No server restart is needed.** Only static front-end files changed; `server.js` is byte-identical.

Verify after upload:

```bash
for f in styles.css index.html landing.html app.js sw.js; do
  curl -s "https://<your-domain>/$f?cachecheck=$RANDOM" | shasum -a 256
done
```

The `?v=108` query strings and the `aero-shell-v108` SW cache mean returning visitors pick the new files up automatically on the next load; the SW then deletes the old cache on activate.

### If you prefer the changes to land as one commit

```bash
cd "/Users/Programming Content/Aerospace Portal IIT KGP"
git add styles.css index.html landing.html app.js sw.js
git commit -m "feat(ui): full-width layout system + wide-screen heroes + scroll chrome"
```

---

## 6. Rollback

```bash
cp "/Users/Programming Content/_AeroGyan-Safety-Backups/20260930-132453-pre-fullwidth/"{styles.css,index.html,landing.html,app.js,sw.js} \
   "/Users/Programming Content/Aerospace Portal IIT KGP/"
```

Then re-upload the same five files. Rolling back `sw.js` re-registers `aero-shell-v107`, which forces the old cache to be rebuilt — no manual cache clearing is needed for users.

To roll back **only** the layout (keep the new JS helpers), delete everything from the line `/* ============================================================` + `70. FULL-WIDTH LAYOUT SYSTEM` to the end of `styles.css`, and remove the `<style id="lp-fluid-layout">` and progress-bar `<script>` blocks from `landing.html`.

---

## 7. Deliberately NOT changed

* **No API, route, middleware or DB schema.** `server.js` byte-identical.
* **No inline JS function contract changed.** Every `onclick=` handler that existed still exists; the two new ones (`aiHomeUsePrompt`) are additive.
* **No phone/tablet layout changed.** Computed styles below 1025px are identical to `HEAD`.
* **No typographic measure widened.** Headlines, hero copy, FAQ and CTA keep `ch`/px caps — those are readability limits, not layout gaps, and widening them would have made the page worse on a large screen.
* **The chat console is not stretched to 2560px.** Its panel spans the full content column, but past 1400px the conversation itself is held at a readable 1120px, which is what every mature chat product does. Filling 2560px with one line of prose would be a regression dressed up as progress.
* **The app's existing `!important` header rules were not rewritten.** §70.3 matches their weight only for `padding-inline`, and only at ≥1025px, so the earlier header fix keeps working exactly as before.
* **No new files in the deployable tree.** Every harness, screenshot and report artefact lives in `/tmp/aero-shot/` or in `_AeroGyan-Safety-Backups/`.
