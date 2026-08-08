// Fake claude CLI: spawns a grandchild and never exits (timeout scenario).
const { spawn } = require("node:child_process");
const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log("GRANDCHILD:" + c.pid);
setInterval(() => {}, 1000);
