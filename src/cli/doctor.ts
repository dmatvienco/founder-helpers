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
import { loadSecrets } from "../state/secrets.js";
import {
  LedgerSchema,
  ProjectConfigSchema,
  RunRecordSchema,
  type ProjectConfig,
} from "../state/schema.js";
import { execGh, type GhExec } from "../util/gh.js";
import { commandExists, type BinaryExists } from "../util/proc.js";
import { branchExistsOnOrigin, defaultBranch, hasOriginRemote, isGitRepo } from "../util/git.js";

export type CheckLevel = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  level: CheckLevel;
  detail: string;
  /**
   * True when a "fail" here means `--deep`'s live engine session cannot
   * meaningfully run (missing binary, unreadable config, ...). False/absent
   * for checks about the GitHub workflow (origin, labels, ...) that a live
   * run needs never touch (#49).
   */
  prerequisite?: boolean;
}

function jsonFileCheck(
  name: string,
  file: string,
  schema: { parse: (v: unknown) => unknown },
  opts: { prerequisite?: boolean } = {},
): Check {
  if (!existsSync(file)) {
    return { name, level: "fail", detail: `${file} missing — run "fh init"`, ...opts };
  }
  try {
    schema.parse(JSON.parse(readFileSync(file, "utf8")));
    return { name, level: "ok", detail: file, ...opts };
  } catch (err) {
    return {
      name,
      level: "fail",
      detail: `${file} invalid: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      ...opts,
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
      prerequisite: true,
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
      prerequisite: true,
    };
  }
  return { name, level: "ok", detail: "credentials refreshed recently", prerequisite: true };
}

/** Reads the committed config; `undefined` when missing/unreadable — the pre-init case doctor already has to survive. */
function readProjectConfig(projectRoot: string): ProjectConfig | undefined {
  try {
    const file = path.join(projectConfigDir(projectRoot), "config.json");
    return ProjectConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

function engineKind(config: ProjectConfig): EngineKind {
  return config.runner.kind === "codex" ? "codex" : "claude";
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

/** gh is logged in at all — checked before anything that needs a token, and the ONLY one of the three gh checks run when gh isn't even on PATH (so that case still gets a `fail`, not silence). */
function checkGhAuth(gh: GhExec, cwd: string, binaryExists: BinaryExists): Check {
  if (!binaryExists("gh")) {
    return {
      name: "gh auth",
      level: "fail",
      detail: `gh not installed — install it (https://cli.github.com), then run "gh auth login"`,
    };
  }
  const res = gh(["auth", "status"], cwd);
  return res.ok
    ? { name: "gh auth", level: "ok", detail: "logged in" }
    : { name: "gh auth", level: "fail", detail: `not logged in — run "gh auth login"` };
}

/** Distinct from `checkGhAuth`: a valid login whose token still can't see THIS repo (wrong account/org, no collaborator access). Only meaningful once auth itself is ok. */
function checkGhRepoAccess(gh: GhExec, cwd: string): Check {
  const res = gh(["repo", "view", "--json", "name"], cwd);
  return res.ok
    ? { name: "gh repo access", level: "ok", detail: "can read this repository" }
    : {
        name: "gh repo access",
        level: "fail",
        detail:
          "gh is logged in but can't read this repository — the token likely lacks access; " +
          `check the account/org, or re-run "gh auth login" with the right account`,
      };
}

/** The four labels the queue/merge flow depends on — a missing one breaks bookkeeping silently (the PM labels an issue and nothing happens). Only meaningful once repo access is confirmed. */
function checkLabels(gh: GhExec, cwd: string, labels: ProjectConfig["labels"]): Check {
  const res = gh(["label", "list", "--json", "name", "--limit", "100"], cwd);
  if (!res.ok) {
    return {
      name: "labels",
      level: "fail",
      detail: `could not list labels: ${res.stderr.split("\n")[0]}`,
    };
  }
  let existing: Set<string>;
  try {
    existing = new Set((JSON.parse(res.stdout) as { name: string }[]).map((l) => l.name));
  } catch {
    return { name: "labels", level: "fail", detail: "could not parse gh label list output" };
  }
  const required = [labels.approved, labels.inProgress, labels.review, labels.blocked];
  const missing = required.filter((l) => !existing.has(l));
  if (missing.length === 0) {
    return {
      name: "labels",
      level: "ok",
      detail: "approved/inProgress/review/blocked all present",
    };
  }
  return {
    name: "labels",
    level: "fail",
    detail:
      `missing: ${missing.join(", ")} — create with: ` +
      missing.map((l) => `gh label create "${l}"`).join("; "),
  };
}

export interface RunChecksOptions extends PathsOptions {
  /** Test hook: injected gh CLI exec — auth/network can't run for real in tests. */
  gh?: GhExec;
  /** Test hook: injected PATH lookup — the real host's PATH (e.g. no `claude` on a CI runner) can't be relied on in tests. */
  binaryExists?: BinaryExists;
}

/** All environment/config checks that exist so far (grows with each milestone). */
export function runChecks(projectRoot: string, opts: RunChecksOptions = {}): Check[] {
  const checks: Check[] = [];
  const gh = opts.gh ?? execGh;
  const binaryExists = opts.binaryExists ?? commandExists;

  const [major] = process.versions.node.split(".").map(Number);
  checks.push({
    name: "node",
    level: (major ?? 0) >= 20 ? "ok" : "fail",
    detail: `v${process.versions.node} (need >= 20)`,
    prerequisite: true,
  });

  const inRepo = isGitRepo(projectRoot);
  checks.push({
    name: "git repo",
    level: inRepo ? "ok" : "fail",
    detail: inRepo
      ? `${projectRoot} (default branch: ${defaultBranch(projectRoot)})`
      : `${projectRoot} is not a git repository`,
  });

  const projectConfig = readProjectConfig(projectRoot);

  let hasOrigin = false;
  if (inRepo) {
    hasOrigin = hasOriginRemote(projectRoot);
    checks.push({
      name: "origin remote",
      level: hasOrigin ? "ok" : "fail",
      detail: hasOrigin
        ? "present"
        : `no "origin" remote — add one with "git remote add origin <url>"`,
    });

    if (hasOrigin && projectConfig) {
      const branch = projectConfig.integrationBranch;
      const onOrigin = branchExistsOnOrigin(projectRoot, branch);
      checks.push({
        name: "integration branch",
        level: onOrigin ? "ok" : "fail",
        detail: onOrigin
          ? `"${branch}" exists on origin`
          : `"${branch}" (config.integrationBranch) not found on origin — every merge target is wrong until this exists`,
      });
    }
  }

  const engine = projectConfig ? engineKind(projectConfig) : "claude";
  const engineInfo = ENGINES[engine];
  checks.push({
    name: `${engine} CLI`,
    level: binaryExists(engineInfo.binary) ? "ok" : "fail",
    detail: binaryExists(engineInfo.binary)
      ? "found on PATH"
      : `not found on PATH — install ${engineInfo.label} (${engineInfo.installUrl})`,
    prerequisite: true,
  });

  checks.push({
    name: "gh CLI",
    level: binaryExists("gh") ? "ok" : "warn",
    detail: binaryExists("gh")
      ? "found on PATH"
      : "not found — the team manages work through GitHub issues; install gh and run gh auth login",
  });

  const ghAuth = checkGhAuth(gh, projectRoot, binaryExists);
  checks.push(ghAuth);
  if (ghAuth.level === "ok") {
    const ghRepoAccess = checkGhRepoAccess(gh, projectRoot);
    checks.push(ghRepoAccess);
    if (ghRepoAccess.level === "ok" && projectConfig) {
      checks.push(checkLabels(gh, projectRoot, projectConfig.labels));
    }
  }

  checks.push(checkEngineAuth(engine, opts));

  const configDir = projectConfigDir(projectRoot);
  checks.push(
    jsonFileCheck("config", path.join(configDir, "config.json"), ProjectConfigSchema, {
      prerequisite: true,
    }),
  );

  if (projectConfig && looksLikeOtherEngineModel(projectConfig.runner.model, engine)) {
    const other = otherEngine(engine);
    checks.push({
      name: "runner.model",
      level: "warn",
      detail:
        `"${projectConfig.runner.model}" looks like a ${ENGINES[other].label} model, but runner.kind ` +
        `is "${engine}" — likely a stale value from switching engines. Try ` +
        `"${ENGINES[engine].defaultModel}" or re-run "fh init".`,
    });
  }

  checks.push(
    jsonFileCheck("permissions ledger", path.join(configDir, "permissions.json"), LedgerSchema, {
      prerequisite: true,
    }),
  );

  const sp = statePaths(projectRoot, opts);
  try {
    accessSync(sp.root, constants.W_OK);
    checks.push({ name: "state dir", level: "ok", detail: sp.root, prerequisite: true });
  } catch {
    checks.push({
      name: "state dir",
      level: existsSync(sp.root) ? "fail" : "warn",
      detail: existsSync(sp.root)
        ? `${sp.root} not writable`
        : `${sp.root} missing — run "fh init"`,
      prerequisite: true,
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

interface TgMeResponse {
  ok: boolean;
  description?: string;
  result?: { username?: string };
}

export interface TelegramCheckOptions extends PathsOptions {
  apiBase?: string;
  /** `fh doctor --send`: actually deliver a test message. Never on by default — sending is outward communication. */
  send?: boolean;
}

/**
 * Telegram is the reporting channel, not the work itself: a broken pairing
 * stops the founder hearing from the team, but never stops the team
 * working (unlike gh/labels above) — so every check here is `warn`, never
 * `fail`.
 */
export async function runTelegramChecks(
  projectRoot: string,
  opts: TelegramCheckOptions = {},
): Promise<Check[]> {
  const checks: Check[] = [];
  const sp = statePaths(projectRoot, opts);
  const telegram = loadSecrets(sp).telegram;
  if (!telegram) {
    checks.push({
      name: "telegram pairing",
      level: "warn",
      detail: `not paired — run "fh init" in a terminal to pair a bot`,
    });
    return checks;
  }
  checks.push({ name: "telegram pairing", level: "ok", detail: `chat ${telegram.chatId}` });

  const apiBase = opts.apiBase ?? "https://api.telegram.org";
  try {
    const res = await fetch(`${apiBase}/bot${telegram.botToken}/getMe`);
    const data = (await res.json()) as TgMeResponse;
    if (!data.ok || !data.result) {
      checks.push({
        name: "telegram token",
        level: "warn",
        detail: `token rejected (${data.description ?? res.status}) — re-pair with "fh init"`,
      });
      return checks;
    }
    checks.push({
      name: "telegram token",
      level: "ok",
      detail: `valid — bot @${data.result.username ?? "?"}`,
    });
  } catch (err) {
    checks.push({
      name: "telegram token",
      level: "warn",
      detail: `could not reach Telegram (${err instanceof Error ? err.message : String(err)})`,
    });
    return checks;
  }

  if (opts.send) {
    try {
      const res = await fetch(`${apiBase}/bot${telegram.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          chat_id: telegram.chatId,
          text: "✅ founder-helpers doctor: test message — if you see this, delivery works.",
        }),
      });
      const data = (await res.json()) as { ok: boolean; description?: string };
      checks.push(
        data.ok
          ? { name: "telegram send", level: "ok", detail: "test message delivered" }
          : {
              name: "telegram send",
              level: "warn",
              detail: `delivery failed (${data.description ?? res.status})`,
            },
      );
    } catch (err) {
      checks.push({
        name: "telegram send",
        level: "warn",
        detail: `delivery failed (${err instanceof Error ? err.message : String(err)})`,
      });
    }
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

export interface DoctorCommandOptions {
  /** Test hook: injected gh CLI exec, threaded down to runChecks — auth/network can't run for real in tests. */
  gh?: GhExec;
  /** Test hook: injected PATH lookup, threaded down to runChecks — the real host's PATH can't be relied on in tests. */
  binaryExists?: BinaryExists;
}

export async function doctorCommand(
  args: string[],
  opts: DoctorCommandOptions = {},
): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      deep: { type: "boolean", default: false },
      send: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  const cwd = process.cwd();
  const checks = [
    ...runChecks(cwd, { gh: opts.gh, binaryExists: opts.binaryExists }),
    ...(await runTelegramChecks(cwd, { send: Boolean(values.send) })),
  ];
  const icon: Record<CheckLevel, string> = { ok: "✓", warn: "!", fail: "✗" };
  for (const c of checks) {
    console.log(`${icon[c.level]} ${c.name.padEnd(18)} ${c.detail}`);
  }
  const failed = checks.filter((c) => c.level === "fail");
  if (failed.length) {
    console.log("");
    console.log(`${failed.length} check(s) failed.`);
  }
  if (!values.deep) {
    if (failed.length) return 1;
    console.log("");
    console.log("All good.");
    return 0;
  }

  const prereqFailed = failed.find((c) => c.prerequisite);
  if (prereqFailed) {
    console.log("");
    console.log(
      `live check SKIPPED — prerequisite "${prereqFailed.name}" failed; nothing about the engine was verified`,
    );
    return 1;
  }

  const projectConfig = readProjectConfig(cwd);
  const engine = projectConfig ? engineKind(projectConfig) : "claude";
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
  if (failed.length) {
    console.log(`Deep check passed, but ${failed.length} other check(s) failed above.`);
    return 1;
  }
  console.log("All good (deep check passed).");
  return 0;
}
