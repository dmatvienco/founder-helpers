// Fake claude CLI: shared session limit WITH the reset time the real CLI
// prints next to the phrase ("You've hit your session limit · resets 1pm
// (Europe/Amsterdam)", observed 2026-09-07 and 2026-09-08).
//
// The clock is computed rather than hard-coded: since #33 a reset that reads
// as only just past is deliberately left unparsed, so a fixed time would make
// this fixture fail for one hour out of every day.
const at = new Date(Date.now() + 3 * 60 * 60 * 1000);
const pad = (n) => String(n).padStart(2, "0");
const clock = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} (UTC)`;
console.log(
  JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: `You've hit your session limit · resets ${clock}`,
  }),
);
process.exit(1);
