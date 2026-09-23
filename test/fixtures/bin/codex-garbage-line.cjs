// Fake codex CLI: JSONL stream with one malformed line in the middle — must
// be skipped without failing the run (same rule stream-json.ts follows).
console.log(
  JSON.stringify({ id: "0", msg: { type: "session_configured", session_id: "codex-sess-1" } }),
);
console.log("{not valid json");
console.log(JSON.stringify({ id: "1", msg: { type: "agent_message", message: "all good" } }));
process.exit(0);
