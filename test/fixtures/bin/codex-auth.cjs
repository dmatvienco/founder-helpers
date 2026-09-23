// Fake codex CLI: structured auth failure via an "error" msg type.
console.log(
  JSON.stringify({ id: "0", msg: { type: "error", message: "Not logged in. Run `codex login`." } }),
);
process.exit(1);
