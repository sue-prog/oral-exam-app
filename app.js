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

  const task = area.tasks?.[currentTaskIndex];
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
  const task = area?.tasks?.[currentTaskIndex] ?? null;

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

  document.getElementById("scenario").textContent = llmData.scenario || "";
  document.getElementById("question").textContent = llmData.question || "";
}

function moveToNextTask() {
  const area = config.areasOfOperation[currentAreaIndex];
  currentTaskIndex++;
  if (currentTaskIndex >= (area.tasks?.length ?? 0)) {
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

  if (currentAreaIndex >= config.areasOfOperation.length) {
    // All areas done — move to extension/completion phase
    startExtensionPhase();
  } else {
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
  const task = area?.tasks?.[currentTaskIndex] ?? null;
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
  const task = area?.tasks?.[currentTaskIndex] ?? null;
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

  btn.textContent = "Grade Challenged ✓";
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
  const groundingNotes = area.groundingNotes || "";
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
      "Evaluate the student's answer using FAA ACS standards. " +
      "If groundingNotes are provided, treat them as authoritative reference facts for this area and use them to verify the student's answer. " +
      "Grade based strictly on what the question actually asked — do not penalize for omitting information not required by the question. " +
      "CRITICAL GRADING RULE: If any part of the student's answer contains a specific factual error — such as a wrong direction, wrong number, wrong procedure step, or wrong control input — the answer MUST be graded 'partial' or 'incorrect' regardless of how much else was correct. A mostly correct answer with one specific wrong fact is never 'correct'. " +
      "Use a three-level grade: " +
      "'correct' — every factual claim in the answer is accurate and it is responsive to what was asked, even if not exhaustive; " +
      "'partial' — got the core idea right but missed a meaningful required element, OR contained a minor/specific factual inaccuracy; " +
      "'incorrect' — contains a clear factual error that would fail an FAA checkride, or completely missed what was asked. " +
      "Respond with a JSON object with these fields: " +
      '{ "evaluation": { "grade": "correct|partial|incorrect", "feedback": "examiner-style feedback with FAA references" }, ' +
      '"nextAction": "askNextQuestion | moveToNextTask | moveToNextArea | sessionComplete" }. ' +
      "Address the student directly in second person (e.g. 'You correctly identified...', 'You were close but missed...', 'You missed...'). " +
      "Be concise but cite specific FAA references where the student was incomplete or incorrect. " +
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
