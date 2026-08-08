import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
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

function jsonFileCheck(name: string, file: string, schema: { parse: (v: unknown) => unknown }): Check {
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
    detail: inRepo ? `${projectRoot} (default branch: ${defaultBranch(projectRoot)})` : `${projectRoot} is not a git repository`,
  });

  checks.push({
    name: "claude CLI",
    level: commandExists("claude") ? "ok" : "fail",
    detail: commandExists("claude")
      ? "found on PATH"
      : "not found on PATH — install Claude Code (https://claude.com/claude-code)",
  });

  checks.push({
    name: "gh CLI",
    level: commandExists("gh") ? "ok" : "warn",
    detail: commandExists("gh")
      ? "found on PATH"
      : "not found — the team manages work through GitHub issues; install gh and run gh auth login",
  });

  const configDir = projectConfigDir(projectRoot);
  checks.push(jsonFileCheck("config", path.join(configDir, "config.json"), ProjectConfigSchema));
  checks.push(jsonFileCheck("permissions ledger", path.join(configDir, "permissions.json"), LedgerSchema));

  const sp = statePaths(projectRoot, opts);
  try {
    accessSync(sp.root, constants.W_OK);
    checks.push({ name: "state dir", level: "ok", detail: sp.root });
  } catch {
    checks.push({
      name: "state dir",
      level: existsSync(sp.root) ? "fail" : "warn",
      detail: existsSync(sp.root) ? `${sp.root} not writable` : `${sp.root} missing — run "fh init"`,
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
    checks.push({ name: "logs", level: "warn", detail: `${Math.round(logBytes / 1e6)} MB in ${sp.logsDir}` });
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
