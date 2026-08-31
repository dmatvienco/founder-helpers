// Fake claude CLI: fails when asked to resume a session (simulates a
// stale/unknown session id), succeeds fresh when --resume is absent — for
// testing ClaudeRunner's retry-once-without-resume fallback.
if (process.argv.includes("--resume")) {
  console.error("Error: No conversation found with session ID");
  process.exit(1);
} else {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-fresh-retry" }));
  console.log("done");
  process.exit(0);
}
