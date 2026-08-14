// Fake claude CLI: shared session limit, reported in the final stream-json result line.
console.log(
  JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "You've hit your session limit until 7pm.",
  }),
);
process.exit(1);
