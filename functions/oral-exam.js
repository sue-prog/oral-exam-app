export async function onRequest(context) {
  try {
    const { request, env } = context;

    // Parse the JSON body from the frontend
    const body = await request.json();
    const userPrompt = body.prompt || "Generate an oral exam question.";

    // Call Cloudflare Workers AI (Llama 3 8B)
    const aiResponse = await env.AI.run(
      "@cf/meta/llama-3-8b-instruct",
      {
        messages: [
          { role: "system", content: "You are an FAA oral exam generator." },
          { role: "user", content: userPrompt }
        ]
      }
    );

    return new Response(JSON.stringify({ result: aiResponse }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
