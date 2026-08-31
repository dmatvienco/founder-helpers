import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SESSION_LIMIT_RE, type Runner, type RunResult, type RunSpec } from "./runner.js";

/**
 * Scripted stand-in for the claude CLI. The primary test vehicle: CI must
 * never spawn a real claude (session limits are shared with the founder's
 * interactive work).
 */
export interface MockScenario {
  role: string;
  /** Files the "run" pretends the model wrote. Relative paths resolve against baseDir. */
  writeFiles?: { path: string; content: string }[];
  stdout?: string;
  exitCode?: number;
  delayMs?: number;
  /** Simulates a run that never finishes: resolves as a timeout. */
  hang?: boolean;
  /** Simulates an expired/unrefreshable OAuth session: resolves as "auth". */
  authFailed?: boolean;
  /** Scripted progress lines, replayed through onProgress (each preceded by its own delay). */
  progressEvents?: { text: string; delayMs?: number }[];
  /** Session id this "run" pretends the CLI reported, for reply-mode continuity tests. */
  sessionId?: string;
}

export class MockRunner implements Runner {
  /** Every spec this runner was asked to execute, in order — for asserting on resumeSessionId etc. */
  readonly calls: RunSpec[] = [];

  constructor(
    private scenarios: MockScenario[],
    private baseDir: string,
  ) {}

  async run(spec: RunSpec): Promise<RunResult> {
    this.calls.push(spec);
    mkdirSync(spec.runDir, { recursive: true });
    const outputLog = path.join(spec.runDir, "output.log");
    const started = Date.now();
    const scenario = this.scenarios.find((s) => s.role === spec.role);
    if (!scenario) {
      writeFileSync(outputLog, `[mock] no scenario for role "${spec.role}"\n`, "utf8");
      return { status: "error", exitCode: 1, outputLog, durationMs: 0 };
    }
    for (const event of scenario.progressEvents ?? []) {
      if (event.delayMs) await new Promise((r) => setTimeout(r, event.delayMs));
      spec.onProgress?.({ text: event.text });
    }
    if (scenario.delayMs) await new Promise((r) => setTimeout(r, scenario.delayMs));
    if (scenario.hang) {
      writeFileSync(outputLog, "[mock] hanging run, killed by timeout\n", "utf8");
      return {
        status: "timeout",
        exitCode: null,
        outputLog,
        durationMs: spec.timeoutMs,
      };
    }
    if (scenario.authFailed) {
      writeFileSync(outputLog, scenario.stdout ?? "[mock] OAuth session expired\n", "utf8");
      return {
        status: "auth",
        exitCode: scenario.exitCode ?? 1,
        outputLog,
        durationMs: Date.now() - started,
      };
    }
    for (const f of scenario.writeFiles ?? []) {
      const target = path.isAbsolute(f.path) ? f.path : path.join(this.baseDir, f.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, f.content, "utf8");
    }
    const stdout = scenario.stdout ?? "";
    writeFileSync(outputLog, stdout, "utf8");
    appendFileSync(outputLog, "\n[mock] done\n", "utf8");
    const exitCode = scenario.exitCode ?? 0;
    const status: RunResult["status"] = SESSION_LIMIT_RE.test(stdout)
      ? "limit"
      : exitCode === 0
        ? "ok"
        : "error";
    return {
      status,
      exitCode,
      outputLog,
      durationMs: Date.now() - started,
      ...(scenario.sessionId ? { sessionId: scenario.sessionId } : {}),
    };
  }
}
