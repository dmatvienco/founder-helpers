// Fake claude CLI: shared session limit WITH the reset time the real CLI
// prints next to the phrase ("You've hit your session limit · resets 1pm
// (Europe/Amsterdam)", observed 2026-09-07).
console.log(
  JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "You've hit your session limit · resets 11:30am (UTC)",
  }),
);
process.exit(1);
