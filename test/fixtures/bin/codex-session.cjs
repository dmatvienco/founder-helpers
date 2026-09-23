// Fake codex CLI: reports a session_id and echoes whether "resume <id>" was
// passed (and with what value), for session-continuity tests.
const idx = process.argv.indexOf("resume");
const resumeArg = idx === -1 ? "none" : process.argv[idx + 1];
console.log(
  JSON.stringify({ id: "0", msg: { type: "session_configured", session_id: "codex-sess-fixture-1" } }),
);
console.log(`RESUME_ARG:${resumeArg}`);
console.log("done");
process.exit(0);
