// Fake codex CLI: rate/usage-limit signal, reported as agent_message text.
// No reset time — Codex has no known equivalent of Claude's "resets <time>"
// line (unverified, #42).
console.log(
  JSON.stringify({
    id: "0",
    msg: { type: "agent_message", message: "Error: rate limit exceeded, please try again later." },
  }),
);
process.exit(1);
