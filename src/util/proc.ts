import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface SpawnTrackedOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Where stdout+stderr should stream (an opened WriteStream or "pipe"). */
  stdio?: SpawnOptions["stdio"];
}

/**
 * Spawn a child so that treeKill() can reliably take it down later:
 * on POSIX it becomes its own process-group leader (detached), on Windows
 * taskkill /T handles the tree regardless. UTF-8 in, UTF-8 out.
 */
export function spawnTracked(
  cmd: string,
  args: string[],
  opts: SpawnTrackedOptions = {},
): ChildProcess {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...opts.env,
  };
  // Nudge every child toward UTF-8; harmless where already the default.
  env["LANG"] ??= "C.UTF-8";
  env["LC_ALL"] ??= env["LANG"];

  return spawn(cmd, args, {
    cwd: opts.cwd,
    env,
    detached: process.platform !== "win32",
    // Windows: never open a console window; PATHEXT resolution for .cmd shims.
    windowsHide: true,
    shell: false,
    stdio: opts.stdio ?? "pipe",
  });
}

/** Resolve a command's existence without running it (which/where). */
export function commandExists(cmd: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(probe, [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
