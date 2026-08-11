import { execFileSync } from "node:child_process";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function isGitRepo(dir: string): boolean {
  try {
    return git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

/**
 * Best guess at the integration branch: origin/HEAD when a remote exists,
 * otherwise the currently checked-out branch, otherwise "main".
 */
export function defaultBranch(dir: string): string {
  try {
    const ref = git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    const name = ref.replace(/^refs\/remotes\/origin\//, "");
    if (name) return name;
  } catch {
    // no remote or unset origin/HEAD
  }
  try {
    const current = git(dir, ["branch", "--show-current"]);
    if (current) return current;
  } catch {
    // detached head or brand-new repo
  }
  return "main";
}

/**
 * The safety interlock the whole shared-working-copy design rests on:
 * tracked files only — untracked scratch files must not block the team.
 */
export function isTreeClean(dir: string): boolean {
  try {
    return git(dir, ["status", "--porcelain", "--untracked-files=no"]) === "";
  } catch {
    return false;
  }
}

/** Current HEAD commit hash, or null if `dir` isn't a readable git repo. */
export function headCommit(dir: string): string | null {
  try {
    return git(dir, ["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}

/**
 * How many commits `dir`'s current HEAD is ahead of `oldCommit`. Null if
 * `oldCommit` isn't a reachable ancestor (rebase/force-push rewrote history,
 * or `dir` isn't a git repo) rather than throwing.
 */
export function commitsBehindHead(dir: string, oldCommit: string): number | null {
  try {
    const count = git(dir, ["rev-list", "--count", `${oldCommit}..HEAD`]);
    return parseInt(count, 10);
  } catch {
    return null;
  }
}
