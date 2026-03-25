async function testFunction() {
  const response = await fetch("/oral-exam", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    prompt: "Give me an oral exam question."
  })
});
  const data = await response.json();
  console.log("Backend says:", data);
}

testFunction();
