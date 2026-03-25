export async function onRequest(context) {
  try {
    const { request, env } = context;

    // Read JSON body from frontend
    const body = await request.json();
    const userPrompt = body.prompt || "Generate an oral exam question.";

    // Call OpenAI
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are an FAA oral exam generator." },
          { role: "user", content: userPrompt }
        ]
      })
    });

    const data = await response.json();

    return new Response(JSON.stringify({ result: data }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
