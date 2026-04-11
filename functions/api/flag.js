// ===============================
// CLOUDFLARE FUNCTION: /api/flag
// ===============================
// Stores flagged questions for Climb admin review.
//
// Requires a KV namespace binding named EXAM_FLAGS.
// Set this up in Cloudflare Pages dashboard:
//   Settings → Functions → KV namespace bindings
//   Variable name: EXAM_FLAGS
//
// To view flags, GET /api/flag?token=<VALID_TOKEN>

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Exam-Token",
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const token = request.headers.get("X-Exam-Token") || new URL(request.url).searchParams.get("token");
  if (!token || token !== env.VALID_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  if (!env.EXAM_FLAGS) {
    // KV not configured — still return success so the UI doesn't break
    console.warn("EXAM_FLAGS KV binding not configured. Flag was not stored.");
    return new Response(JSON.stringify({ ok: true, warning: "KV not configured" }), {
      status: 200, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  const key = `flag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await env.EXAM_FLAGS.put(key, JSON.stringify(body), { expirationTtl: 60 * 60 * 24 * 90 }); // 90 days

  return new Response(JSON.stringify({ ok: true, key }), {
    status: 200, headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  // Admin-only: requires valid token
  const token = new URL(request.url).searchParams.get("token");
  if (!token || token !== env.VALID_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  if (!env.EXAM_FLAGS) {
    return new Response(JSON.stringify({ error: "KV not configured" }), {
      status: 503, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  const list = await env.EXAM_FLAGS.list({ prefix: "flag_" });
  const flags = await Promise.all(
    list.keys.map(async ({ name }) => {
      const val = await env.EXAM_FLAGS.get(name);
      return val ? { key: name, ...JSON.parse(val) } : null;
    })
  );

  return new Response(JSON.stringify(flags.filter(Boolean)), {
    status: 200, headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}
