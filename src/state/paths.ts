import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface PathsOptions {
  /** Override the base directory entirely (used by tests and FH_STATE_DIR). */
  stateBase?: string | undefined;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
}

/**
 * Stable per-project identifier: a readable slug plus a hash of the real path,
 * so two checkouts with the same folder name never share state.
 */
export function projectId(projectRoot: string): string {
  let real: string;
  try {
    real = realpathSync(projectRoot);
  } catch {
    real = path.resolve(projectRoot);
  }
  // Windows filesystems are case-insensitive; normalize before hashing so the
  // id survives being launched as c:\work\X one day and C:\Work\X the next.
  const canonical = process.platform === "win32" ? real.toLowerCase() : real;
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  const slug =
    path
      .basename(real)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  return `${slug}-${hash}`;
}

/** Per-OS data directory for founder-helpers as a whole. */
export function dataBase(opts: PathsOptions = {}): string {
  if (opts.stateBase) return opts.stateBase;
  const env = opts.env ?? process.env;
  if (env["FH_STATE_DIR"]) return env["FH_STATE_DIR"];
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local");
    return path.join(local, "founder-helpers");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "founder-helpers");
  }
  const xdg = env["XDG_DATA_HOME"] ?? path.join(home, ".local", "share");
  return path.join(xdg, "founder-helpers");
}

export interface StatePaths {
  root: string;
  secretsFile: string;
  transportStateFile: string;
  queueFile: string;
  runsDir: string;
  outboxDir: string;
  pmDir: string;
  devDir: string;
  logsDir: string;
}

/** Layout of a single project's state directory (always outside the repo). */
export function statePaths(projectRoot: string, opts: PathsOptions = {}): StatePaths {
  const root = path.join(dataBase(opts), projectId(projectRoot));
  return {
    root,
    secretsFile: path.join(root, "secrets.json"),
    transportStateFile: path.join(root, "transport-state.json"),
    queueFile: path.join(root, "queue.json"),
    runsDir: path.join(root, "runs"),
    outboxDir: path.join(root, "outbox"),
    pmDir: path.join(root, "pm"),
    devDir: path.join(root, "dev"),
    logsDir: path.join(root, "logs"),
  };
}

/** Project-side (committed) config directory. */
export function projectConfigDir(projectRoot: string): string {
  return path.join(projectRoot, ".founder-helpers");
}
