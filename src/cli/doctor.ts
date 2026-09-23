import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ENGINES, type EngineKind } from "./engine.js";
import { KNOWN_MODELS } from "./model-picker.js";
import { projectConfigDir, statePaths, type PathsOptions } from "../state/paths.js";
import { LedgerSchema, ProjectConfigSchema } from "../state/schema.js";
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
  return (
    ENGINE_MODEL_HINT[other].test(model) || KNOWN_MODELS[other].some((m) => m.alias === model)
  );
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

export async function doctorCommand(_args: string[]): Promise<number> {
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
  console.log("");
  console.log("All good.");
  return 0;
}
