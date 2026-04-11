# Climb Oral Exam Prep — Architecture Reference

## Overview

This is a serverless, single-page web application deployed on Cloudflare Pages. The frontend is plain HTML/CSS/JavaScript with no build step. Backend logic runs as Cloudflare Functions (edge workers). AI question generation and answer evaluation is handled by OpenAI's GPT-4o API, called server-side so the API key is never exposed to the browser.

---

## File Structure

```
oral-exam-prototype/
├── index.html                  # Single HTML page — all screens defined here
├── app.js                      # All frontend logic (session flow, LLM calls, UI)
├── styles.css                  # All styles
├── wrangler.toml               # Cloudflare Pages configuration
├── .gitignore
│
├── configs/
│   └── private_asel.json       # Exam configuration (areas, tasks, references, grounding notes)
│
├── prompts/
│   └── oral_exam_prompt.txt    # System prompt template injected into question generation calls
│
├── functions/
│   └── api/
│       ├── oral-exam.js        # Cloudflare Function: proxies OpenAI calls, validates token
│       └── flag.js             # Cloudflare Function: stores and retrieves flagged questions (requires KV)
│
└── local_pdfs/                 # gitignored — local supplemental PDFs (e.g. school SOP)
```

---

## Component Details

### `index.html`

Defines five named screens, only one visible at a time:

| Screen ID | Purpose |
|---|---|
| `loading` | Shown while config and first question load |
| `access-denied` | Shown when no `?token` param is present |
| `exam` | The main exam interface |
| `single-area-complete` | End screen for single-area mode with score and options |
| `complete` | End screen for full exam mode |
| `error-screen` | Generic error with retry button |

All screen switching is handled by `showScreen(id)` in `app.js`, which toggles the `hidden` class.

---

### `app.js`

Organized into numbered sections:

| Section | Responsibility |
|---|---|
| 1. Initialization | Reads URL params, loads config, triggers first question |
| 2. Screen Management | `showScreen()` |
| 3. Loaders | `loadJSON()`, `loadLocalText()` |
| 4. Performance Storage | localStorage read/write, per-area correct/partial/incorrect tracking |
| 5. Progress UI | Header progress bar and area/task label |
| 6. Session Flow | `askNextQuestion()`, `moveToNextTask()`, `moveToNextArea()`, adaptive review |
| 7. Prompt Builder | Fills `oral_exam_prompt.txt` template with session context |
| 8. LLM Call | `callLLM()` — POST to `/api/oral-exam` with auth header |
| 9. Submit Handler | `handleSubmit()` — sends answer for evaluation, renders feedback |
| 10. Eval Prompt Builder | `buildEvalPrompt()` — constructs the grading prompt including grounding notes |
| 11. Single-Area Mode | Result screen logic, "5 more" extension, result return via postMessage/redirect |
| 12. Start | `init()` call |

**Key global state variables:**

| Variable | Purpose |
|---|---|
| `config` | Loaded from `configs/private_asel.json` |
| `currentAreaIndex` | Index into `config.areasOfOperation` |
| `currentTaskIndex` | Index into the current area's `tasks` array |
| `depthMode` | `cursory`, `normal`, or `deep` |
| `sessionPerformance` | Per-area `{ correct, partial, incorrect }` counts (persisted to localStorage) |
| `sessionToken` | Token from URL, sent as `X-Exam-Token` header on every API call |
| `currentLLMData` | The last question/scenario response from the LLM, held while student answers |
| `isSingleAreaMode` | Set when `?mode=single` param present |
| `singleAreaQuestionCount` | Running question count in single-area mode |
| `singleAreaExtended` | True after student accepts the "5 more questions" extension |
| `returnUrl` | Optional URL to redirect to with results when session ends |

---

### `configs/private_asel.json`

The exam configuration file. One file per certificate/rating. Fields:

```json
{
  "certificate": "Private Pilot",
  "rating": "Airplane Single-Engine Land",
  "acsUrl": "URL to the FAA ACS PDF",
  "references": {
    "PHAK": "...", "AIM": "...", "FARs": "...", "AFH": "..."
  },
  "localPdfs": [],
  "localText": [],
  "areasOfOperation": [
    {
      "id": "VII",
      "title": "Slow Flight and Stalls",
      "groundingNotes": "Authoritative facts the AI uses to verify student answers...",
      "tasks": [
        { "id": "A", "title": "Maneuvering During Slow Flight" }
      ]
    }
  ]
}
```

- **`groundingNotes`** — plain-text FAA-accurate facts injected into every evaluation prompt for that area. Used to catch specific factual errors (e.g., wrong rudder direction). Optional per area.
- **`localText`** — array of file paths (relative to project root) to supplemental text files (e.g., school SOPs) loaded and appended to the question-generation prompt.
- **`localPdfs`** — reserved for future PDF parsing support; not currently processed.

---

### `prompts/oral_exam_prompt.txt`

Template file for question generation. Placeholders replaced at runtime by `buildPrompt()` in `app.js`:

| Placeholder | Source |
|---|---|
| `{{certificate}}` | `config.certificate` |
| `{{areaTitle}}`, `{{areaId}}` | Current area |
| `{{taskId}}` | Current task (empty string if none) |
| `{{depth}}` | `depthMode` URL param |
| `{{aircraft}}` | Hardcoded as `"generic training aircraft"` (override in code if needed) |
| `{{acsUrl}}`, `{{PHAK}}`, `{{AIM}}`, `{{FARs}}`, `{{AFH}}` | `config.references` |
| `{{localText}}` | Concatenated content from `config.localText` files |

The prompt includes strict behavioral constraints preventing the AI from responding to off-topic student input, accepting instructions from students, or revealing answers before the student attempts them.

---

### `functions/api/oral-exam.js`

Cloudflare Function at route `/api/oral-exam`. Accepts POST only.

**Request validation:**
- Checks `X-Exam-Token` header (or `?token` query param) against `env.VALID_TOKEN`
- Returns 401 if missing or wrong

**What it does:**
1. Receives `{ prompt }` JSON body from frontend
2. Calls OpenAI `gpt-4o` with a system message and the prompt as user message
3. Parses the JSON response from the LLM
4. Returns the parsed object (or a safe fallback if the LLM returned unparseable output)

**Required Cloudflare environment variables:**
- `OPENAI_API_KEY` — OpenAI secret key
- `VALID_TOKEN` — shared access token (e.g., `climb`)

---

### `functions/api/flag.js`

Cloudflare Function at route `/api/flag`.

**POST** (student-facing) — stores a flagged question:
- Validates `X-Exam-Token` header
- Stores a JSON record in the `EXAM_FLAGS` KV namespace with a 90-day TTL
- Record includes: timestamp, area, task, scenario, question, student answer, AI grade, AI feedback

**GET** (admin-facing) — retrieves all flags:
- Validates `?token` query param
- Returns all stored flag records as a JSON array

**Required Cloudflare setup:**
- KV namespace named `EXAM_FLAGS` created in Cloudflare dashboard
- Bound to the Pages project under Settings → Functions → KV namespace bindings, variable name `EXAM_FLAGS`

To view all flags:
```
https://<your-domain>/api/flag?token=<VALID_TOKEN>
```

---

### `wrangler.toml`

Minimal Cloudflare Pages configuration:

```toml
name = "climb-oral-exam"
compatibility_date = "2024-01-01"
pages_build_output_dir = "."
```

No build step — the entire project directory is the output.

---

## Data Flow

```
Browser
  │
  ├─ GET /configs/private_asel.json      (static file, direct)
  ├─ GET /prompts/oral_exam_prompt.txt   (static file, direct)
  │
  ├─ POST /api/oral-exam                 (Cloudflare Function)
  │     │  validates token
  │     └─ POST api.openai.com/v1/chat/completions
  │           returns JSON { scenario, question }  ← question generation
  │           returns JSON { evaluation, nextAction } ← answer evaluation
  │
  └─ POST /api/flag                      (Cloudflare Function)
        validates token
        writes to EXAM_FLAGS KV namespace
```

---

## Session Performance Tracking

Performance is stored in browser `localStorage` under key `oralExamPerformance`. Format:

```json
{
  "VII": { "correct": 3, "partial": 1, "incorrect": 1 }
}
```

This persists across page reloads but is local to the browser. It is used to determine which areas receive adaptive review after the full sequential pass.

---

## Deployment

Hosted on Cloudflare Pages. Deployment is triggered automatically when commits are pushed to the `main` branch of the connected GitHub repository (`sue-prog/oral-exam-app`). No build step or CI configuration required.
