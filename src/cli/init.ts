import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import path from "node:path";
import { pairTelegram, type PairResult } from "./pair.js";
import { loadSecrets, saveSecrets } from "../state/secrets.js";
import { writeJsonAtomic } from "../state/atomic.js";
import { projectConfigDir, statePaths, type PathsOptions, type StatePaths } from "../state/paths.js";
import {
  LedgerSchema,
  ProjectConfigSchema,
  QueueSchema,
  TransportStateSchema,
  type ProjectConfig,
} from "../state/schema.js";
import { defaultBranch, isGitRepo } from "../util/git.js";

function templatesDir(): string {
  // Both src/cli and dist/cli sit two levels below the package root.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");
}

function skillDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skill", "founder-helpers");
}

/**
 * Install/refresh the Claude Code skill into the project. The skill is
 * shipped brains (like templates), so --refresh-skill overwrites it after a
 * package update; without force we only create what's missing.
 */
export function installSkill(projectRoot: string, force: boolean): string[] {
  const target = path.join(projectRoot, ".claude", "skills", "founder-helpers");
  mkdirSync(target, { recursive: true });
  const written: string[] = [];
  for (const name of ["SKILL.md", "reference.md"]) {
    const dest = path.join(target, name);
    if (force || !existsSync(dest)) {
      copyFileSync(path.join(skillDir(), name), dest);
      written.push(dest);
    }
  }
  return written;
}

/** Sniff the stack and propose check commands (extended per-stack over time). */
export function detectChecks(projectRoot: string): ProjectConfig["checks"] {
  const checks: ProjectConfig["checks"] = [];
  if (existsSync(path.join(projectRoot, "package.json"))) {
    checks.push({ name: "tests", cmd: "npm test", dir: "." });
  }
  if (existsSync(path.join(projectRoot, "go.mod"))) {
    checks.push({ name: "go-tests", cmd: "go test ./...", dir: "." });
  }
  if (existsSync(path.join(projectRoot, "Cargo.toml"))) {
    checks.push({ name: "cargo-tests", cmd: "cargo test", dir: "." });
  }
  if (existsSync(path.join(projectRoot, "pyproject.toml"))) {
    checks.push({ name: "pytest", cmd: "pytest", dir: "." });
  }
  return checks;
}

export interface InitResult {
  created: string[];
  skipped: string[];
  configDir: string;
  stateRoot: string;
}

/**
 * Files-only init: scaffold `.founder-helpers/` in the project (committed) and
 * the state directory outside the repo. Never overwrites an existing file —
 * overlays and config are the team's memory, re-running init must be safe.
 */
export function runInit(projectRoot: string, opts: PathsOptions = {}): InitResult {
  if (!isGitRepo(projectRoot)) {
    throw new Error(
      `Not a git repository: ${projectRoot}\n` +
        `founder-helpers manages work through branches and issues, so it needs git.\n` +
        `Run "git init" (and ideally connect a GitHub remote) first.`,
    );
  }

  const created: string[] = [];
  const skipped: string[] = [];
  const configDir = projectConfigDir(projectRoot);
  const rolesDir = path.join(configDir, "roles");
  mkdirSync(rolesDir, { recursive: true });

  const writeOnce = (target: string, produce: () => void): void => {
    if (existsSync(target)) {
      skipped.push(target);
      return;
    }
    produce();
    created.push(target);
  };

  const templates = templatesDir();

  const configFile = path.join(configDir, "config.json");
  writeOnce(configFile, () => {
    const config = ProjectConfigSchema.parse({
      integrationBranch: defaultBranch(projectRoot),
      checks: detectChecks(projectRoot),
    });
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  });

  const profileFile = path.join(configDir, "profile.md");
  writeOnce(profileFile, () => {
    copyFileSync(path.join(templates, "project", "profile.md"), profileFile);
  });

  for (const role of ["pm", "dev", "reviewer"]) {
    const overlayFile = path.join(rolesDir, `${role}.md`);
    writeOnce(overlayFile, () => {
      copyFileSync(path.join(templates, "overlays", `${role}.md`), overlayFile);
    });
  }

  const ledgerFile = path.join(configDir, "permissions.json");
  writeOnce(ledgerFile, () => {
    writeFileSync(
      ledgerFile,
      `${JSON.stringify(LedgerSchema.parse({}), null, 2)}\n`,
      "utf8",
    );
  });

  // State dir (outside the repo): structure + code-owned files.
  const sp = statePaths(projectRoot, opts);
  for (const dir of [sp.root, sp.runsDir, sp.outboxDir, sp.pmDir, sp.devDir, sp.logsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(sp.transportStateFile)) {
    writeJsonAtomic(sp.transportStateFile, TransportStateSchema.parse({}), TransportStateSchema);
    created.push(sp.transportStateFile);
  } else {
    skipped.push(sp.transportStateFile);
  }
  if (!existsSync(sp.queueFile)) {
    writeJsonAtomic(sp.queueFile, QueueSchema.parse({}), QueueSchema);
    created.push(sp.queueFile);
  } else {
    skipped.push(sp.queueFile);
  }

  return { created, skipped, configDir, stateRoot: sp.root };
}

/**
 * Persist a successful pairing: the secret (token/chat) and the code-owned
 * transport offset, so the daemon's first poll starts right after the
 * founder's pairing message instead of replaying it.
 */
export function persistPairing(sp: StatePaths, pairing: PairResult): void {
  saveSecrets(sp, { telegram: { botToken: pairing.botToken, chatId: pairing.chatId } });
  writeJsonAtomic(
    sp.transportStateFile,
    { lastUpdateId: pairing.lastUpdateId },
    TransportStateSchema,
  );
}

export async function initCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      "no-telegram": { type: "boolean", default: false },
      "refresh-skill": { type: "boolean", default: false },
    },
  });
  let result: InitResult;
  try {
    result = runInit(process.cwd());
    const skillFiles = installSkill(process.cwd(), values["refresh-skill"] ?? false);
    result.created.push(...skillFiles);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const rel = (p: string): string => path.relative(process.cwd(), p) || p;
  if (result.created.length) {
    console.log("Created:");
    for (const f of result.created) console.log(`  ${rel(f)}`);
  }
  if (result.skipped.length) {
    console.log(`Kept as-is (already present): ${result.skipped.length} file(s).`);
  }
  console.log("");
  console.log(`Project config: ${rel(result.configDir)}  (commit this directory)`);
  console.log(`State & secrets: ${result.stateRoot}  (outside the repo, never committed)`);
  console.log("");
  // Telegram pairing (skippable; interactive only).
  const sp = statePaths(process.cwd());
  if (values["no-telegram"]) {
    console.log("Telegram: skipped (--no-telegram). Run fh init again to pair later.");
  } else if (existsSync(sp.secretsFile) && loadSecrets(sp).telegram) {
    console.log("Telegram: already paired.");
  } else if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("Telegram: not paired (non-interactive shell). Run fh init in a terminal to pair.");
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const pairing = await pairTelegram(
        { ask: (q) => rl.question(q), say: (l) => console.log(l) },
        { projectName: path.basename(process.cwd()) },
      );
      persistPairing(sp, pairing);
      console.log(`Telegram: paired with @${pairing.botUsername} — check your chat for the hello.`);
    } catch (err) {
      console.log(`Telegram: not paired (${err instanceof Error ? err.message : String(err)})`);
      console.log("You can pair any time by running fh init again.");
    } finally {
      rl.close();
    }
  }

  console.log("");
  console.log("Next steps:");
  console.log("  1. Fill in .founder-helpers/profile.md — the team reads it every run");
  console.log("  2. fh doctor");
  return 0;
}
