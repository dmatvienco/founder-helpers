// Fake codex CLI: happy path, JSONL output.
console.log(
  JSON.stringify({ id: "0", msg: { type: "session_configured", session_id: "codex-sess-1" } }),
);
console.log(JSON.stringify({ id: "1", msg: { type: "agent_message", message: "all good" } }));
console.log("done");
process.exit(0);
