// Fake codex CLI: mimics `codex exec` reading stdin to EOF before exiting
// ("Reading additional input from stdin..."). Only resolves once stdin ends,
// so this hangs forever if the runner leaves the child's stdin open with no
// data — exactly the #54 bug (fixed: stdin is "ignore", which EOFs at once).
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(
    JSON.stringify({ id: "0", msg: { type: "session_configured", session_id: "codex-sess-1" } }),
  );
  console.log("done");
  process.exit(0);
});
