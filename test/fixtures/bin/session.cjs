// Fake claude CLI: reports a session_id on the init line and echoes whether
// --resume was passed (and with what value), for session-continuity tests.
const idx = process.argv.indexOf("--resume");
const resumeArg = idx === -1 ? "none" : process.argv[idx + 1];
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-fixture-1" }));
console.log(`RESUME_ARG:${resumeArg}`);
console.log("done");
process.exit(0);
