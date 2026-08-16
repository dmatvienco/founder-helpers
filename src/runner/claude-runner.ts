import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnTracked } from "../util/proc.js";
import { treeKill } from "../util/tree-kill.js";
import { SESSION_LIMIT_RE, type Runner, type RunResult, type RunSpec } from "./runner.js";
import { describeToolUse, parseStreamJsonLine, splitLines } from "./stream-json.js";

const TAIL_LIMIT = 64 * 1024; // keep the last 64KB of extracted text for status detection

/**
 * Runs one headless claude CLI session with a hard timeout and a guaranteed
 * process-tree kill. Never blocks on anything but the child itself — a
 * headless run has nobody to deliver callbacks to (predecessor issue #64).
 *
 * stdout is `--output-format stream-json` (JSON Lines): line-buffered
 * (holding the trailing partial line across chunks and flushing it once
 * more after the process closes, #22), `tool_use` blocks become onProgress
 * events, assistant/result text feeds the session-limit tail, and a
 * structured `authentication_failed` marker (#21) short-circuits status to
 * "auth" regardless of exit code. A line that fails to parse is skipped,
 * not fatal.
 */
export class ClaudeRunner implements Runner {
  async run(spec: RunSpec): Promise<RunResult> {
    mkdirSync(spec.runDir, { recursive: true });
    const outputLog = path.join(spec.runDir, "output.log");
    const stream = createWriteStream(outputLog, { flags: "a" });

    const args: string[] = [
      ...(spec.binArgs ?? []),
      "-p",
      spec.spawnPrompt,
      "--model",
      spec.model,
      "--output-format",
      "stream-json",
      "--verbose", // the CLI requires this when --print is combined with stream-json output
    ];
    if (spec.permissionMode === "bypass") {
      args.push("--dangerously-skip-permissions");
    } else {
      // Both non-bypass modes run acceptEdits + the generated allowlist:
      // file edits auto-accepted (a headless dev must be able to write code),
      // Bash gated by the settings rules. Denials fail soft in -p mode.
      args.push("--permission-mode", "acceptEdits");
      if (spec.settingsFile) args.push("--settings", spec.settingsFile);
    }
    for (const dir of spec.addDirs) args.push("--add-dir", dir);

    const started = Date.now();
    const child = spawnTracked(spec.bin ?? "claude", args, { cwd: spec.cwd });

    let textTail = "";
    const appendTail = (text: string): void => {
      textTail = (textTail + text).slice(-TAIL_LIMIT);
    };
    let authFailed = false;

    const handleLine = (line: string): void => {
      for (const event of parseStreamJsonLine(line)) {
        if (event.kind === "tool_use") {
          spec.onProgress?.({ text: describeToolUse(event.name, event.input) });
        } else if (event.kind === "auth_error") {
          authFailed = true;
        } else {
          appendTail(event.text);
        }
      }
    };

    let pending = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stream.write(text);
      const split = splitLines(pending, text);
      pending = split.pending;
      for (const line of split.lines) handleLine(line);
    });
    // stderr isn't JSON — capture it raw, same as before stream-json.
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stream.write(text);
      appendTail(text);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) void treeKill(child.pid);
    }, spec.timeoutMs);

    const exitCode: number | null = await new Promise((resolve) => {
      child.on("error", (err) => {
        const text = `\n[runner] spawn error: ${err.message}\n`;
        stream.write(text);
        appendTail(text);
        resolve(null);
      });
      child.on("close", (code) => resolve(code));
    });

    // The last stdout write before close may not be newline-terminated —
    // flush it the same way as any other line instead of dropping it (#22).
    if (pending) handleLine(pending);

    clearTimeout(timer);
    stream.end();

    const status: RunResult["status"] = timedOut
      ? "timeout"
      : authFailed
        ? "auth"
        : SESSION_LIMIT_RE.test(textTail)
          ? "limit"
          : exitCode === 0
            ? "ok"
            : "error";

    return { status, exitCode, outputLog, durationMs: Date.now() - started };
  }
}
