import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnTracked } from "../util/proc.js";
import { treeKill } from "../util/tree-kill.js";
import { SESSION_LIMIT_RE, type Runner, type RunResult, type RunSpec } from "./runner.js";

const TAIL_LIMIT = 64 * 1024; // keep the last 64KB in memory for status detection

/**
 * Runs one headless claude CLI session with a hard timeout and a guaranteed
 * process-tree kill. Never blocks on anything but the child itself — a
 * headless run has nobody to deliver callbacks to (predecessor issue #64).
 */
export class ClaudeRunner implements Runner {
  async run(spec: RunSpec): Promise<RunResult> {
    mkdirSync(spec.runDir, { recursive: true });
    const outputLog = path.join(spec.runDir, "output.log");
    const stream = createWriteStream(outputLog, { flags: "a" });

    const args: string[] = [...(spec.binArgs ?? []), "-p", spec.spawnPrompt, "--model", spec.model];
    if (spec.permissionMode === "bypass") {
      args.push("--dangerously-skip-permissions");
    } else {
      if (spec.permissionMode === "acceptEdits") args.push("--permission-mode", "acceptEdits");
      if (spec.settingsFile) args.push("--settings", spec.settingsFile);
    }
    for (const dir of spec.addDirs) args.push("--add-dir", dir);

    const started = Date.now();
    const child = spawnTracked(spec.bin ?? "claude", args, { cwd: spec.cwd });

    let tail = "";
    const capture = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      stream.write(text);
      tail = (tail + text).slice(-TAIL_LIMIT);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) void treeKill(child.pid);
    }, spec.timeoutMs);

    const exitCode: number | null = await new Promise((resolve) => {
      child.on("error", (err) => {
        capture(`\n[runner] spawn error: ${err.message}\n`);
        resolve(null);
      });
      child.on("close", (code) => resolve(code));
    });

    clearTimeout(timer);
    stream.end();

    const status: RunResult["status"] = timedOut
      ? "timeout"
      : SESSION_LIMIT_RE.test(tail)
        ? "limit"
        : exitCode === 0
          ? "ok"
          : "error";

    return { status, exitCode, outputLog, durationMs: Date.now() - started };
  }
}
