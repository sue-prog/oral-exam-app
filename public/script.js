async function testFunction() {
  const response = await fetch("/oral-exam");
  const data = await response.json();
  console.log("Backend says:", data);
}

testFunction();
