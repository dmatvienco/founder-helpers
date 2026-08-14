// Fake claude CLI: stream-json output with tool_use progress events. line2 is
// written in two separate chunks (with a delay) to exercise the runner's
// partial-line buffering across real stdout chunk boundaries.
const line1 = JSON.stringify({ type: "system", subtype: "init" });
const line2 = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/x.ts" } }] },
});
const line3 = JSON.stringify({
  type: "assistant",
  message: {
    content: [
      { type: "thinking", thinking: "secret reasoning, must not leak into chat" },
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } },
      { type: "text", text: "done reading" },
    ],
  },
});
const line4 = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "all good" });

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
