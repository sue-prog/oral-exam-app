// ===============================
// ORAL EXAM PREP ENGINE
// Climb LLC
// ===============================

// --- Global state ---
let config = null;
let localTextCache = "";
let currentAreaIndex = 0;
let currentTaskIndex = 0;
let depthMode = "normal";
let sessionPerformance = {};   // tracks correct/incorrect per area for this session
// NOTE: isAdaptiveMode is no longer used. The original adaptive review pass
// (automatically revisiting weak areas after finishing all 11) was replaced in
// April 2026 by the explicit 5+2 per-area pass/fail structure in full exam mode.
// Kept here as a reference in case a future "study+test" mode wants to revive
// automatic adaptive looping. If you restore it, also uncomment getWeakAreas()
// below and the modeLabel line in updateProgressUI().
// let isAdaptiveMode = false;
let isAdaptiveMode = false; // left active to avoid breaking updateProgressUI label logic — see above
let currentLLMData = null;     // holds the last LLM response while student is answering
let sessionToken = "";

// -----------------------------------------------------------------------
// GRADE CHALLENGES
// -----------------------------------------------------------------------
// When a student disagrees with an AI grade, they can challenge it.
// Challenges are collected here and returned in the result payload to the
// Climb TMS, which handles instructor notification and grade review.
//
// Each entry includes the full question detail since there is no other
// persistent record of individual questions.
//
// Structure: array of { areaId, areaTitle, taskId, scenario, question,
//                       studentAnswer, aiGrade, aiFeedback, timestamp }
// -----------------------------------------------------------------------
let gradeChallenges = [];

// -----------------------------------------------------------------------
// RECENT QUESTION TRACKING — VARIETY ENFORCEMENT
// -----------------------------------------------------------------------
// GPT has no memory between calls. Without help, it tends to ask the same
// concept (e.g., "how do you establish slow flight") with only superficial
// scenario variation. To prevent this we maintain a short rolling log of
// recent question topics per area and inject them into every prompt so the
// AI explicitly knows what it already asked.
//
// recentQuestionsByArea: { [areaId]: string[] }
//   Each entry is a short topic summary extracted from the LLM's own question
//   text (first 120 chars — enough for the AI to recognize the concept).
//
// RECENT_QUESTION_MEMORY: how many recent questions to include in the prompt.
//   Too few = still repeats; too many = prompt gets long and AI gets confused.
//   5 is a good default for a 9-question session.
// -----------------------------------------------------------------------
const RECENT_QUESTION_MEMORY = 5;
let recentQuestionsByArea = {};

// -----------------------------------------------------------------------
// FULL EXAM MODE — PER-AREA QUESTION LIMITS
// -----------------------------------------------------------------------
// In full exam mode, the exam works in two rounds:
//
//   ROUND 1 (base): FULL_EXAM_BASE_QUESTIONS questions per area.
//     Pass = answered at least FULL_EXAM_BASE_QUESTIONS - 1 correctly
//     (i.e., at most 1 miss is allowed out of 5).
//     Fail = missed 2 or more.
//
//   ROUND 2 (extension): For each area the student failed, they are
//     offered FULL_EXAM_EXTENSION_QUESTIONS extra questions.
//     This is optional per area — the student chooses.
//     No third attempt; student must get more training and retry.
//
//   OVERALL PASS: Student passed every area (base or extension).
//
// To change question counts, update the constants below.
// To change pass threshold, update areaPassThreshold() below.
// -----------------------------------------------------------------------
const FULL_EXAM_BASE_QUESTIONS = 5;       // questions asked per area in round 1
const FULL_EXAM_EXTENSION_QUESTIONS = 2;  // extra questions offered per failed area

// areaPassThreshold(total): returns the minimum number of correct+partial*0.5
// answers needed to pass an area. Default: score >= 80% (e.g. 4/5).
// To change the pass bar, edit this function.
function areaPassThreshold(total) {
  return total * 0.8;
}

// Tracks how many questions have been asked in the current area during full exam mode.
let fullExamAreaQuestionCount = 0;

// After all areas are done, holds per-area pass/fail results.
// Structure: { [areaId]: { passed: bool, stats: {correct, partial, incorrect} } }
let fullExamAreaResults = {};

// Tracks which failed areas still have an extension available.
// Set is populated after round 1; entries removed as student uses or declines extensions.
let fullExamExtensionAvailable = new Set();

// -----------------------------------------------------------------------
// VARIANT FILTERING
// -----------------------------------------------------------------------
// Some ACS documents cover multiple rating situations (e.g., "full" Commercial
// AMEL vs. "additional" AMEL onto an existing Commercial ASEL). Some tasks only
// apply to one situation. The ?variant= URL param selects which applies.
//
// Each task in a config can carry an optional "variants" field:
//   "variants": { "full": "required", "additional": "optional" }
//
// Values:
//   "required" — this task must appear in the base question round
//   "optional" — this task is available in the extension round only
//   key absent  — this task does not apply to this variant at all
//
// If a task has no "variants" field at all, it applies to every variant
// as "required" (backward compatible with configs written before this feature).
//
// If no ?variant= param is passed, all tasks are treated as applicable.
//
// currentAreaTasks: the filtered task list for the current area + variant + round.
// Rebuilt whenever we enter a new area or switch between base and extension rounds.
// All code that previously used area.tasks[currentTaskIndex] now uses currentAreaTasks.
// -----------------------------------------------------------------------
let activeVariant = "";         // from ?variant= param; empty = no filtering
let currentAreaTasks = [];      // filtered tasks for current area/variant/round

// buildAreaTaskList(area, variant, isExtensionRound):
//   Returns the applicable tasks for a given area, variant, and round.
//   isExtensionRound = false → base round: "required" tasks only
//   isExtensionRound = true  → extension round: all applicable tasks (required + optional)
function buildAreaTaskList(area, variant, isExtensionRound) {
  if (!area.tasks || area.tasks.length === 0) return [];
  if (!variant) return area.tasks;  // no variant = all tasks

  return area.tasks.filter(task => {
    if (!task.variants) return true;                        // no variants field = always included
    const v = task.variants[variant];
    if (!v) return false;                                   // variant key absent = not applicable
    if (!isExtensionRound) return v === "required";         // base round: required only
    return true;                                            // extension round: required + optional
  });
}

// hasApplicableTasks(area, variant): true if this area has at least one applicable task.
// Used to skip areas with no tasks for the selected variant.
function hasApplicableTasks(area, variant) {
  return buildAreaTaskList(area, variant, false).length > 0 ||
         buildAreaTaskList(area, variant, true).length > 0;
}

// --- Single-area mode state ---
let isSingleAreaMode = false;
let singleAreaQuestionCount = 0;
let singleAreaExtended = false;  // true after student clicks "give me N more"
let returnUrl = null;

// -----------------------------------------------------------------------
// SINGLE-AREA QUESTION LIMITS
// -----------------------------------------------------------------------
// singleAreaBaseQuestions: how many questions are asked before grading.
//   Set by the ?questions=N URL param. Default is 9.
//   Callers (e.g., a Climb course module) can override this per area by
//   passing a different value in the URL.
//
// singleAreaExtensionQuestions: how many extra questions the student may
//   attempt after failing the base round. Computed as Math.ceil(N/3).
//   For the default of 9, that's 3 more questions.
//   To change the extension ratio, edit the calculation in init() below.
//
// To disable the extension entirely, set singleAreaExtensionQuestions = 0
//   and hide the "give me more" button in showSingleAreaResult().
// -----------------------------------------------------------------------
let singleAreaBaseQuestions = 9;        // overridden by ?questions=N
let singleAreaExtensionQuestions = 3;   // overridden in init() after param is read

// ===============================
// 1. INITIALIZATION
// ===============================

async function init() {
  const params = new URLSearchParams(window.location.search);

  // --- Access Control ---
  // The token is checked against the backend, not hardcoded here.
  // Anyone without a token sees the access denied screen.
  const token = params.get("token");
  if (!token) {
    showScreen("access-denied");
    return;
  }
  sessionToken = token;

  // --- URL Parameters ---
  depthMode = params.get("depth") || "normal";
  isSingleAreaMode = params.get("mode") === "single";
  returnUrl = params.get("returnUrl") || null;

  // --- Variant selection ---
  // ?variant= selects which subset of tasks applies (e.g., "full" vs "additional").
  // Sanitized the same way as rating — only safe filename chars allowed.
  // If omitted, no variant filtering is applied.
  activeVariant = (params.get("variant") || "").replace(/[^a-z0-9_-]/gi, "");

  // --- Single-area question limit ---
  // ?questions=N sets how many questions before grading. Default: 9.
  // The extension (offered after a failed base round) is ceil(N/3).
  // To change the default, update singleAreaBaseQuestions above.
  // To change the extension ratio, update the Math.ceil formula below.
  if (params.get("questions")) {
    const parsed = parseInt(params.get("questions"), 10);
    if (!isNaN(parsed) && parsed > 0) {
      singleAreaBaseQuestions = parsed;
    }
  }
  singleAreaExtensionQuestions = Math.ceil(singleAreaBaseQuestions / 3);

  // Deep linking / single-area: a specific area targeted by ID (e.g., ?area=VII)
  const startAreaId = params.get("area") || null;

  showScreen("loading");

  try {
    // --- Load Config ---
    // The ?rating= URL param selects which config file to load.
    // Default is "private_asel" if no param is provided.
    // Add new ratings by dropping a new JSON file in configs/ and passing its
    // base name as the ?rating= value (e.g., ?rating=instrument_rating).
    // NEVER pass user-supplied input directly to a path without sanitizing —
    // the replace() below strips everything except safe filename characters.
    const ratingParam = (params.get("rating") || "private_asel").replace(/[^a-z0-9_-]/gi, "");
    config = await loadJSON(`configs/${ratingParam}.json`);

    // --- Load any local supplemental text (e.g., school SOP) ---
    localTextCache = await loadLocalText(config.localText);

    // --- Load saved performance from previous sessions ---
    loadPerformance();

    // --- Determine starting area ---
    if (startAreaId) {
      const idx = config.areasOfOperation.findIndex(a => a.id === startAreaId.toUpperCase());
      if (idx !== -1) {
        currentAreaIndex = idx;
      }
    }

    // Skip areas that have no applicable tasks for the selected variant.
    // Advance currentAreaIndex until we land on an applicable area.
    while (
      currentAreaIndex < config.areasOfOperation.length &&
      !hasApplicableTasks(config.areasOfOperation[currentAreaIndex], activeVariant)
    ) {
      currentAreaIndex++;
    }

    // Build the initial task list for the starting area
    currentAreaTasks = buildAreaTaskList(
      config.areasOfOperation[currentAreaIndex],
      activeVariant,
      false  // start in base round (required tasks only)
    );

    showScreen("exam");
    updateProgressUI();
    await askNextQuestion();

  } catch (err) {
    console.error("Init error:", err);
    showError("Could not load the exam session. Please try refreshing the page.");
  }
}

// ===============================
// 2. SCREEN MANAGEMENT
// ===============================

// All screens are hidden/shown by toggling the "hidden" class.
// Screen IDs: "loading", "exam", "access-denied", "complete", "error-screen"
function showScreen(id) {
  const screens = ["loading", "exam", "access-denied", "complete", "error-screen", "single-area-complete"];
  screens.forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.toggle("hidden", s !== id);
  });
}

function showError(message) {
  document.getElementById("error-message").textContent = message;
  showScreen("error-screen");
}

// ===============================
// 3. LOADERS
// ===============================

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  return await res.json();
}

async function loadLocalText(paths) {
  if (!paths || paths.length === 0) return "";
  let combined = "";
  for (const p of paths) {
    try {
      const res = await fetch(p);
      const text = await res.text();
      combined += `\n\n=== LOCAL TEXT: ${p} ===\n${text}`;
    } catch {
      console.warn("Could not load local text:", p);
    }
  }
  return combined;
}

// ===============================
// 4. PERFORMANCE STORAGE
// ===============================

function loadPerformance() {
  const saved = localStorage.getItem("oralExamPerformance");
  sessionPerformance = saved ? JSON.parse(saved) : {};
}

function savePerformance() {
  localStorage.setItem("oralExamPerformance", JSON.stringify(sessionPerformance));
}

function recordPerformance(areaId, grade) {
  if (!sessionPerformance[areaId]) {
    sessionPerformance[areaId] = { correct: 0, partial: 0, incorrect: 0 };
  }
  if (grade === "correct") sessionPerformance[areaId].correct++;
  else if (grade === "partial") sessionPerformance[areaId].partial++;
  else sessionPerformance[areaId].incorrect++;
  savePerformance();
  updateScoreTally();
}

function updateScoreTally() {
  const totals = Object.values(sessionPerformance).reduce(
    (acc, s) => {
      acc.correct += s.correct;
      acc.partial += (s.partial || 0);
      acc.incorrect += s.incorrect;
      return acc;
    },
    { correct: 0, partial: 0, incorrect: 0 }
  );
  const el = document.getElementById("score-tally");
  if (!el) return;
  const parts = [`${totals.correct} correct`];
  if (totals.partial > 0) parts.push(`${totals.partial} partial`);
  parts.push(`${totals.incorrect} incorrect`);
  el.textContent = parts.join(" / ");
}

// NOTE: getWeakAreas() is no longer called. It was used by the old adaptive
// review flow, which has been replaced by the explicit 5+2 per-area extension
// model. Kept here because the logic (score weak areas by incorrect + partial*0.5
// vs. correct) would be a useful building block for a future "study+test" mode
// that automatically loops students through trouble spots in real time.
// If you restore it, wire it back into a new startAdaptiveFlow()-style function.
function getWeakAreas() {
  return Object.entries(sessionPerformance)
    .filter(([, stats]) => (stats.incorrect + (stats.partial || 0) * 0.5) > stats.correct)
    .map(([areaId]) => areaId);
}

// ===============================
// 5. PROGRESS UI
// ===============================

function updateProgressUI() {
  const totalAreas = config.areasOfOperation.length;
  const pct = Math.round((currentAreaIndex / totalAreas) * 100);

  document.getElementById("progress-bar").style.width = pct + "%";

  const area = config.areasOfOperation[currentAreaIndex];
  if (!area) return;

  // Use the filtered task list (currentAreaTasks) so the label reflects
  // only applicable tasks, not the raw config array.
  const task = currentAreaTasks[currentTaskIndex] ?? null;
  const modeLabel = isAdaptiveMode ? " — Review" : "";

  document.getElementById("progress-label").textContent =
    `Area ${area.id} of ${totalAreas}${modeLabel}`;

  document.getElementById("area-label").textContent =
    `Area ${area.id}: ${area.title}` +
    (task ? ` — Task ${task.id}: ${task.title}` : "");
}

// ===============================
// 6. SESSION FLOW
// ===============================

async function askNextQuestion() {
  if (isSingleAreaMode) singleAreaQuestionCount++;
  if (!isSingleAreaMode) fullExamAreaQuestionCount++;

  const area = config.areasOfOperation[currentAreaIndex];
  // Use currentAreaTasks (variant-filtered) rather than area.tasks directly
  const task = currentAreaTasks[currentTaskIndex] ?? null;

  // Reset UI for new question
  document.getElementById("answer").value = "";
  document.getElementById("feedback").textContent = "";
  document.getElementById("feedback-card").classList.add("hidden");
  document.getElementById("feedback-card").classList.remove("correct", "incorrect");
  document.getElementById("answer-card").classList.remove("hidden");
  document.getElementById("submit").disabled = false;
  const challengeBtn = document.getElementById("challenge-btn");
  if (challengeBtn) {
    challengeBtn.textContent = "Challenge this Grade";
    challengeBtn.dataset.challenged = "false";
    challengeBtn.disabled = false;
  }

  updateProgressUI();

  // Show a loading state in the scenario/question cards
  document.getElementById("scenario-card").classList.remove("hidden");
  document.getElementById("scenario").textContent = "Generating your question…";
  document.getElementById("question").textContent = "";

  let llmData;
  try {
    const prompt = await buildPrompt(area, task);
    llmData = await callLLM(prompt);
  } catch (err) {
    showError(err.message || "The AI engine did not respond. Please try again.");
    return;
  }

  if (llmData.scenario === "The AI returned an unexpected response.") {
    showError("The AI returned an unexpected response. Please try again.");
    return;
  }

  currentLLMData = llmData;

  // Record this question topic so the next prompt can avoid repeating it
  if (llmData.question) {
    const area = config.areasOfOperation[currentAreaIndex];
    if (area) {
      if (!recentQuestionsByArea[area.id]) recentQuestionsByArea[area.id] = [];
      const recent = recentQuestionsByArea[area.id];
      recent.push(llmData.question.slice(0, 300));
      if (recent.length > RECENT_QUESTION_MEMORY) recent.shift();
    }
  }

  const scenarioText = llmData.scenario || "";
  const scenarioCard = document.getElementById("scenario-card");
  if (scenarioText) {
    document.getElementById("scenario").textContent = scenarioText;
    scenarioCard.classList.remove("hidden");
  } else {
    scenarioCard.classList.add("hidden");
  }
  document.getElementById("question").textContent = llmData.question || "";
}

function moveToNextTask() {
  currentTaskIndex++;
  // Use currentAreaTasks (variant-filtered) to know when we've exhausted the area
  if (currentTaskIndex >= currentAreaTasks.length) {
    moveToNextArea();
  } else {
    askNextQuestion();
  }
}

function moveToNextArea() {
  // In single-area mode, cycle back to the start of the same area instead of advancing
  if (isSingleAreaMode) {
    currentTaskIndex = 0;
    askNextQuestion();
    return;
  }

  // Record pass/fail for the area we just finished.
  // If this was an extension round, re-evaluate — the student may have
  // pulled their score up enough to pass.
  const finishedArea = config.areasOfOperation[currentAreaIndex];
  if (finishedArea) {
    const stats = sessionPerformance[finishedArea.id] || { correct: 0, partial: 0, incorrect: 0 };
    const total = stats.correct + (stats.partial || 0) + stats.incorrect;
    const score = stats.correct + (stats.partial || 0) * 0.5;
    const passed = score >= areaPassThreshold(total);
    fullExamAreaResults[finishedArea.id] = { passed, stats };
    // Only add to extension set if this was the base round and they failed
    if (!passed && !currentAreaInExtension) {
      fullExamExtensionAvailable.add(finishedArea.id);
    }
  }

  currentAreaInExtension = false;  // reset for the next area
  currentAreaIndex++;
  currentTaskIndex = 0;
  fullExamAreaQuestionCount = 0;  // reset counter for the new area
  // Recent question memory is per-area — no need to carry it forward
  // (each area starts fresh; old area's history stays in case of extension)
  recentQuestionsByArea[config.areasOfOperation[currentAreaIndex - 1]?.id] = [];

  // Skip areas that have no applicable tasks for the selected variant
  while (
    currentAreaIndex < config.areasOfOperation.length &&
    !hasApplicableTasks(config.areasOfOperation[currentAreaIndex], activeVariant)
  ) {
    currentAreaIndex++;
  }

  if (currentAreaIndex >= config.areasOfOperation.length) {
    // All areas done — move to extension/completion phase
    startExtensionPhase();
  } else {
    // Rebuild task list for the new area (base round = required tasks only)
    currentAreaTasks = buildAreaTaskList(
      config.areasOfOperation[currentAreaIndex],
      activeVariant,
      false
    );
    askNextQuestion();
  }
}

// -----------------------------------------------------------------------
// FULL EXAM — EXTENSION PHASE
// -----------------------------------------------------------------------
// Called after all areas have had their base questions.
// If any areas were failed and extensions are available, offer them one
// at a time. Student can accept or skip each one.
// When all extensions are used or declined, show final results.
// -----------------------------------------------------------------------
function startExtensionPhase() {
  const nextFailedAreaId = [...fullExamExtensionAvailable][0];
  if (!nextFailedAreaId) {
    // No extensions left — show final results
    showCompletion();
    return;
  }
  showExtensionOffer(nextFailedAreaId);
}

function showExtensionOffer(areaId) {
  const area = config.areasOfOperation.find(a => a.id === areaId);
  const stats = fullExamAreaResults[areaId]?.stats || { correct: 0, partial: 0, incorrect: 0 };
  const total = stats.correct + (stats.partial || 0) + stats.incorrect;
  const pct = total > 0 ? Math.round((stats.correct + (stats.partial || 0) * 0.5) / total * 100) : 0;

  // Reuse the single-area-complete screen with a custom message
  document.getElementById("single-area-title").textContent = `Area ${area.id} — Not Yet`;
  document.getElementById("single-area-score").textContent = `${pct}%`;
  document.getElementById("single-area-score").className = "big-score score-fail";
  document.getElementById("single-area-message").textContent =
    `You scored ${pct}% on Area ${area.id}: ${area.title}. ` +
    `You may attempt ${FULL_EXAM_EXTENSION_QUESTIONS} more questions to try to pass this area, ` +
    `or finish now and discuss this area with your instructor before retrying.`;

  const moreBtn = document.getElementById("single-area-more");
  moreBtn.textContent = `Try ${FULL_EXAM_EXTENSION_QUESTIONS} more questions`;
  moreBtn.classList.remove("hidden");

  // Wire buttons for this specific area
  moreBtn.onclick = () => startAreaExtension(areaId);
  document.getElementById("single-area-done").onclick = () => {
    fullExamExtensionAvailable.delete(areaId);
    startExtensionPhase();  // move to next failed area or finish
  };

  showScreen("single-area-complete");
}

function startAreaExtension(areaId) {
  fullExamExtensionAvailable.delete(areaId);
  const idx = config.areasOfOperation.findIndex(a => a.id === areaId);
  currentAreaIndex = idx;
  currentTaskIndex = 0;
  fullExamAreaQuestionCount = 0;

  // Extension round includes all applicable tasks (required + optional) —
  // this is where "optional" variant tasks finally get covered.
  currentAreaTasks = buildAreaTaskList(
    config.areasOfOperation[currentAreaIndex],
    activeVariant,
    true  // isExtensionRound = true
  );

  // Track that this area is in extension mode so handleSubmit knows when to stop
  currentAreaInExtension = true;
  showScreen("exam");
  askNextQuestion();
}

// True when the current area is being re-examined in the extension round
let currentAreaInExtension = false;

function showCompletion() {
  const totals = Object.values(sessionPerformance).reduce(
    (acc, s) => {
      acc.correct += s.correct;
      acc.partial += (s.partial || 0);
      acc.incorrect += s.incorrect;
      return acc;
    },
    { correct: 0, partial: 0, incorrect: 0 }
  );
  const total = totals.correct + totals.partial + totals.incorrect;
  const pct = total > 0 ? Math.round(((totals.correct + totals.partial * 0.5) / total) * 100) : 0;

  // Send full exam results via postMessage if embedded in an iframe.
  // Includes per-area results and all grade challenges raised during the session.
  if (!isSingleAreaMode && window.parent !== window) {
    const allPassed = Object.values(fullExamAreaResults).every(r => r.passed);
    window.parent.postMessage({
      type: "oralExamFullResult",
      passed: allPassed,
      areaResults: fullExamAreaResults,
      challenged: gradeChallenges,
      totals: { correct: totals.correct, partial: totals.partial, incorrect: totals.incorrect, total, pct }
    }, "*");
  }

  // In full exam mode, show per-area pass/fail breakdown and an overall result.
  // In single-area mode (or legacy full-exam without area results), show the
  // simple summary message.
  const areaResultIds = Object.keys(fullExamAreaResults);
  if (!isSingleAreaMode && areaResultIds.length > 0) {
    const allPassed = areaResultIds.every(id => fullExamAreaResults[id].passed);
    let html = `<strong>${allPassed ? "Overall: PASS" : "Overall: NOT YET — see areas below"}</strong><br><br>`;
    html += "<table style='width:100%;text-align:left;border-collapse:collapse'>";
    html += "<tr><th>Area</th><th>Score</th><th>Result</th></tr>";
    for (const area of config.areasOfOperation) {
      const result = fullExamAreaResults[area.id];
      if (!result) continue;
      const s = result.stats;
      const t = s.correct + (s.partial || 0) + s.incorrect;
      const p = t > 0 ? Math.round((s.correct + (s.partial || 0) * 0.5) / t * 100) : 0;
      const icon = result.passed ? "✓" : "✗";
      html += `<tr><td>${area.id}: ${area.title}</td><td>${p}%</td><td>${icon}</td></tr>`;
    }
    html += "</table>";
    document.getElementById("complete-message").innerHTML = html;
  } else {
    // Single-area or simple summary
    const parts = [`${totals.correct} correct`];
    if (totals.partial > 0) parts.push(`${totals.partial} partial`);
    parts.push(`${totals.incorrect} incorrect`);
    document.getElementById("complete-message").textContent =
      `You answered ${parts.join(", ")} out of ${total} questions (${pct}% score). ` +
      `Well done working through the entire exam — keep it up!`;
  }

  showScreen("complete");
}

// ===============================
// 7. PROMPT BUILDER
// ===============================

async function buildPrompt(area, task) {
  const template = await fetch("prompts/oral_exam_prompt.txt").then(r => r.text());

  // Build variant context string for the prompt.
  // Tells the AI which tasks are required for this variant (if any), so it can
  // weight questions toward mandatory content in base rounds and include optional
  // content in extension rounds.
  let variantContext = "";
  if (activeVariant) {
    const requiredTasks = (area.tasks || [])
      .filter(t => !t.variants || t.variants[activeVariant] === "required")
      .map(t => `${t.id}: ${t.title}`)
      .join(", ");
    const optionalTasks = (area.tasks || [])
      .filter(t => t.variants && t.variants[activeVariant] === "optional")
      .map(t => `${t.id}: ${t.title}`)
      .join(", ");
    variantContext =
      `Rating variant: ${activeVariant}\n` +
      (requiredTasks ? `Required tasks for this variant: ${requiredTasks}\n` : "") +
      (optionalTasks ? `Optional tasks for this variant (extension round only): ${optionalTasks}\n` : "") +
      (currentAreaInExtension
        ? "This is an EXTENSION ROUND — cover both required and optional tasks.\n"
        : "This is a BASE ROUND — focus on required tasks only.\n");
  }

  // Build the recent-questions list for this area.
  // Injected into the prompt so the AI explicitly avoids repeating concepts.
  const recent = recentQuestionsByArea[area.id] || [];
  const recentContext = recent.length > 0
    ? "The following questions were ALREADY asked in this session. You MUST NOT ask about the same topic again — not with different wording, not with a different scenario, not as a follow-up. Pick a completely different concept from this area:\n" +
      recent.map((q, i) => `  ${i + 1}. ${q}`).join("\n")
    : "";

  return template
    .replace("{{certificate}}", config.certificate)
    .replace("{{areaTitle}}", area.title)
    .replace("{{areaId}}", area.id)
    .replace("{{taskId}}", task ? `${task.id}: ${task.title}` : "")
    .replace("{{depth}}", depthMode)
    .replace("{{aircraft}}", "generic training aircraft")
    .replace("{{acsUrl}}", config.acsUrl)
    .replace("{{PHAK}}", config.references.PHAK)
    .replace("{{AIM}}", config.references.AIM)
    .replace("{{FARs}}", config.references.FARs)
    .replace("{{AFH}}", config.references.AFH || "")
    .replace("{{variantContext}}", variantContext)
    .replace("{{recentContext}}", recentContext)
    .replace("{{localText}}", localTextCache);
}

// ===============================
// 8. LLM CALL
// ===============================

// This calls our Cloudflare Function, which keeps the OpenAI API key secret.
// The function lives at /functions/api/oral-exam.js in this project.
async function callLLM(prompt) {
  try {
    const response = await fetch("/api/oral-exam", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Exam-Token": sessionToken },
      body: JSON.stringify({ prompt })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API error ${response.status}: ${errText}`);
    }

    return await response.json();

  } catch (err) {
    throw err;
  }
}

// ===============================
// 9. SUBMIT HANDLER
// ===============================

// Wired up once on page load (not re-attached on every question).
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("submit").addEventListener("click", handleSubmit);
  document.getElementById("next").addEventListener("click", handleNext);
  document.getElementById("flag-btn").addEventListener("click", handleFlag);
  document.getElementById("challenge-btn").addEventListener("click", handleChallenge);
  // Note: single-area-more and single-area-done are wired here for single-area mode.
  // In full exam mode, showExtensionOffer() temporarily overrides their onclick
  // handlers per area. They are restored to these defaults after the extension phase.
  document.getElementById("single-area-more").addEventListener("click", handleSingleAreaMore);
  document.getElementById("single-area-done").addEventListener("click", returnResults);
});

async function handleFlag() {
  const btn = document.getElementById("flag-btn");
  btn.disabled = true;
  btn.textContent = "Flagging…";

  const area = config.areasOfOperation[currentAreaIndex];
  const task = currentAreaTasks[currentTaskIndex] ?? null;
  const feedbackCard = document.getElementById("feedback-card");

  const payload = {
    timestamp: new Date().toISOString(),
    certificate: config.certificate,
    areaId: area.id,
    areaTitle: area.title,
    taskId: task ? `${task.id}: ${task.title}` : "",
    scenario: currentLLMData?.scenario || "",
    question: currentLLMData?.question || "",
    studentAnswer: document.getElementById("answer").value,
    aiGrade: feedbackCard.classList.contains("correct") ? "correct"
            : feedbackCard.classList.contains("partial") ? "partial" : "incorrect",
    aiFeedback: document.getElementById("feedback").textContent
  };

  try {
    const res = await fetch("/api/flag", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Exam-Token": sessionToken },
      body: JSON.stringify(payload)
    });
    btn.textContent = res.ok ? "Flagged ✓" : "Flag failed";
  } catch {
    btn.textContent = "Flag failed";
  }
}

function handleChallenge() {
  const btn = document.getElementById("challenge-btn");
  if (btn.dataset.challenged === "true") return;  // already challenged this question

  const area = config.areasOfOperation[currentAreaIndex];
  const task = currentAreaTasks[currentTaskIndex] ?? null;
  const feedbackCard = document.getElementById("feedback-card");
  const grade = feedbackCard.classList.contains("correct") ? "correct"
              : feedbackCard.classList.contains("partial") ? "partial" : "incorrect";

  // Store the full question detail — the TMS has no other record of this
  gradeChallenges.push({
    timestamp: new Date().toISOString(),
    areaId: area.id,
    areaTitle: area.title,
    taskId: task ? `${task.id}: ${task.title}` : "",
    scenario: currentLLMData?.scenario || "",
    question: currentLLMData?.question || "",
    studentAnswer: document.getElementById("answer").value,
    aiGrade: grade,
    aiFeedback: document.getElementById("feedback").textContent
  });

  btn.textContent = "Challenged ✓ — instructor will review";
  btn.dataset.challenged = "true";
  btn.disabled = true;
}

async function handleSubmit() {
  const answer = document.getElementById("answer").value.trim();
  if (!answer) return;

  document.getElementById("submit").disabled = true;

  const area = config.areasOfOperation[currentAreaIndex];
  const task = area?.tasks?.[currentTaskIndex] ?? null;

  // Send the student's answer back to the LLM for evaluation
  const evalPrompt = buildEvalPrompt(currentLLMData, answer, area, task);
  const evalData = await callLLM(evalPrompt);

  const feedbackCard = document.getElementById("feedback-card");
  const feedbackEl = document.getElementById("feedback");
  document.getElementById("answer-card").classList.add("hidden");

  if (!evalData) {
    feedbackEl.textContent = "Could not get feedback. Your answer was recorded.";
    feedbackCard.classList.remove("hidden");
    recordPerformance(area.id, false);
    return;
  }

  // Show feedback
  const grade = evalData.evaluation?.grade ?? (evalData.evaluation?.correct ? "correct" : "incorrect");
  feedbackEl.textContent = evalData.evaluation?.feedback || evalData.evaluation || "Answer recorded.";
  feedbackCard.classList.remove("hidden", "correct", "partial", "incorrect");
  feedbackCard.classList.add(grade);

  // Record in performance log
  recordPerformance(area.id, grade);

  // Determine what happens when the student clicks Next -------------------
  //
  // SINGLE-AREA MODE: check against base or extended question limit.
  //   Base round:      singleAreaBaseQuestions (default 9, set by ?questions=N)
  //   Extension round: base + singleAreaExtensionQuestions (ceil(N/3))
  //
  // FULL EXAM MODE: check against per-area base or extension limit.
  //   Base round:      FULL_EXAM_BASE_QUESTIONS (5)
  //   Extension round: FULL_EXAM_EXTENSION_QUESTIONS (2)
  //
  // In both cases, hitting the limit triggers a result/check screen rather
  // than letting the LLM's nextAction drive navigation.
  // -----------------------------------------------------------------------
  if (isSingleAreaMode) {
    const limit = singleAreaExtended
      ? singleAreaBaseQuestions + singleAreaExtensionQuestions
      : singleAreaBaseQuestions;
    if (singleAreaQuestionCount >= limit) {
      feedbackCard.dataset.nextAction = "singleAreaCheck";
    } else {
      feedbackCard.dataset.nextAction = evalData.nextAction || "askNextQuestion";
    }
  } else {
    // Full exam mode — enforce per-area question limit
    const areaLimit = currentAreaInExtension
      ? FULL_EXAM_EXTENSION_QUESTIONS
      : FULL_EXAM_BASE_QUESTIONS;
    if (fullExamAreaQuestionCount >= areaLimit) {
      // Area is done — next click should move to next area (or extension phase)
      feedbackCard.dataset.nextAction = "moveToNextArea";
    } else {
      feedbackCard.dataset.nextAction = evalData.nextAction || "askNextQuestion";
    }
  }
}

function handleNext() {
  const feedbackCard = document.getElementById("feedback-card");
  const nextAction = feedbackCard.dataset.nextAction || "askNextQuestion";

  if (nextAction === "singleAreaCheck") showSingleAreaResult();
  else if (nextAction === "moveToNextTask") moveToNextTask();
  else if (nextAction === "moveToNextArea") moveToNextArea();
  else if (nextAction === "drillWeakAreas") startAdaptiveFlow();
  else if (nextAction === "sessionComplete") showCompletion();
  else askNextQuestion();
}

// ===============================
// 10. EVAL PROMPT BUILDER
// ===============================

// After the student answers, we send a second prompt to the LLM asking it
// to evaluate the answer and provide feedback.
function buildEvalPrompt(originalResponse, studentAnswer, area, task) {
  // Use task-level groundingNotes if available — more specific, fewer tokens.
  // Fall back to area-level groundingNotes if the task has none.
  // To add task-level notes: add a "groundingNotes" field to the task object
  // in the config file alongside "id" and "title".
  const groundingNotes = (task?.groundingNotes) || area.groundingNotes || "";
  return JSON.stringify({
    role: "evaluator",
    certificate: config.certificate,
    areaId: area.id,
    areaTitle: area.title,
    taskId: task ? `${task.id}: ${task.title}` : "",
    depth: depthMode,
    acsUrl: config.acsUrl,
    originalScenario: originalResponse.scenario,
    originalQuestion: originalResponse.question,
    studentAnswer: studentAnswer,
    groundingNotes: groundingNotes,
    instruction:
      "You are grading a student's answer to a specific oral exam question. " +

      // Step 1: anchor to the exact question asked
      "STEP 1 — IDENTIFY WHAT WAS ASKED. " +
      "The exact question the student was asked is in the 'originalQuestion' field. " +
      "Before doing anything else, extract the specific scope of that question: " +
      "What single topic does it ask about? What would a complete answer need to address? " +
      "Write this scope down mentally — it is the ONLY thing the student is being graded on. " +

      // Step 2: apply scenario context
      "STEP 2 — APPLY SCENARIO CONTEXT. " +
      "If 'originalScenario' is empty or blank, skip Steps 2 and 2B entirely — there is no scenario. " +
      "Grade purely on whether the answer is factually correct and complete per FAA standards. " +
      "Do not invent or assume any situational constraints. " +
      "If 'originalScenario' is present, it established the conditions the student was placed in. " +
      "The student's answer must be correct for THOSE conditions — not for some other situation. " +
      "If the scenario places the student in cruise flight, do not penalize them for not discussing takeoff factors. " +
      "If the scenario specifies a particular aircraft type, altitude, weather, or phase of flight, " +
      "treat those as fixed constraints and grade within them. " +
      "CRITICAL — ONLY USE EXPLICITLY STATED DETAILS: " +
      "Do NOT assume any operational detail that was not explicitly written in the scenario. " +
      "This includes: time of day (day vs. night), weather conditions, pilot certificate level, " +
      "flight rules (VFR vs. IFR), airspace class, passenger status, and phase of flight. " +
      "If a detail is not stated in the scenario, treat it as unknown — do not assume it one way or the other. " +
      "If the student's answer is correct under any reasonable reading of the unstated conditions, " +
      "do not penalize them for it. " +
      "If a key condition was absent from the scenario and the correct answer genuinely depends on it, " +
      "note the ambiguity briefly in feedback but do not mark the answer incorrect solely because of that gap. " +
      "If there is a clear contradiction between scenario and question, note it briefly in feedback " +
      "but do not penalize the student — grade against the question as asked. " +

      "STEP 2B — MATCH PROCEDURES TO THE SCENARIO ENVIRONMENT. " +
      "The type of airport and airspace in the scenario determines which procedures are relevant. " +
      "Tower-specific procedures (light gun signals, ATC clearances, Class D radio calls, ATIS) " +
      "apply ONLY when the scenario places the student at a TOWERED airport. " +
      "Non-towered procedures (CTAF self-announce, UNICOM) apply ONLY at non-towered airports. " +
      "NEVER penalize a student for failing to mention a procedure that belongs to a different " +
      "airport environment than the one described in the scenario. " +
      "This principle extends to all environment-specific knowledge: IFR procedures do not apply " +
      "to a VFR-only scenario; night requirements do not apply to a daytime scenario; etc. " +

      // Step 3: grade narrowly
      "STEP 3 — GRADE NARROWLY. " +
      "A complete answer is one that correctly addresses what the question asked within the scenario context. " +
      "Do NOT penalize for omitting information that was not asked for. " +
      "Do NOT penalize for not addressing factors that the scenario did not raise. " +
      "Do NOT upgrade a grade because the student said other correct things unrelated to the question. " +
      "If groundingNotes are provided, treat them as authoritative FAA facts — use them to verify specific claims. " +
      "CRITICAL: if any part of the answer contains a specific factual error (wrong direction, wrong number, " +
      "wrong procedure step, wrong control input), grade 'partial' or 'incorrect' regardless of what else was correct. " +

      "DECISION-BASED SCOPING: " +
      "If the student's answer includes a clear decision that resolves the situation — " +
      "such as 'I would not fly', 'I would not depart', 'I would land immediately', or 'I would divert' — " +
      "do NOT penalize them for failing to address what would happen under the opposite decision. " +
      "A student who correctly identifies an inoperative or out-of-limits item and states they will not fly " +
      "has given a complete and correct answer. They are not required to also discuss troubleshooting, " +
      "risk mitigation, or operational workarounds that only apply if they chose to fly anyway. " +
      "The same logic applies in flight: a student who says 'I would divert' or 'I would declare an emergency' " +
      "does not also need to explain how they would continue the flight under those conditions. " +
      "Grade the decision the student actually made — not the decision you expected them to make. " +

      // Grades
      "GRADING THRESHOLDS — apply these in order: " +
      "First check for factual errors. Any specific factual error (wrong number, wrong direction, wrong procedure step) " +
      "makes the answer 'incorrect' regardless of how much else was right. " +
      "If the answer is factually clean, then judge completeness: " +
      "'correct' — answer covers roughly 80% or more of what was asked; minor omissions are fine and should be " +
      "mentioned briefly in feedback but do not affect the grade. " +
      "'partial' — answer is factually accurate but only covers about 60–80% of what was asked; " +
      "meaningful elements are missing but the student clearly understands the core concept. " +
      "'incorrect' — answer contains a factual error, OR covers less than roughly 60% of what was asked " +
      "(missed the point entirely or gave a dangerously incomplete answer). " +
      "When in doubt between 'correct' and 'partial', lean toward 'correct' — " +
      "a student who gets the concept right and misses some detail is not failing a checkride. " +
      "Only use 'partial' when you can clearly identify a meaningful gap, not just an absence of elaboration. " +

      // Output
      "Respond with a JSON object: " +
      '{ "evaluation": { "grade": "correct|partial|incorrect", "feedback": "..." }, ' +
      '"nextAction": "askNextQuestion | moveToNextTask | moveToNextArea | sessionComplete" }. ' +
      "In the feedback: address the student in second person ('You correctly...', 'You missed...'), " +
      "be concise, cite FAA references only where the student was wrong or incomplete, " +
      "and do NOT reference information from outside the question and scenario. " +
      "Do NOT include any text outside the JSON object."
  });
}

// ===============================
// 11. SINGLE-AREA MODE
// ===============================

function showSingleAreaResult() {
  const area = config.areasOfOperation[currentAreaIndex];
  const stats = sessionPerformance[area.id] || { correct: 0, partial: 0, incorrect: 0 };
  const total = stats.correct + (stats.partial || 0) + stats.incorrect;
  const score = total > 0 ? (stats.correct + (stats.partial || 0) * 0.5) / total : 0;
  const pct = Math.round(score * 100);
  const passed = pct >= 90;

  document.getElementById("single-area-title").textContent =
    passed ? "Great Work!" : "Area Complete";
  document.getElementById("single-area-score").textContent = `${pct}%`;
  document.getElementById("single-area-score").className =
    "big-score " + (passed ? "score-pass" : "score-fail");
  document.getElementById("single-area-message").textContent = passed
    ? `You scored ${pct}% on Area ${area.id}: ${area.title}. You've demonstrated solid knowledge of this area.`
    : `You scored ${pct}% on Area ${area.id}: ${area.title}. A score of 90% is needed to demonstrate mastery.`;

  // Show the extension button only on the first result screen (not after extension is used).
  // Button label reflects the actual number of extension questions for this session.
  const moreBtn = document.getElementById("single-area-more");
  moreBtn.textContent = `Give me ${singleAreaExtensionQuestions} more question${singleAreaExtensionQuestions !== 1 ? "s" : ""}`;
  moreBtn.classList.toggle("hidden", singleAreaExtended);

  showScreen("single-area-complete");
}

function handleSingleAreaMore() {
  singleAreaExtended = true;
  currentTaskIndex = 0;
  // Extension round: expand to all applicable tasks (required + optional)
  currentAreaTasks = buildAreaTaskList(
    config.areasOfOperation[currentAreaIndex],
    activeVariant,
    true  // isExtensionRound = true
  );
  showScreen("exam");
  askNextQuestion();
}

function returnResults() {
  const area = config.areasOfOperation[currentAreaIndex];
  const stats = sessionPerformance[area.id] || { correct: 0, partial: 0, incorrect: 0 };
  const total = stats.correct + (stats.partial || 0) + stats.incorrect;
  const score = total > 0 ? (stats.correct + (stats.partial || 0) * 0.5) / total : 0;
  const pct = Math.round(score * 100);

  const result = {
    type: "oralExamResult",
    area: area.id,
    areaTitle: area.title,
    score: pct,
    correct: stats.correct,
    partial: stats.partial || 0,
    incorrect: stats.incorrect,
    total,
    passed: pct >= 90,
    // challenged: array of questions the student disagreed with.
    // Each entry contains full question detail for instructor review.
    // Empty array if no challenges were raised.
    challenged: gradeChallenges.filter(c => c.areaId === area.id)
  };

  // postMessage for iframe embedding
  if (window.parent !== window) {
    window.parent.postMessage(result, "*");
  }

  // Redirect if returnUrl provided
  if (returnUrl) {
    try {
      const url = new URL(returnUrl);
      Object.entries(result).forEach(([k, v]) => url.searchParams.set(k, String(v)));
      window.location.href = url.toString();
      return;
    } catch {
      console.error("Invalid returnUrl:", returnUrl);
    }
  }

  // Fallback: show the standard completion screen
  showCompletion();
}

// ===============================
// 12. START
// ===============================

init();
