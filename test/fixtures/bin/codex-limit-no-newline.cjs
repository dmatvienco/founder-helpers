// Fake codex CLI: rate-limit signal, but the final stdout write omits the
// trailing newline — regression fixture for the runner's trailing partial
// line flush (same rule ClaudeRunner follows for #22).
const line = JSON.stringify({
  id: "0",
  msg: { type: "agent_message", message: "Error: rate limit exceeded, please try again later." },
});
process.stdout.write(line);
process.exit(1);
