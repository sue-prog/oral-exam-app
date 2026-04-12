# Climb Oral Exam Prep — Integration Guide

This guide is for developers embedding the Oral Exam Prep tool into a course platform, LMS, or web application.

---

## What This Tool Does

The Oral Exam Prep tool is a self-contained web app that:

1. Presents FAA-style oral exam questions to a student, organized by Area of Operation from the FAA ACS (Airman Certification Standards)
2. Accepts free-text answers typed by the student
3. Uses an AI examiner (GPT-4o) to evaluate each answer and provide feedback
4. Grades each answer as **correct**, **partial**, or **incorrect**
5. Tracks a running score and optionally returns results to the calling application when the session ends

It is **not** a chatbot. The student types answers to specific questions; they cannot ask questions, request hints, or redirect the conversation. The AI will ignore off-topic input and re-present the original question.

---

## Is This a Good Fit As-Is?

**Good fit if:**
- You want a standalone exam prep experience you can launch in a new tab or iframe
- Students will use a keyboard to type their answers
- You need basic pass/fail or scored results returned to your platform
- You're okay with questions being AI-generated (not a fixed question bank)

**May need customization if:**
- You want a fixed, predetermined set of questions (currently AI generates fresh questions each session)
- You need voice input or speech-to-text
- You need detailed per-question analytics stored server-side (currently only a flag/review system exists)
- You need a branded UI that doesn't match the current Climb design
- You need the student to be able to review all questions and answers after the session

---

## Launching the Tool

The tool is accessed via a URL with query parameters. At minimum, a valid `token` is required or the student sees an "Access Restricted" screen.

### Base URL

```
https://<your-cloudflare-domain>/?token=<VALID_TOKEN>
```

### All Supported URL Parameters

| Parameter | Required | Values | Default | Description |
|---|---|---|---|---|
| `token` | Yes | String | — | Shared access token. Must match `VALID_TOKEN` env variable. Without this, the student sees "Access Restricted". |
| `rating` | No | See configs below | `private_asel` | Which exam config to load. Selects the certificate/rating being tested. |
| `variant` | No | Defined per config | — | Selects a task subset within the config (e.g., `full` vs `additional` rating). See Variant Filtering below. |
| `area` | No | Area ID (e.g., `VII`) | — | Locks the session to a specific Area of Operation. Use with `mode=single` for course modules. |
| `mode` | No | `single` | — | Enables single-area mode (see below). |
| `questions` | No | Positive integer | `9` | Number of questions before grading in single-area mode. Extension = ceil(N/3). |
| `depth` | No | `cursory`, `normal`, `deep` | `normal` | Controls question complexity. |
| `returnUrl` | No | Absolute URL | — | Where to redirect after Finish in single-area mode (see Result Return below). |

### Available Ratings

| `?rating=` value | Certificate/Rating |
|---|---|
| `private_asel` | Private Pilot — Airplane Single-Engine Land (default) |
| `instrument_rating` | Instrument Rating — Airplane |
| `commercial_asel` | Commercial Pilot — Airplane Single-Engine Land |
| `commercial_amel` | Commercial Pilot — Airplane Multiengine Land |
| `cfi` | Flight Instructor — Airplane Single-Engine |

To add a new rating, drop a new JSON file in `configs/` and use its base filename as the `?rating=` value.

### Example URLs

Full exam, default rating:
```
https://oral-exam-app.pages.dev/?token=climb
```

Full exam, specific rating and depth:
```
https://oral-exam-app.pages.dev/?token=climb&rating=instrument_rating&depth=deep
```

Commercial AMEL — additional rating onto existing Commercial ASEL:
```
https://oral-exam-app.pages.dev/?token=climb&rating=commercial_amel&variant=additional
```

Single area, Area VII, 12 questions, return results to your platform:
```
https://oral-exam-app.pages.dev/?token=climb&area=VII&mode=single&questions=12&returnUrl=https://yourapp.com/results
```

---

## Depth Modes

| Mode | Questions per task | Scenario complexity | Evaluation detail |
|---|---|---|---|
| `cursory` | 1–2 | Simple | Light, minimal FAA citations |
| `normal` | 3–5 | Standard examiner-style | Standard, FAA references included |
| `deep` | 6–10+ | Multi-layered (weather, airspace, passengers) | Detailed, follow-up questions, strong weak-area drilling |

---

## Full Exam Mode (default)

When launched without `mode=single`, the tool runs through all Areas of Operation in the config in sequence. Areas with no applicable tasks for the selected variant are automatically skipped.

### Question structure per area

- **Base round:** `FULL_EXAM_BASE_QUESTIONS` questions (default: 5) drawn from required tasks only
- Pass threshold: ≥ 80% (4 out of 5 correct or partial)
- **After all areas:** any failed areas are offered an extension

### Extension phase

After completing all areas, for each area the student failed:
- A result screen shows their score for that area
- They may attempt `FULL_EXAM_EXTENSION_QUESTIONS` more questions (default: 2) — this is optional per area
- No third attempt — if they fail after the extension, they must get more training and retry the full exam
- Extension round covers all applicable tasks (required + optional) for the selected variant

### Completion screen

Shows a per-area pass/fail table (✓/✗) with scores, and an overall PASS / NOT YET result.

### Full exam result return (postMessage only)

When a full exam session completes and the app is embedded in an iframe, it sends a `postMessage` to the parent page:

```javascript
window.addEventListener("message", (event) => {
  if (event.data?.type === "oralExamFullResult") {
    const { passed, areaResults, challenged, totals } = event.data;
    // passed: boolean — true if all areas passed
    // areaResults: { [areaId]: { passed: bool, stats: { correct, partial, incorrect } } }
    // challenged: array of challenged questions (see Grade Challenges below)
    // totals: { correct, partial, incorrect, total, pct }
  }
});
```

There is no `returnUrl` redirect for full exam mode — only postMessage is supported.

---

## Single-Area Mode

Designed for embedding in course modules where you want to test one specific area.

**Behavior:**
1. Student answers N questions (default 9, override with `?questions=N`), all from the specified area
2. After question N, a result screen shows their score as a percentage
3. They may take ceil(N/3) more questions (default: 3 more) — optional; button is hidden after extension is used
4. After the extension, the session hard-stops
5. Clicking **Finish** triggers the result return mechanism (see below)

**Question cycling:** In single-area mode the tool cycles through all applicable tasks for the selected variant within the area. When it reaches the last task it wraps back to the first, so there is no risk of running out of questions.

**Task filtering:** Only tasks applicable to the selected variant appear in single-area mode. See Variant Filtering below.

---

## Variant Filtering

Some ACS documents cover multiple situations — for example, a Commercial AMEL checkride for someone who already holds a Commercial ASEL is an "additional rating" and has different required tasks than a full Commercial AMEL checkride. The `?variant=` param handles this.

### How it works

Each task in a config may have a `variants` field:

```json
{ "id": "D", "title": "Vmc Demonstration", "variants": { "full": "required", "additional": "required" } }
{ "id": "A", "title": "Pilot Qualifications", "variants": { "full": "required", "additional": "optional" } }
```

| Value | Meaning |
|---|---|
| `"required"` | Tested in the base question round |
| `"optional"` | Only surfaces in the extension round |
| Key absent | Task does not apply to this variant at all — never shown |
| No `variants` field on task | Task applies to all variants as required (backward compatible) |

If no `?variant=` param is passed, all tasks in the config are treated as applicable.

### Available variants by config

| Config | Variants |
|---|---|
| `private_asel` | `asel` — all tasks; ensures no seaplane-only tasks appear if config is expanded later |
| `commercial_amel` | `full` — full AMEL checkride; `additional` — additional rating onto existing Commercial ASEL |
| All others | No variants defined — all tasks always apply |

---

## Receiving Results

### Single-area mode result payload

When a student clicks **Finish** on the single-area result screen, the app returns:

| Field | Type | Description |
|---|---|---|
| `type` | String | Always `oralExamResult` |
| `area` | String | Area of Operation ID (e.g., `VII`) |
| `areaTitle` | String | Area title |
| `score` | Number | Percentage score 0–100. Partial = 0.5. |
| `correct` | Number | Answers graded correct |
| `partial` | Number | Answers graded partial credit |
| `incorrect` | Number | Answers graded incorrect |
| `total` | Number | Total questions answered |
| `passed` | Boolean | `true` if score ≥ 90% |
| `challenged` | Array | Challenged questions for this area (see Grade Challenges below) |

### Option 1: URL Redirect

Add `returnUrl=https://yourapp.com/results` to the launch URL. On Finish, the browser navigates to that URL with all result fields as query string parameters:

```
https://yourapp.com/results?type=oralExamResult&area=VII&score=80&passed=false&...
```

Note: `challenged` is a JSON array — it will be URL-encoded in the query string. Parse it with `JSON.parse(decodeURIComponent(params.get("challenged")))`.

### Option 2: postMessage (iframe embedding)

```javascript
window.addEventListener("message", (event) => {
  if (event.data?.type === "oralExamResult") {
    const { area, areaTitle, score, passed, correct, partial, incorrect, total, challenged } = event.data;
    // challenged: array of { scenario, question, studentAnswer, aiGrade, aiFeedback, areaId, taskId, timestamp }
  }
});
```

### When no return mechanism is configured

Clicking Finish shows the app's built-in completion screen. No data is sent anywhere.

---

## Grade Challenges

A **Challenge this Grade** button appears on every feedback card alongside the Flag button. If a student disagrees with the AI's grade, they click it.

Challenges are collected during the session and included in the result payload returned to your platform. Your platform (the Climb TMS) is responsible for routing challenges to the instructor and/or course designer for review.

**Each challenged item in the payload includes:**

| Field | Description |
|---|---|
| `timestamp` | ISO timestamp when challenged |
| `areaId` | Area of Operation ID |
| `areaTitle` | Area title |
| `taskId` | Task ID and title |
| `scenario` | The full scenario text shown to the student |
| `question` | The full question text |
| `studentAnswer` | The student's verbatim answer |
| `aiGrade` | The AI's grade: `correct`, `partial`, or `incorrect` |
| `aiFeedback` | The AI's full feedback text |

The full question detail is included because there is no server-side record of individual questions — each session generates fresh questions.

In single-area mode, `challenged` in the payload is filtered to questions from the current area only. In full exam mode (postMessage), `challenged` includes all challenges from the entire session.

---

## Flagging Questions for Climb Review

A **Flag** button also appears on every feedback card. This is separate from challenging a grade — it's for Climb staff to review the question itself (e.g., if grounding notes need to be improved).

Flags are stored in Cloudflare KV and reviewed by Climb staff. They are not returned to the calling platform.

**Retrieving flags (Climb admin only):**
```
GET https://<your-domain>/api/flag?token=<VALID_TOKEN>
```

Requires the `EXAM_FLAGS` KV namespace to be configured in Cloudflare (see ARCHITECTURE.md).

---

## Token Security

The `token` parameter is a shared secret validated server-side on every API call.

- The token appears in the URL (visible in browser history and server logs). Treat it as low-security access control, not user authentication.
- For course platforms, construct the launch URL server-side so the token is not directly visible to students.
- Per-user access control should be enforced by your platform before constructing the launch URL.

---

## Customizing the Exam Content

### Changing the exam configuration

Each rating has its own config file in `configs/`. Select it with `?rating=<filename_without_extension>`.

To add a new rating:
1. Copy `configs/private_asel.json` as a template
2. Fill in `certificate`, `rating`, `acsUrl`, `references`, and `areasOfOperation`
3. Add `variants` fields to tasks if the ACS covers multiple situations
4. Drop the file in `configs/` — no code changes needed

### Adding grounding notes

Each area supports a `groundingNotes` field — plain text with authoritative FAA facts. These are injected into every evaluation prompt and used to catch specific factual errors. More specific detail (exact numbers, correct directions, procedure sequences) is more valuable than general summaries.

### Adding task variants

If a config covers multiple checkride situations, add a `variants` field to each task:

```json
{ "id": "A", "title": "Some Task", "variants": { "full": "required", "additional": "optional" } }
```

Then launch with `?variant=full` or `?variant=additional`. Tasks with no `variants` field always apply.

### Adding school-specific content

Set `localText` in the config to an array of text file paths:

```json
"localText": ["local_pdfs/school_sop.txt"]
```

The content will be appended to the question-generation prompt, allowing school-specific procedures to influence the questions asked.

---

## Student Experience Walkthrough

1. **Student receives a URL** from your platform (with token, area, and any other params)
2. **Loading screen** appears briefly while config and the first question load (1–3 seconds typically)
3. **Exam screen** appears with three cards:
   - **Scenario** — a realistic situation the examiner has placed the student in
   - **Examiner Question** — a specific question based on that scenario
   - **Your Answer** — a free-text area where the student types their response
4. Student types an answer and clicks **Submit Answer**
5. The answer card is replaced by a **feedback card** showing:
   - A colored border: green (correct), amber (partial), red (incorrect)
   - Examiner-style feedback addressing the student directly
   - A **Flag** button (to flag the question for Climb review)
   - A **Challenge this Grade** button (to dispute the grade — included in result payload)
   - A **Next Question** button
6. Student clicks Next Question — the cycle repeats
7. In **single-area mode**: after N questions the result screen appears with score, options to extend or finish
8. In **full exam mode**: after all areas, the extension phase offers extra questions on failed areas, then a final per-area pass/fail table

**What students cannot do:**
- Ask the AI questions
- Request hints or the correct answer
- Change the topic or area being tested
- Instruct the AI to change its behavior
- Navigate backward to previous questions

---

## Maintaining This App (Novice Guide)

### How the app gets updated

```
You edit a file on your computer
        ↓
You "push" it to GitHub
        ↓
Cloudflare automatically detects the change and republishes the app (1–2 minutes)
```

### What you need installed

- **Git** — download from https://git-scm.com
- **VS Code** — download from https://code.visualstudio.com

### The most common thing you'll maintain: grounding notes

If the AI grades an answer incorrectly, improve the `groundingNotes` for that area in the relevant config file (e.g., `configs/private_asel.json`).

1. Open the config file in VS Code
2. Find the area (search for the area ID, e.g., `"VII"`)
3. Edit the text inside `"groundingNotes": "..."`
4. Be careful not to delete surrounding quote marks or commas
5. Save, commit, push

### Pushing changes to GitHub

1. Save your file (Ctrl+S)
2. Click the **Source Control** icon in the VS Code sidebar
3. Hover over the changed file → click **+** to stage it
4. Type a commit message and click **Commit**
5. Click **Sync Changes** to push

Or from the terminal:
```bash
git add configs/private_asel.json
git commit -m "Improve grounding notes for Area VII"
git push
```

### Changing secrets

Secrets live in the Cloudflare dashboard, never in code files.

1. Log into https://dash.cloudflare.com
2. **Workers & Pages** → `oral-exam-app` → **Settings** → **Environment variables**
3. Edit the variable, save, and trigger a redeploy

The two secrets:
- `OPENAI_API_KEY` — rotate if compromised
- `VALID_TOKEN` — change to lock out anyone using an old link

### Things NOT to edit without developer help

- `app.js` — main application logic
- `functions/api/oral-exam.js` or `functions/api/flag.js` — server-side functions
- `wrangler.toml` — Cloudflare configuration
- `index.html` — minor text edits are low-risk; structural changes can break layout

---

## Limitations to Be Aware Of

- **AI grading is not perfect.** Grounding notes reduce errors significantly, but the flag and challenge systems exist for cases where grading is wrong.
- **Questions are generated fresh each session.** No fixed question bank — same area may produce different questions each time.
- **Performance is stored in browser localStorage**, not server-side. Clearing the browser resets history.
- **No user accounts.** All tracking is session-based and local. Capture results returned by the tool and store them in your own system for per-student records.
- **English only.** Prompts and UI are English-only.
