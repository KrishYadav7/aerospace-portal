# AeroGyan — AI Doubt Solver fix + model picker (2026-10-08)

## Why it said "rate limit reached" every time
The old code asked Google for its model list, sorted it **Pro first**, and tried only the **top 4**.
On this key those 4 were all Gemini *Pro* variants. Pro has a very small free quota, and the
preview Pro models are paid-only. So every question hit 429 on all four and failed. The fast
**Flash** models, which have a much bigger free quota, were never tried. `GROQ_API_KEY` was in `.env`
but nothing used it.

## What changed
- **New `ai-engine.js`** (no new npm packages):
  - two providers, **Google Gemini** (`GEMINI_API_KEY`) and **Groq** (`GROQ_API_KEY`); either one alone works
  - discovers the models each key can use (cached 10 min) and shows them with friendly names
  - **Auto** order: Gemini Flash → GPT-OSS 120B (Groq) → Gemini Pro → other Groq models → Flash-Lite
  - a model that returns 429/quota **rests for the time the provider asks for** (per-day limits: at least 1 h),
    so the next question skips it instantly
  - wrong key → that provider rests 10 min and the other provider answers
  - if a PDF/Word file is attached, only models that can read it are used (Gemini); images → Gemini
    (or a Groq vision model if your key has one)
  - `<think>` blocks from open models are removed from answers
- **Server routes**
  - `GET /api/ai/models` — list for the picker (with "busy" times)
  - `POST /api/admin/ai/test` — admin health check: asks every model for "OK", shows what works and why not
  - `POST /api/ai/chat` — accepts `model` (`auto` or e.g. `gemini:gemini-2.5-flash`), streams a `model` event
    when a model starts, and `done` says which model answered and whether it fell back
  - `POST /api/ai/solve-doubt` (course page AI box) uses the same engine
- **AI Solver page**
  - new **model button** in the composer (Auto / each model, with Fast · Deep reasoning · Images & PDFs tags,
    busy times). The choice is remembered on the device. Shows as a bottom sheet on phones.
  - while waiting: "Thinking · Gemini 2.5 Flash…" / "GPT-OSS 120B is busy — trying Gemini 2.5 Flash…"
  - under the answer: "X was busy, so Y answered." The model name chip shows who answered.
  - error card: **Try again**, **Try with Auto**, **Pick another model**
  - admins get **Test all models** in the picker

## Settings (server `.env`)
- `GEMINI_API_KEY` — Google AI Studio key (optional if Groq is set)
- `GROQ_API_KEY` — free key from console.groq.com (optional if Gemini is set). **Recommended:** it gives a
  second free quota, so students rarely see "busy".
- `AI_MODELS` — optional, pins models and order, e.g. `gemini-2.5-flash,openai/gpt-oss-120b`

## Files
`ai-engine.js` (new — remember to `git add` it), `server.js`, `app.js`, `styles.css`,
`index.html` (assets v140), `sw.js` (cache v141), `package.json`, `scripts/test-ai-engine.js` (new).

## Before deploying
1. `npm test` (includes `test-ai-engine.js`, which uses fake providers, so no keys are needed)
2. Make sure the VPS `.env` has `GROQ_API_KEY` too, then `pm2 restart`.
3. Log in as admin → AI Solver → model button → **Test all models**.
