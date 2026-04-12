# Climb Oral Exam Prep — Architecture Reference

## Overview

This is a serverless, single-page web application deployed on Cloudflare Pages. The frontend is plain HTML/CSS/JavaScript with no build step. Backend logic runs as Cloudflare Functions (edge workers). AI question generation and answer evaluation is handled by OpenAI's GPT-4o API, called server-side so the API key is never exposed to the browser.

---

## File Structure

```
oral-exam/
├── index.html                    # Single HTML page — all screens defined here
├── app.js                        # All frontend logic (session flow, LLM calls, UI)
├── styles.css                    # All styles
├── wrangler.toml                 # Cloudflare Pages configuration
├── .gitignore
│
├── configs/
│   ├── private_asel.json         # Private Pilot ASEL
│   ├── instrument_rating.json    # Instrument Rating
│   ├── commercial_asel.json      # Commercial Pilot ASEL
│   ├── commercial_amel.json      # Commercial Pilot AMEL (full + additional rating variants)
│   └── cfi.json                  # Flight Instructor — Airplane Single-Engine
│
├── prompts/
│   └── oral_exam_prompt.txt      # System prompt template for question generation
│
├── functions/
│   └── api/
│       ├── oral-exam.js          # Cloudflare Function: proxies OpenAI calls, validates token
│       └── flag.js               # Cloudflare Function: stores/retrieves flagged questions (KV)
│
└── local_pdfs/                   # gitignored — local supplemental text (e.g., school SOP)
```

---

## Component Details

### `index.html`

Defines six named screens, only one visible at a time:

| Screen ID | Purpose |
|---|---|
| `loading` | Shown while config and first question load |
| `access-denied` | Shown when no `?token` param is present |
| `exam` | The main exam interface |
| `single-area-complete` | End screen for single-area mode; also reused for per-area extension offers in full exam mode |
| `complete` | End screen for full exam mode — shows per-area pass/fail table |
| `error-screen` | Generic error with retry button |

All screen switching is handled by `showScreen(id)` in `app.js`, which toggles the `hidden` class.

---

### `app.js`

Organized into numbered sections:

| Section | Responsibility |
|---|---|
| 1. Initialization | Reads URL params, loads config, applies variant filtering, triggers first question |
| 2. Screen Management | `showScreen()` |
| 3. Loaders | `loadJSON()`, `loadLocalText()` |
| 4. Performance Storage | localStorage read/write, per-area correct/partial/incorrect tracking |
| 5. Progress UI | Header progress bar and area/task label |
| 6. Session Flow | `askNextQuestion()`, `moveToNextTask()`, `moveToNextArea()`, extension phase |
| 7. Prompt Builder | Fills `oral_exam_prompt.txt` template including variant context |
| 8. LLM Call | `callLLM()` — POST to `/api/oral-exam` with auth header |
| 9. Submit / Event Handlers | `handleSubmit()`, `handleNext()`, `handleFlag()`, `handleChallenge()` |
| 10. Eval Prompt Builder | `buildEvalPrompt()` — constructs the grading prompt including grounding notes |
| 11. Single-Area Mode | Result screen logic, extension, result return via postMessage/redirect |
| 12. Start | `init()` call |

**Key global state variables:**

| Variable | Purpose |
|---|---|
| `config` | Loaded from the selected config file |
| `currentAreaIndex` | Index into `config.areasOfOperation` |
| `currentTaskIndex` | Index into `currentAreaTasks` (the variant-filtered task list) |
| `currentAreaTasks` | Filtered task list for the current area, variant, and round — rebuilt on every area change |
| `activeVariant` | From `?variant=` param; empty string = no filtering |
| `depthMode` | `cursory`, `normal`, or `deep` |
| `sessionPerformance` | Per-area `{ correct, partial, incorrect }` counts (persisted to localStorage) |
| `sessionToken` | Token from URL, sent as `X-Exam-Token` header on every API call |
| `currentLLMData` | The last question/scenario response from the LLM, held while student answers |
| `gradeChallenges` | Array of challenged questions accumulated during the session |
| `isSingleAreaMode` | Set when `?mode=single` param present |
| `singleAreaQuestionCount` | Running question count in single-area mode |
| `singleAreaBaseQuestions` | From `?questions=N` param (default: 9) |
| `singleAreaExtensionQuestions` | `Math.ceil(singleAreaBaseQuestions / 3)` — computed in `init()` |
| `singleAreaExtended` | True after student accepts the extension in single-area mode |
| `returnUrl` | Optional URL to redirect to with results when session ends |
| `fullExamAreaQuestionCount` | Per-area question counter in full exam mode — reset on each new area |
| `fullExamAreaResults` | `{ [areaId]: { passed, stats } }` — recorded after each area completes |
| `fullExamExtensionAvailable` | Set of area IDs still eligible for extension — populated after base round |
| `currentAreaInExtension` | True when current area is in its extension round |
| `isAdaptiveMode` | Retained for future use (was used by the old adaptive review flow, replaced by 5+2 structure) |

**Key constants:**

| Constant | Default | Purpose |
|---|---|---|
| `FULL_EXAM_BASE_QUESTIONS` | `5` | Questions per area in the base round |
| `FULL_EXAM_EXTENSION_QUESTIONS` | `2` | Extra questions offered per failed area |

**Key functions:**

| Function | Purpose |
|---|---|
| `buildAreaTaskList(area, variant, isExtensionRound)` | Returns filtered task array for a given area/variant/round |
| `hasApplicableTasks(area, variant)` | Returns true if area has any applicable tasks — used to skip areas |
| `areaPassThreshold(total)` | Returns minimum score to pass an area (default: `total * 0.8`) |
| `getWeakAreas()` | Retained for future study+test mode — not currently called |

---

### Config files (`configs/*.json`)

One file per certificate/rating. Selected at runtime via `?rating=<basename>` URL param (default: `private_asel`).

**Schema:**

```json
{
  "certificate": "Commercial Pilot",
  "rating": "Airplane Multiengine Land",
  "acsUrl": "URL to the FAA ACS PDF",
  "references": {
    "PHAK": "...", "AIM": "...", "FARs": "...", "AFH": "..."
  },
  "localPdfs": [],
  "localText": [],
  "areasOfOperation": [
    {
      "id": "X",
      "title": "Emergency Operations",
      "groundingNotes": "Authoritative FAA facts injected into every evaluation prompt for this area.",
      "tasks": [
        {
          "id": "C",
          "title": "Engine Failure En Route",
          "variants": { "full": "required", "additional": "required" }
        },
        {
          "id": "A",
          "title": "Emergency Descent",
          "variants": { "full": "required", "additional": "required" }
        }
      ]
    }
  ]
}
```

**`variants` field on tasks** (optional):
- Keys are variant names matching the `?variant=` URL param
- Value `"required"` — task is tested in the base question round
- Value `"optional"` — task only surfaces in the extension round
- Key absent — task does not apply to this variant; never shown
- No `variants` field on task — task applies to all variants as required (backward compatible)

**`groundingNotes`** — plain-text FAA-accurate facts injected into every evaluation prompt for that area. Optional per area; adding detailed notes is the most effective way to improve grading accuracy without changing the model.

**`localText`** — array of file paths to supplemental text files loaded and appended to the question-generation prompt (e.g., school SOPs).

---

### `prompts/oral_exam_prompt.txt`

Template file for question generation. Placeholders replaced at runtime by `buildPrompt()` in `app.js`:

| Placeholder | Source |
|---|---|
| `{{certificate}}` | `config.certificate` |
| `{{areaTitle}}`, `{{areaId}}` | Current area |
| `{{taskId}}` | Current task from `currentAreaTasks` (empty string if none) |
| `{{depth}}` | `depthMode` URL param |
| `{{aircraft}}` | Hardcoded as `"generic training aircraft"` |
| `{{acsUrl}}`, `{{PHAK}}`, `{{AIM}}`, `{{FARs}}`, `{{AFH}}` | `config.references` |
| `{{variantContext}}` | Generated by `buildPrompt()` — lists required vs optional tasks and whether this is a base or extension round; empty string if no variant active |
| `{{localText}}` | Concatenated content from `config.localText` files |

The prompt includes strict behavioral constraints preventing the AI from responding to off-topic student input, accepting instructions from students, or revealing answers before the student attempts them.

The `VARIANT / TASK EMPHASIS` section in the prompt instructs the AI to only ask about required tasks in base rounds and to include optional tasks in extension rounds.

---

### `functions/api/oral-exam.js`

Cloudflare Function at route `/api/oral-exam`. Accepts POST only.

**Request validation:**
- Checks `X-Exam-Token` header against `env.VALID_TOKEN`
- Returns 401 if missing or wrong

**What it does:**
1. Receives `{ prompt }` JSON body from frontend
2. Calls OpenAI `gpt-4o` with the prompt
3. Parses the JSON response
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

---

### `wrangler.toml`

```toml
name = "climb-oral-exam"
compatibility_date = "2024-01-01"
pages_build_output_dir = "."
```

No build step — the entire project directory is the output.

---

## Exam Flow — Full Exam Mode

```
init()
  └─ load config, apply variant filtering
  └─ skip areas with no applicable tasks (hasApplicableTasks)
  └─ build currentAreaTasks for first area (required tasks only)
  └─ askNextQuestion() × FULL_EXAM_BASE_QUESTIONS per area
       ├─ on each submit: recordPerformance(), check fullExamAreaQuestionCount
       └─ when limit hit: nextAction = "moveToNextArea"
  └─ moveToNextArea()
       ├─ record pass/fail for finished area → fullExamAreaResults
       ├─ add to fullExamExtensionAvailable if failed (base round only)
       ├─ advance index, skip inapplicable areas
       └─ if all areas done → startExtensionPhase()

startExtensionPhase()
  └─ for each failed area in fullExamExtensionAvailable:
       └─ showExtensionOffer(areaId) — student can accept or skip
            ├─ accept → startAreaExtension(areaId)
            │     └─ rebuild currentAreaTasks (required + optional)
            │     └─ askNextQuestion() × FULL_EXAM_EXTENSION_QUESTIONS
            │     └─ moveToNextArea() → re-evaluate pass/fail → next extension offer
            └─ skip → delete from set → next extension offer
  └─ when set empty → showCompletion()

showCompletion()
  └─ render per-area pass/fail table
  └─ postMessage oralExamFullResult (if in iframe)
```

## Exam Flow — Single-Area Mode

```
init()
  └─ load config, apply variant filtering
  └─ build currentAreaTasks for target area (required tasks only)
  └─ askNextQuestion() × singleAreaBaseQuestions
       └─ when limit hit: nextAction = "singleAreaCheck"

showSingleAreaResult()
  └─ show score, pass/fail
  └─ if not extended: show extension button (ceil(N/3) more questions)

handleSingleAreaMore()
  └─ rebuild currentAreaTasks (required + optional)
  └─ askNextQuestion() × singleAreaExtensionQuestions
  └─ when limit hit → showSingleAreaResult() (extension button hidden)

returnResults()
  └─ package result payload including gradeChallenges filtered to this area
  └─ postMessage oralExamResult (if in iframe)
  └─ redirect to returnUrl (if provided)
```

---

## Data Flow

```
Browser
  │
  ├─ GET /configs/<rating>.json          (static file, direct)
  ├─ GET /prompts/oral_exam_prompt.txt   (static file, direct)
  │
  ├─ POST /api/oral-exam                 (Cloudflare Function)
  │     │  validates X-Exam-Token header
  │     └─ POST api.openai.com/v1/chat/completions
  │           returns JSON { scenario, question }         ← question generation
  │           returns JSON { evaluation, nextAction }     ← answer evaluation
  │
  └─ POST /api/flag                      (Cloudflare Function)
        validates X-Exam-Token header
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

This persists across page reloads but is local to the browser. In full exam mode, `fullExamAreaResults` (in-memory only) is the authoritative per-area pass/fail record for the current session — it incorporates both base and extension round results.

---

## Grade Challenges

Challenges are collected in the `gradeChallenges` array (in-memory, session-scoped). Each entry is captured when a student clicks "Challenge this Grade" and includes:

```json
{
  "timestamp": "2026-04-12T...",
  "areaId": "VII",
  "areaTitle": "Slow Flight and Stalls",
  "taskId": "B: Power-Off Stalls",
  "scenario": "...",
  "question": "...",
  "studentAnswer": "...",
  "aiGrade": "incorrect",
  "aiFeedback": "..."
}
```

The full question detail is stored because there is no server-side record of individual questions. Challenges are returned to the calling platform (Climb TMS) in the result payload — the TMS handles instructor notification and grade review.

---

## Deployment

Hosted on Cloudflare Pages. Deployment is triggered automatically when commits are pushed to the `main` branch of `sue-prog/oral-exam-app`. No build step or CI configuration required.

Live URL: `https://oral-exam-app.pages.dev`
Test URL: `https://oral-exam-app.pages.dev/?token=climb`
