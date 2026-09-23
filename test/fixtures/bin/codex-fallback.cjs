// Fake codex CLI: simulates a build that rejects --json — plain human text
// from the very first line, no JSON at all. The runner must still resolve a
// correct status from the raw stdout tail instead of going blind (#42).
console.log("error: unrecognized argument '--json'");
console.log("Falling back to plain text mode.");
console.log("You have hit a rate limit, please try again later.");
process.exit(1);
