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
let isAdaptiveMode = false;
let currentLLMData = null;     // holds the last LLM response while student is answering
let sessionToken = "";

// --- Single-area mode state ---
let isSingleAreaMode = false;
let singleAreaQuestionCount = 0;
let singleAreaExtended = false;  // true after student clicks "give me 5 more"
let returnUrl = null;

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

  // Deep linking / single-area: a specific area targeted by ID (e.g., ?area=VII)
  const startAreaId = params.get("area") || null;

  showScreen("loading");

  try {
    // --- Load Config ---
    config = await loadJSON("configs/private_asel.json");

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

  const area = config.areasOfOperation[currentAreaIndex];
  const task = area?.tasks?.[currentTaskIndex] ?? null;

  // Reset UI for new question
  document.getElementById("answer").value = "";
  document.getElementById("feedback").textContent = "";
  document.getElementById("feedback-card").classList.add("hidden");
  document.getElementById("feedback-card").classList.remove("correct", "incorrect");
  document.getElementById("answer-card").classList.remove("hidden");
  document.getElementById("submit").disabled = false;

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
  currentAreaIndex++;
  currentTaskIndex = 0;
  if (currentAreaIndex >= config.areasOfOperation.length) {
    startAdaptiveFlow();
  } else {
    askNextQuestion();
  }
}

function startAdaptiveFlow() {
  const weak = getWeakAreas();
  if (weak.length === 0) {
    showCompletion();
    return;
  }

  isAdaptiveMode = true;

  // Show a banner above the scenario card to explain what's happening
  const banner = document.createElement("div");
  banner.className = "adaptive-banner";
  banner.textContent =
    "Great work completing the full pass! Now let's revisit some areas where you had trouble.";
  document.querySelector("main").prepend(banner);

  const nextWeakAreaId = weak[0];
  const idx = config.areasOfOperation.findIndex(a => a.id === nextWeakAreaId);
  currentAreaIndex = idx;
  currentTaskIndex = 0;
  askNextQuestion();
}

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

  const parts = [`${totals.correct} correct`];
  if (totals.partial > 0) parts.push(`${totals.partial} partial`);
  parts.push(`${totals.incorrect} incorrect`);

  document.getElementById("complete-message").textContent =
    `You answered ${parts.join(", ")} out of ${total} questions (${pct}% score). ` +
    `Well done working through the entire exam — keep it up!`;

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
  document.getElementById("single-area-more").addEventListener("click", handleSingleAreaMore);
  document.getElementById("single-area-done").addEventListener("click", returnResults);
});

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

  // In single-area mode, check if we've hit the question limit
  const limit = singleAreaExtended ? 15 : 10;
  if (isSingleAreaMode && singleAreaQuestionCount >= limit) {
    feedbackCard.dataset.nextAction = "singleAreaCheck";
  } else {
    feedbackCard.dataset.nextAction = evalData.nextAction || "askNextQuestion";
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
    instruction:
      "Evaluate the student's answer using FAA ACS standards. " +
      "Grade based strictly on what the question actually asked — do not penalize for omitting information that was not required by the question. " +
      "For example, if the question asks what must be carried on the person, do not mark incorrect for failing to list documents that must exist but need not be carried. " +
      "Use a three-level grade: " +
      "'correct' — answer is substantively accurate and responsive to what was asked, even if not exhaustive; " +
      "'partial' — answer got the core idea right but missed one or more meaningful required elements or contained a minor inaccuracy; " +
      "'incorrect' — answer contains a clear factual error or completely missed what was asked. " +
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

  // Hide the "5 more" button if already extended or they've clearly passed
  const moreBtn = document.getElementById("single-area-more");
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
    passed: pct >= 90
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
