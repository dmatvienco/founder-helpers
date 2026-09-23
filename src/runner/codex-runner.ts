import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnTracked } from "../util/proc.js";
import { treeKill } from "../util/tree-kill.js";
import { detectCodexAuthError, detectCodexLimit } from "./codex-limit.js";
import { describeCodexAction, parseCodexLine } from "./codex-stream.js";
import type { Runner, RunResult, RunSpec } from "./runner.js";
import { splitLines } from "./stream-json.js";

const TAIL_LIMIT = 64 * 1024; // keep the last 64KB of extracted text for status detection

/**
 * Builds the `codex exec` argument list. Isolated here, alone, because every
 * flag below is UNVERIFIED: no `codex exec --help` output was available
 * while this was written (#42) — model knowledge only. A wrong flag must be
 * a one-line fix plus a test update here, not a hunt through the runner.
 *
 *   codex [binArgs] exec [resume <id>] "<prompt>" --model <m> --json --sandbox workspace-write
 *   codex [binArgs] exec [resume <id>] "<prompt>" --model <m> --json --dangerously-bypass-approvals-and-sandbox
 *
 * `settingsFile` has no Codex equivalent (no per-command allow/deny list)
 * and is deliberately not read here — the runner logs its own caveat line
 * for it instead of silently dropping it.
 */
export function buildCodexArgs(spec: RunSpec): string[] {
  const args: string[] = [...(spec.binArgs ?? []), "exec"];
  if (spec.resumeSessionId) args.push("resume", spec.resumeSessionId);
  args.push(spec.spawnPrompt, "--model", spec.model, "--json");
  if (spec.permissionMode === "bypass") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", "workspace-write");
  }
  return args;
}

function looksLikeCodexJson(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line.trim());
    return typeof parsed === "object" && parsed !== null && "msg" in parsed;
  } catch {
    return false;
  }
}

/**
 * Runs one headless codex CLI session. Same contract as ClaudeRunner (hard
 * timeout, guaranteed process-tree kill, stdout/stderr mirrored into
 * output.log, line-buffered with the trailing partial line flushed once
 * more after close, best-effort onProgress, sessionId capture, status
 * precedence timeout > auth > limit > exit code) — reused deliberately
 * rather than inventing a new shape (#42).
 *
 * Whether `--json` is even understood by the installed CLI is unverified:
 * the FIRST non-empty stdout line decides the mode for the whole run. If it
 * parses as a Codex JSON envelope, every later line is parsed the same way
 * (an unparseable or unrecognized one is skipped, not fatal). If it does
 * not, the run is treated as plain text end to end — no progress events are
 * possible, but every raw line still feeds the status-tail so limit/auth
 * detection keeps working. A missing progress stream is a degraded run,
 * never a failed one.
 */
export class CodexRunner implements Runner {
  async run(spec: RunSpec): Promise<RunResult> {
    mkdirSync(spec.runDir, { recursive: true });
    const outputLog = path.join(spec.runDir, "output.log");
    const stream = createWriteStream(outputLog, { flags: "a" });

    if (spec.settingsFile) {
      stream.write(
        "[codex-runner] settingsFile allowlist does not apply to this engine (Codex has no per-command allow/deny list); ignoring.\n",
      );
    }

    const args = buildCodexArgs(spec);
    const started = Date.now();
    const child = spawnTracked(spec.bin ?? "codex", args, { cwd: spec.cwd });

    let textTail = "";
    const appendTail = (text: string): void => {
      textTail = (textTail + text).slice(-TAIL_LIMIT);
    };
    let authFailed = false;
    let sessionId: string | undefined;
    let jsonMode: boolean | undefined; // decided on the first non-empty stdout line

    const handleJsonLine = (line: string): void => {
      for (const event of parseCodexLine(line)) {
        if (event.kind === "tool_use") {
          spec.onProgress?.({ text: describeCodexAction(event.name, event.input) });
        } else if (event.kind === "auth_error") {
          authFailed = true;
        } else if (event.kind === "session_id") {
          sessionId = event.id;
        } else {
          appendTail(event.text);
        }
      }
    };

    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      if (jsonMode === undefined) jsonMode = looksLikeCodexJson(line);
      if (jsonMode) {
        handleJsonLine(line);
      } else {
        // --json wasn't understood (or this build never emits it): no
        // structured events are possible, so the raw line is the only
        // status-tail material there is.
        appendTail(line);
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
    // stderr isn't JSON — capture it raw, same as ClaudeRunner.
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
    // flush it the same way as any other line instead of dropping it.
    if (pending) handleLine(pending);

    clearTimeout(timer);
    // Wait for the write stream to actually flush before returning — end()
    // alone is fire-and-forget, and a caller reading output.log right after
    // run() resolves can otherwise race the pending disk write.
    await new Promise<void>((resolve) => stream.end(resolve));

    const limit = detectCodexLimit(textTail);
    const status: RunResult["status"] = timedOut
      ? "timeout"
      : authFailed || detectCodexAuthError(textTail)
        ? "auth"
        : limit
          ? "limit"
          : exitCode === 0
            ? "ok"
            : "error";

    return {
      status,
      exitCode,
      outputLog,
      durationMs: Date.now() - started,
      ...(sessionId ? { sessionId } : {}),
      ...(status === "limit" && limit ? limit : {}),
    };
  }
}
