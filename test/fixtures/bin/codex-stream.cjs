// Fake codex CLI: JSONL stream with exec_command_begin/patch_apply_begin
// progress events. line2 is written in two separate chunks (with a delay) to
// exercise the runner's partial-line buffering across real stdout chunk
// boundaries.
const line1 = JSON.stringify({
  id: "0",
  msg: { type: "session_configured", session_id: "codex-sess-1" },
});
const line2 = JSON.stringify({
  id: "1",
  msg: { type: "exec_command_begin", command: ["npm", "test"] },
});
const line3 = JSON.stringify({ id: "2", msg: { type: "patch_apply_begin", path: "src/x.ts" } });
const line4 = JSON.stringify({
  id: "3",
  msg: { type: "task_complete", last_agent_message: "done" },
});

process.stdout.write(line1 + "\n");
const half = Math.floor(line2.length / 2);
process.stdout.write(line2.slice(0, half));
setTimeout(() => {
  process.stdout.write(line2.slice(half) + "\n");
  process.stdout.write(line3 + "\n");
  process.stdout.write(line4 + "\n");
  console.log("done");
  process.exit(0);
}, 50);
