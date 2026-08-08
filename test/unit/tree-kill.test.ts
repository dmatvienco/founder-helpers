import { describe, expect, it } from "vitest";
import { spawnTracked } from "../../src/util/proc.js";
import { isAlive, treeKill } from "../../src/util/tree-kill.js";

const PARENT_SCRIPT = `
const { spawn } = require("node:child_process");
const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log("GRANDCHILD:" + c.pid);
setInterval(() => {}, 1000);
`;

async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

describe("treeKill", () => {
  it("kills the child AND its grandchild", { timeout: 20000 }, async () => {
    const parent = spawnTracked(process.execPath, ["-e", PARENT_SCRIPT]);
    const grandchildPid = await new Promise<number>((resolve, reject) => {
      let buf = "";
      parent.stdout?.setEncoding("utf8");
      parent.stdout?.on("data", (chunk: string) => {
        buf += chunk;
        const m = buf.match(/GRANDCHILD:(\d+)/);
        if (m) resolve(Number(m[1]));
      });
      parent.on("error", reject);
      setTimeout(() => reject(new Error("grandchild never reported")), 10000);
    });

    expect(isAlive(parent.pid as number)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    await treeKill(parent.pid as number);

    expect(await waitUntilDead(parent.pid as number, 5000)).toBe(true);
    expect(await waitUntilDead(grandchildPid, 5000)).toBe(true);
  });
});
