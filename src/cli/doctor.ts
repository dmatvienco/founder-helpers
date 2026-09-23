import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ENGINES, type EngineKind } from "./engine.js";
import { KNOWN_MODELS } from "./model-picker.js";
import { loadConfig, loadLedger, selectRunner } from "./run.js";
import { writeClaudeSettings } from "../permissions/settings.js";
import type { Runner, RunResult, RunSpec } from "../runner/runner.js";
import { writeJsonAtomic } from "../state/atomic.js";
import { projectConfigDir, statePaths, type PathsOptions } from "../state/paths.js";
import { LedgerSchema, ProjectConfigSchema, RunRecordSchema } from "../state/schema.js";
import { commandExists } from "../util/proc.js";
import { defaultBranch, isGitRepo } from "../util/git.js";

export type CheckLevel = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  level: CheckLevel;
  detail: string;
}

function jsonFileCheck(
  name: string,
  file: string,
  schema: { parse: (v: unknown) => unknown },
): Check {
  if (!existsSync(file)) {
    return { name, level: "fail", detail: `${file} missing — run "fh init"` };
  }
  try {
    schema.parse(JSON.parse(readFileSync(file, "utf8")));
    return { name, level: "ok", detail: file };
  } catch (err) {
    return {
      name,
      level: "fail",
      detail: `${file} invalid: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    };
  }
}

// Both engines refresh their credentials file on every successful CLI call.
// We can't read either format's real expiry (undocumented/version-dependent,
// and for Codex unverified altogether — #42/#43), so this is a freshness
// heuristic, not a real validity check — hence "warn", never "fail" (#21).
const CREDENTIALS_STALE_MS = 48 * 60 * 60 * 1000;

/** Best-effort OAuth-freshness probe: catches an expired-and-unrefreshable session before a headless run does. */
export function checkEngineAuth(engine: EngineKind, opts: PathsOptions = {}): Check {
  const home = opts.home ?? homedir();
  const info = ENGINES[engine];
  const file = info.credentialsPath(home);
  const name = `${engine} auth`;
  if (!existsSync(file)) {
    return {
      name,
      level: "warn",
      detail: `${file} not found — log in once with ${info.loginCommand}`,
    };
  }
  const ageMs = Date.now() - statSync(file).mtimeMs;
  if (ageMs > CREDENTIALS_STALE_MS) {
    return {
      name,
      level: "warn",
      detail:
        `credentials untouched for ${Math.round(ageMs / 3_600_000)}h — if headless runs start failing ` +
        `with an auth error, run ${info.loginCommand}`,
    };
  }
  return { name, level: "ok", detail: "credentials refreshed recently" };
}

/** Reads `runner.kind`/`runner.model` from the committed config; `undefined` when config is missing/unreadable — the pre-init case doctor already has to survive (callers fall back to "claude" for the kind, same as before). */
function readRunnerConfig(projectRoot: string): { kind: EngineKind; model: string } | undefined {
  try {
    const file = path.join(projectConfigDir(projectRoot), "config.json");
    const config = ProjectConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    return {
      kind: config.runner.kind === "codex" ? "codex" : "claude",
      model: config.runner.model,
    };
  } catch {
    return undefined;
  }
}

function otherEngine(kind: EngineKind): EngineKind {
  return kind === "claude" ? "codex" : "claude";
}

// Loose "this id looks like it belongs to THIS engine" hint, used only to spot
// the OTHER engine's id surviving under the wrong kind (#44) — never to
// validate the current engine's own free-text ids, which must stay legal.
// Codex ids are UNVERIFIED (no network while this was written, #42/#43/#44).
const ENGINE_MODEL_HINT: Record<EngineKind, RegExp> = {
  claude: /^claude-/i,
  codex: /^(gpt-|o\d)/i,
};

/** True when `model` looks like the OTHER engine's id/alias rather than `kind`'s own — the #44 bug: a stale model surviving an engine switch. An unrecognized free-text id (neither engine's pattern nor a known alias) is never flagged. */
function looksLikeOtherEngineModel(model: string, kind: EngineKind): boolean {
  const other = otherEngine(kind);
  return ENGINE_MODEL_HINT[other].test(model) || KNOWN_MODELS[other].some((m) => m.alias === model);
}

/** All environment/config checks that exist so far (grows with each milestone). */
export function runChecks(projectRoot: string, opts: PathsOptions = {}): Check[] {
  const checks: Check[] = [];

  const [major] = process.versions.node.split(".").map(Number);
  checks.push({
    name: "node",
    level: (major ?? 0) >= 20 ? "ok" : "fail",
    detail: `v${process.versions.node} (need >= 20)`,
  });

  const inRepo = isGitRepo(projectRoot);
  checks.push({
    name: "git repo",
    level: inRepo ? "ok" : "fail",
    detail: inRepo
      ? `${projectRoot} (default branch: ${defaultBranch(projectRoot)})`
      : `${projectRoot} is not a git repository`,
  });

  const runnerConfig = readRunnerConfig(projectRoot);
  const engine = runnerConfig?.kind ?? "claude";
  const engineInfo = ENGINES[engine];
  checks.push({
    name: `${engine} CLI`,
    level: commandExists(engineInfo.binary) ? "ok" : "fail",
    detail: commandExists(engineInfo.binary)
      ? "found on PATH"
      : `not found on PATH — install ${engineInfo.label} (${engineInfo.installUrl})`,
  });

  checks.push({
    name: "gh CLI",
    level: commandExists("gh") ? "ok" : "warn",
    detail: commandExists("gh")
      ? "found on PATH"
      : "not found — the team manages work through GitHub issues; install gh and run gh auth login",
  });

  checks.push(checkEngineAuth(engine, opts));

  const configDir = projectConfigDir(projectRoot);
  checks.push(jsonFileCheck("config", path.join(configDir, "config.json"), ProjectConfigSchema));

  if (runnerConfig && looksLikeOtherEngineModel(runnerConfig.model, runnerConfig.kind)) {
    const other = otherEngine(runnerConfig.kind);
    checks.push({
      name: "runner.model",
      level: "warn",
      detail:
        `"${runnerConfig.model}" looks like a ${ENGINES[other].label} model, but runner.kind ` +
        `is "${runnerConfig.kind}" — likely a stale value from switching engines. Try ` +
        `"${ENGINES[runnerConfig.kind].defaultModel}" or re-run "fh init".`,
    });
  }

  checks.push(
    jsonFileCheck("permissions ledger", path.join(configDir, "permissions.json"), LedgerSchema),
  );

  const sp = statePaths(projectRoot, opts);
  try {
    accessSync(sp.root, constants.W_OK);
    checks.push({ name: "state dir", level: "ok", detail: sp.root });
  } catch {
    checks.push({
      name: "state dir",
      level: existsSync(sp.root) ? "fail" : "warn",
      detail: existsSync(sp.root)
        ? `${sp.root} not writable`
        : `${sp.root} missing — run "fh init"`,
    });
  }

  let logBytes = 0;
  try {
    for (const name of ["daemon.log", "daemon.log.1", "daemon.log.2", "daemon.log.3"]) {
      const f = path.join(sp.logsDir, name);
      if (existsSync(f)) logBytes += statSync(f).size;
    }
  } catch {
    // absent is fine
  }
  if (logBytes > 20 * 1024 * 1024) {
    checks.push({
      name: "logs",
      level: "warn",
      detail: `${Math.round(logBytes / 1e6)} MB in ${sp.logsDir}`,
    });
  }

  return checks;
}

// Own short budget (~60-90s) — never roles.<role>.timeoutMin, which is sized
// for a real role run, not a one-shot plumbing probe.
const DEEP_TIMEOUT_MS = 90_000;
// Both fixed: the sentinel lives at a reused path (deleted before AND after
// each run, so a stale leftover from a crashed prior run can never be
// mistaken for this run's proof), and the token's home (output.log) is
// always a fresh runDir — nothing there can ever be stale.
const SENTINEL_NAME = "doctor-selftest-sentinel.txt";
const SENTINEL_TOKEN = "founder-helpers-selftest-ok";
const USAGE_ERROR_RE =
  /unknown (option|argument|flag)|unrecognized (option|argument)|unexpected argument|invalid option|not a valid (option|argument)/i;

function selftestPrompt(sentinelPath: string): string {
  return (
    `# founder-helpers self-test\n\n` +
    `This is an automated self-test of the engine integration, not a real task. Do exactly ` +
    `these two things and nothing else — no exploring the repo, no other commands, no questions:\n\n` +
    `1. Write a file at exactly this path, containing exactly this text and nothing else: ${SENTINEL_TOKEN}\n` +
    `   Path: ${sentinelPath}\n\n` +
    `2. In your final reply, print this exact line:\n` +
    `   SELFTEST_TOKEN:${SENTINEL_TOKEN}\n`
  );
}

function tailLines(file: string, n: number): string[] {
  try {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-n);
  } catch {
    return [`(could not read ${file})`];
  }
}

/** Diagnostic lines for a non-"ok" deep-check result — names the cause, not just "it failed". */
function failureLines(result: RunResult, spec: RunSpec, engine: EngineKind): string[] {
  const bin = spec.bin ?? ENGINES[engine].binary;
  const lines = [
    `argv: ${bin} ${(result.argv ?? []).join(" ")}`,
    `status: ${result.status}  exit code: ${result.exitCode ?? "n/a"}`,
    `log: ${result.outputLog}`,
    "--- last 15 lines of output.log ---",
    ...tailLines(result.outputLog, 15),
  ];
  if (result.status === "auth") {
    lines.push(`fix: session expired or never logged in — run ${ENGINES[engine].loginCommand}`);
  } else if (result.status === "timeout") {
    lines.push(
      `fix: the engine started but never finished within ${Math.round(spec.timeoutMs / 1000)}s`,
    );
  } else if (
    result.status === "error" &&
    USAGE_ERROR_RE.test(tailLines(result.outputLog, 200).join("\n"))
  ) {
    const home =
      engine === "codex"
        ? "buildCodexArgs (src/runner/codex-runner.ts)"
        : "buildClaudeArgs (src/runner/claude-runner.ts)";
    lines.push(
      `fix: the engine rejected an argument — see the argv line above. All ${ENGINES[engine].label} flags live in ${home}.`,
    );
  }
  return lines;
}

export interface DeepCheckOptions extends PathsOptions {
  /** Test hook: injected runner instead of the configured engine. */
  runner?: Runner;
  bin?: string;
  binArgs?: string[];
  timeoutMsOverride?: number;
}

export interface DeepCheckResult {
  ok: boolean;
  lines: string[];
}

/**
 * `fh doctor --deep`'s live half: builds a RunSpec the same way runRole does
 * (permissionMode mapping, settingsFile, addDirs) but with role "selftest", a
 * trivial prompt (no template/overlay), and its own short timeout — then
 * spawns it through the REAL selectRunner path and proves the whole
 * plumbing: the engine ran, could write outside the repo root (the addDirs /
 * writable-roots class of bug, #45), and its output could be parsed.
 */
export async function runDeepCheck(
  projectRoot: string,
  opts: DeepCheckOptions = {},
): Promise<DeepCheckResult> {
  const config = loadConfig(projectRoot);
  const ledger = loadLedger(projectRoot);
  const sp = statePaths(projectRoot, opts);
  const engine: EngineKind = config.runner.kind === "codex" ? "codex" : "claude";

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const runId = `${stamp}_selftest_${Math.random().toString(36).slice(2, 6)}`;
  const runDir = path.join(sp.runsDir, runId);
  mkdirSync(runDir, { recursive: true });

  const sentinelPath = path.join(sp.root, SENTINEL_NAME);
  // A leftover from a crashed prior run must never be mistaken for this
  // run's proof — clear it before spawning, not just after.
  try {
    rmSync(sentinelPath, { force: true });
  } catch {
    // best effort
  }
  const promptFile = path.join(runDir, "prompt.md");
  writeFileSync(promptFile, selftestPrompt(sentinelPath), "utf8");
  const spawnPrompt =
    `Read the file "${promptFile}" and follow it exactly. You are running headless with no human ` +
    `present — never ask questions and never wait for input.`;

  const settingsFile = writeClaudeSettings(sp.root, config, ledger);

  const spec: RunSpec = {
    role: "selftest",
    promptFile,
    spawnPrompt,
    cwd: projectRoot,
    runDir,
    timeoutMs: opts.timeoutMsOverride ?? DEEP_TIMEOUT_MS,
    model: config.runner.model,
    permissionMode: config.runner.permissionMode,
    settingsFile,
    addDirs: [sp.root],
    ...(opts.bin ? { bin: opts.bin } : {}),
    ...(opts.binArgs ? { binArgs: opts.binArgs } : {}),
  };

  const runner = opts.runner ?? selectRunner(config, sp);
  const startedAt = new Date().toISOString();
  const result = await runner.run(spec);

  writeJsonAtomic(
    path.join(runDir, "record.json"),
    RunRecordSchema.parse({
      id: runId,
      role: "selftest",
      startedAt,
      finishedAt: new Date().toISOString(),
      status: result.status,
      exitCode: result.exitCode,
    }),
    RunRecordSchema,
  );

  try {
    if (result.status !== "ok") {
      return { ok: false, lines: failureLines(result, spec, engine) };
    }

    let sentinelOk: boolean;
    try {
      sentinelOk = readFileSync(sentinelPath, "utf8").trim() === SENTINEL_TOKEN;
    } catch {
      sentinelOk = false;
    }
    if (!sentinelOk) {
      return {
        ok: false,
        lines: [
          `status: ok, but the sentinel file is missing (or stale) at ${sentinelPath}`,
          `fix: the engine ran but could not write outside the repo root — check the sandbox/` +
            `writable-roots wiring for spec.addDirs against the state dir (${sp.root}).`,
        ],
      };
    }

    let outputText = "";
    try {
      outputText = readFileSync(result.outputLog, "utf8");
    } catch {
      // fall through — the token check below reports the miss
    }
    if (!outputText.includes(`SELFTEST_TOKEN:${SENTINEL_TOKEN}`)) {
      return {
        ok: false,
        lines: [
          `status: ok, sentinel file present, but the token was not found in ${result.outputLog}`,
          `fix: the engine ran and could write outside the repo root, but its output could not be ` +
            `parsed — inspect the log.`,
        ],
      };
    }

    return {
      ok: true,
      lines: [`live ${ENGINES[engine].label} session ok — sentinel file and token both verified`],
    };
  } finally {
    try {
      rmSync(sentinelPath, { force: true });
    } catch {
      // best effort
    }
  }
}

export async function doctorCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { deep: { type: "boolean", default: false } },
    allowPositionals: true,
    strict: false,
  });
  const checks = runChecks(process.cwd());
  const icon: Record<CheckLevel, string> = { ok: "✓", warn: "!", fail: "✗" };
  for (const c of checks) {
    console.log(`${icon[c.level]} ${c.name.padEnd(18)} ${c.detail}`);
  }
  const failed = checks.filter((c) => c.level === "fail");
  if (failed.length) {
    console.log("");
    console.log(`${failed.length} check(s) failed.`);
    return 1;
  }
  if (!values.deep) {
    console.log("");
    console.log("All good.");
    return 0;
  }

  const runnerConfig = readRunnerConfig(process.cwd());
  const engine = runnerConfig?.kind ?? "claude";
  console.log("");
  console.log(
    `Starting a live ${ENGINES[engine].label} session to verify the whole path end to end — ` +
      `this uses your account's usage quota.`,
  );
  const deep = await runDeepCheck(process.cwd());
  console.log("");
  for (const line of deep.lines) console.log(line);
  console.log("");
  if (!deep.ok) {
    console.log("Deep check failed.");
    return 1;
  }
  console.log("All good (deep check passed).");
  return 0;
}
