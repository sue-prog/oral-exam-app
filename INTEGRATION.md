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
| `area` | No | `I` through `XI` | — | Locks the session to a specific Area of Operation. Use with `mode=single` for embedded course modules. |
| `mode` | No | `single` | — | Enables single-area mode (see below). No effect without `area`. |
| `depth` | No | `cursory`, `normal`, `deep` | `normal` | Controls question complexity and quantity per task. |
| `returnUrl` | No | Absolute URL | — | Where to redirect the student after they click Finish in single-area mode (see Result Return below). |

### Example URLs

Full exam, normal depth:
```
https://your-domain.pages.dev/?token=climb
```

Single area, deep depth, starting on Area VII (Slow Flight and Stalls):
```
https://your-domain.pages.dev/?token=climb&area=VII&mode=single&depth=deep
```

Single area with result return to your platform:
```
https://your-domain.pages.dev/?token=climb&area=VII&mode=single&returnUrl=https://yourapp.com/results
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

When launched without `mode=single`, the tool runs through all Areas of Operation (I through XI) in sequence. After completing all areas, if the student had weak areas (more incorrect than correct), it runs an adaptive review pass covering those areas. When the adaptive pass is complete, a session summary screen is shown.

There is no automatic result return in full exam mode — the session ends on the completion screen within the app.

---

## Single-Area Mode

Designed for embedding in course modules where you want to test one specific area.

**Behavior:**
1. Student answers 10 questions, all from the specified area
2. After question 10, a result screen appears showing their score as a percentage
3. If score ≥ 90%: green result, "Great Work!" message, option to take 5 more questions or finish
4. If score < 90%: red result, option to take 5 more questions or finish
5. After the optional 5 extra questions (15 total), the session hard-stops regardless of score
6. Clicking "Finish" triggers the result return mechanism (see below)

**Question cycling:** In single-area mode the tool cycles through all tasks within the selected area. When it reaches the last task it wraps back to the first, so there is no risk of running out of questions.

---

## Receiving Results

Results are only returned automatically in **single-area mode** (`?mode=single`). In full exam mode, the session ends on a completion screen inside the app and nothing is sent back to the calling platform.

When a student clicks **Finish** on the single-area result screen, the app packages up the session results and sends them back using one or both of the mechanisms below — depending on what parameters were in the original launch URL.

### What data is returned

Regardless of which mechanism delivers the results, the same set of values is always included:

| Field | Type | Description |
|---|---|---|
| `type` | String | Always `oralExamResult` — use this to identify the message |
| `area` | String | Area of Operation ID (e.g., `VII`) |
| `areaTitle` | String | Area title (e.g., `Slow Flight and Stalls`) |
| `score` | Number | Percentage score, 0–100. Partial credit answers count as 0.5. Example: 7 correct + 2 partial + 1 incorrect out of 10 = 80% |
| `correct` | Number | Number of answers graded correct |
| `partial` | Number | Number of answers graded partial credit |
| `incorrect` | Number | Number of answers graded incorrect |
| `total` | Number | Total questions answered in the session |
| `passed` | Boolean | `true` if score ≥ 90, `false` otherwise |

### Option 1: URL Redirect (recommended for most platforms)

Add `returnUrl=https://yourapp.com/results` to the launch URL. When the student clicks Finish, the browser navigates to that URL with all result fields appended as query string parameters.

Your server receives a GET request to something like:
```
https://yourapp.com/results?type=oralExamResult&area=VII&areaTitle=Slow+Flight+and+Stalls&score=80&correct=7&partial=2&incorrect=1&total=10&passed=false
```

Your server-side code reads those query parameters and does whatever it needs to — record the score, mark a course module complete, redirect the student to the next lesson, etc.

**Important:** the `returnUrl` must be an absolute URL (including `https://`). Relative URLs will not work. If the URL is malformed, the app will fall back to showing its own completion screen instead of redirecting.

### Option 2: postMessage (for iframe embedding)

If you embed the tool in an `<iframe>` on your page rather than opening it in a new tab, the app sends a `window.postMessage` to the parent page automatically when Finish is clicked — no `returnUrl` needed.

Add this listener to your parent page's JavaScript:

```javascript
window.addEventListener("message", (event) => {
  // Always check the type field before acting
  if (event.data?.type === "oralExamResult") {
    const { area, areaTitle, score, passed, correct, partial, incorrect, total } = event.data;
    console.log(`Student scored ${score}% on ${areaTitle}. Passed: ${passed}`);
    // record the result, unlock the next module, etc.
  }
});
```

The postMessage fires regardless of whether `returnUrl` is also set, so you can use both at the same time if needed (e.g., postMessage to update the UI instantly, and redirect to record it server-side).

### When no return mechanism is configured

If neither `returnUrl` nor iframe embedding is used, clicking Finish simply shows the app's built-in completion screen. No data is sent anywhere. This is fine for standalone use where you don't need to capture results programmatically.

---

## Flagging Incorrect Grades

A **Flag** button appears in the top-right corner of every feedback card. If a student believes their answer was graded incorrectly, they can click it. The flag is stored in Cloudflare KV with the full context:

- Question and scenario that was shown
- The student's answer
- The AI's grade and feedback
- Timestamp, area, and task

**Retrieving flags (Climb admin only):**
```
GET https://<your-domain>/api/flag?token=<VALID_TOKEN>
```

Returns a JSON array of all flagged questions. This requires the `EXAM_FLAGS` KV namespace to be configured in Cloudflare (see setup instructions in ARCHITECTURE.md).

---

## Token Security

The `token` parameter is a shared secret validated server-side on every API call. It prevents the app from being used by anyone who stumbles onto the URL without a token.

**Important notes for integrators:**
- The token appears in the URL, which means it will be visible in browser history and server logs. Do not use a highly sensitive secret — treat it as a low-security access control, not a user authentication mechanism.
- For course platforms, you can construct the launch URL server-side so the token is never shown directly to the student in a way they could share it out of context.
- If you need per-user access control, that should be enforced by your own platform before constructing the launch URL.

---

## Customizing the Exam Content

### Changing the exam configuration

The file `configs/private_asel.json` defines all areas of operation, tasks, FAA reference URLs, and per-area grounding notes. To support a different certificate or rating (e.g., Instrument Rating, Commercial, CFI), create a new config file and update `app.js` line 44:

```js
config = await loadJSON("configs/your_config.json");
```

### Adding grounding notes

Each area in the config supports a `groundingNotes` field — plain text containing authoritative FAA facts for that area. These are injected into every evaluation prompt and used to catch specific factual errors. Adding detailed grounding notes for areas where the AI has shown grading errors is the most effective way to improve accuracy without changing the model.

### Adding school-specific content

Set `localText` in the config to an array of text file paths:

```json
"localText": ["local_pdfs/school_sop.txt"]
```

The content will be appended to the question-generation prompt, allowing school-specific procedures and policies to influence the questions asked.

---

## Student Experience Walkthrough

Understanding this flow will help you decide if the tool fits your use case.

1. **Student receives a URL** from your platform (with token, area, and any other params)
2. **Loading screen** appears briefly while config and the first question load (1–3 seconds typically)
3. **Exam screen** appears with three cards:
   - **Scenario** — a realistic situation the examiner has placed the student in (e.g., "You are planning a cross-country flight...")
   - **Examiner Question** — a specific question based on that scenario
   - **Your Answer** — a free-text area where the student types their response
4. Student types an answer and clicks **Submit Answer**
5. The answer card is replaced by a **feedback card** showing:
   - A colored border: green (correct), amber (partial), red (incorrect)
   - Examiner-style feedback addressing the student directly ("You correctly identified... however you missed...")
   - A **Flag** button if the student wants to dispute the grade
   - A **Next Question** button
6. Student clicks Next Question — the cycle repeats
7. In single-area mode, after 10 questions the **result screen** appears with their score, options to take 5 more or finish
8. Clicking **Finish** returns results to your platform

**What students cannot do:**
- Ask the AI questions
- Request hints or the correct answer
- Change the topic or area being tested
- Instruct the AI to change its behavior
- Navigate backward to previous questions

---

## Maintaining This App (Novice Guide)

This section is for someone who has inherited this app and needs to make changes — but isn't a developer by trade. You don't need to understand all of the code to make the most common updates.

### How the app gets updated

This app uses a simple three-step chain:

```
You edit a file on your computer
        ↓
You "push" it to GitHub (an online code storage service)
        ↓
Cloudflare (the hosting service) automatically detects the change and republishes the app
```

Cloudflare usually takes 1–2 minutes to republish after a push. You don't need to do anything in Cloudflare directly for normal content changes.

---

### What you need installed

- **Git** — the tool that sends your changes to GitHub. Download from https://git-scm.com
- **A code editor** — VS Code (free, from https://code.visualstudio.com) works well and is what this project was built with

You'll also need access to the GitHub repository (`sue-prog/oral-exam-app`) and to the Cloudflare dashboard (for secrets/environment variables only — not for regular content changes).

---

### The most common thing you'll maintain: grounding notes

If the AI grades an answer incorrectly, the most effective fix is to improve the **grounding notes** for that Area of Operation. These are plain-text facts that the AI uses as a reference when grading.

**Where they live:** `configs/private_asel.json` — look for the `"groundingNotes"` field inside each area.

**How to edit them:**

1. Open the file in VS Code
2. Find the area you want to improve (e.g., search for `"VII"` to find Slow Flight and Stalls)
3. Edit the text inside the `"groundingNotes": "..."` value
4. Keep it as plain sentences — no special formatting needed
5. Be careful not to accidentally delete the surrounding quote marks or commas
6. Save the file

The notes can be as long as you like. More specific factual detail (exact numbers, correct directions, specific procedure sequences) is more useful than general summaries.

**Example — before:**
```json
"groundingNotes": "Slow flight requires rudder coordination."
```

**Example — after (more useful):**
```json
"groundingNotes": "Slow flight requires RIGHT rudder input to counteract left-turning tendencies. Never left rudder. P-factor and torque both cause left yaw at high power and low airspeed."
```

---

### Updating the exam prompt

The file `prompts/oral_exam_prompt.txt` controls how the AI generates questions and what rules it follows. It's a plain text file — open it in any text editor.

Be cautious editing the sections marked with `===` headings. The most useful things to adjust:
- The **DEPTH MODE BEHAVIOR** section, if you want to change how many questions are asked at each depth
- The **SCENARIO GENERATION RULES** section, if you want to nudge the types of scenarios generated

Do not delete or rename the `{{placeholder}}` values — these are filled in automatically at runtime.

---

### Pushing changes to GitHub (deploying your edits)

After editing any file, you need to push the change to GitHub to make it live. Here's how to do that using VS Code's built-in Git interface — no command line required.

**One-time setup:** Make sure the project folder is open in VS Code and Git is installed.

**Each time you make a change:**

1. Save the file(s) you edited (Ctrl+S / Cmd+S)
2. Click the **Source Control** icon in the left sidebar — it looks like a branching tree, and will show a number badge if you have unsaved changes
3. You'll see your changed files listed under "Changes"
4. Hover over the file and click the **+** (plus) icon to stage it
5. Type a short description of what you changed in the "Message" box at the top (e.g., `Improve grounding notes for Area VII`)
6. Click the **Commit** button (checkmark)
7. Click the **Sync Changes** button (circular arrows) that appears — this pushes to GitHub

Within 1–2 minutes, Cloudflare will pick up the change and redeploy the app automatically.

**If you prefer the command line**, the equivalent is:
```bash
git add configs/private_asel.json
git commit -m "Improve grounding notes for Area VII"
git push
```

---

### Changing secrets (API keys, access token)

Secrets are **not** stored in the code files — they live in Cloudflare's dashboard so they're never accidentally shared. To update them:

1. Log into https://dash.cloudflare.com
2. Go to **Workers & Pages** → click `oral-exam-app`
3. Go to **Settings** → **Environment variables**
4. Click **Edit** next to the variable you want to change
5. Enter the new value and save
6. Trigger a new deployment (push any small change, or use the Cloudflare dashboard to redeploy)

The two secrets are:
- `OPENAI_API_KEY` — your OpenAI API key. Rotate this if you suspect it has been compromised.
- `VALID_TOKEN` — the shared access token students use in the URL. Change this to lock out anyone using an old link.

---

### Things NOT to edit without developer help

- `app.js` — the main application logic. Edits here can break the entire app.
- `functions/api/oral-exam.js` or `functions/api/flag.js` — the server-side functions.
- `wrangler.toml` — the Cloudflare configuration.
- `index.html` — the page structure. Minor text edits are low-risk, but structural changes can break the layout.

If something breaks after an edit, the safest recovery is to undo the change in VS Code (Ctrl+Z), save, and push again.

---

## Limitations to Be Aware Of

- **AI grading is not perfect.** The grounding notes reduce errors significantly for factual questions, but complex or nuanced answers may still be graded inconsistently. The flag system exists for this reason.
- **Questions are generated fresh each session.** There is no fixed question bank. The same area may generate different questions in different sessions, which is realistic but means you cannot guarantee a specific question will appear.
- **Performance is stored in browser localStorage**, not server-side. Clearing the browser or using a different device resets the history. This affects the adaptive review pass in full-exam mode but not the score returned to your platform at the end of single-area mode.
- **No user accounts.** The tool has no concept of individual users. All tracking is session-based and local. If you need per-student records, capture the results returned by the tool and store them in your own system.
- **English only.** The prompts and UI are English-only.
