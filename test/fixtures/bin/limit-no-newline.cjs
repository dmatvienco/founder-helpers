// Fake claude CLI: shared session limit, but the final stdout write omits
// the trailing newline — regression fixture for #22 (the runner must still
// flush this leftover `pending` line into textTail after close).
const line = JSON.stringify({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  result: "You've hit your session limit until 7pm.",
});
process.stdout.write(line);
process.exit(1);
