// ===============================
// CLOUDFLARE FUNCTION: /api/oral-exam
// ===============================
// This file runs on Cloudflare's servers, NOT in the user's browser.
// It keeps your OpenAI API key and access token secret.
//
// Environment variables to set in Cloudflare Pages dashboard:
//   OPENAI_API_KEY  — your OpenAI secret key
//   VALID_TOKEN     — the shared access token (e.g., "climb")

export async function onRequestPost(context) {
  const { request, env } = context;

  // --- CORS headers so the browser can talk to this function ---
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // --- Validate token from request header or URL param ---
  const url = new URL(request.url);
  const token =
    request.headers.get("X-Exam-Token") ||
    url.searchParams.get("token");

  if (!token || token !== env.VALID_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // --- Parse the incoming prompt from the frontend ---
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const { prompt } = body;
  if (!prompt) {
    return new Response(JSON.stringify({ error: "Missing prompt" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // --- Call OpenAI ---
  let openAIResponse;
  try {
    openAIResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content:
              "You are an FAA oral exam preparation assistant. " +
              "Always respond with valid JSON only, exactly as instructed in the user prompt. " +
              "Never include markdown, code fences, or any text outside the JSON object.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.7,
        max_tokens: 1000,
      }),
    });
  } catch (err) {
    console.error("OpenAI fetch error:", err);
    return new Response(JSON.stringify({ error: "Failed to reach OpenAI" }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  if (!openAIResponse.ok) {
    const errText = await openAIResponse.text();
    console.error("OpenAI error:", errText);
    return new Response(JSON.stringify({ error: `OpenAI error ${openAIResponse.status}: ${errText}` }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const openAIData = await openAIResponse.json();
  const rawContent = openAIData.choices?.[0]?.message?.content ?? "{}";

  // --- Parse the JSON the LLM returned ---
  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    console.error("Could not parse LLM response as JSON:", rawContent);
    return new Response(
      JSON.stringify({
        scenario: "The AI returned an unexpected response.",
        question: "Please click Next to try again.",
        nextAction: "askNextQuestion",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }

  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// Handle browser preflight requests (browsers send these automatically)
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
