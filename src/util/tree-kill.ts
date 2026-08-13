import { execFile } from "node:child_process";

/**
 * Kill a process AND everything it spawned.
 *
 * The claude CLI spawns children (shells, node, gradle...); killing only the
 * root pid leaves orphans burning CPU — the predecessor once left a Metro
 * bundler eating ~60% CPU for six hours.
 *
 * - win32: `taskkill /T /F` walks the tree for us.
 * - POSIX: the child must have been spawned with `detached: true` so it leads
 *   its own process group; killing `-pid` then takes the whole group.
 */
export async function treeKill(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/T", "/F", "/PID", String(pid)], () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** true when a process with this pid is still alive (signal 0 probe). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means "alive but not ours" — that still counts as alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Age (in whole seconds) and liveness of a heartbeat, using the "alive AND
 * reported within `freshSec` seconds" rule that daemon liveness detection
 * needs everywhere it's checked — kept in one place so callers can't drift
 * apart on the staleness threshold.
 */
export function heartbeatStatus(
  hb: { pid: number; at: string },
  freshSec = 90,
): { ageSec: number; fresh: boolean } {
  const ageSec = Math.round((Date.now() - new Date(hb.at).getTime()) / 1000);
  return { ageSec, fresh: isAlive(hb.pid) && ageSec < freshSec };
}
