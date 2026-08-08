import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultBranch, isGitRepo, isTreeClean } from "../../src/util/git.js";

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fh-git-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.test"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.name", "t"], { stdio: "ignore" });
  return dir;
}

describe("git helpers", () => {
  it("detects a repo vs a plain directory", () => {
    const repo = makeRepo();
    const plain = mkdtempSync(path.join(tmpdir(), "fh-plain-"));
    expect(isGitRepo(repo)).toBe(true);
    expect(isGitRepo(plain)).toBe(false);
  });

  it("falls back to the current branch when there is no remote", () => {
    const repo = makeRepo();
    expect(defaultBranch(repo)).toBe("main");
  });

  it("clean-tree gate ignores untracked files but sees modified tracked ones", () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, "a.txt"), "one\n", "utf8");
    expect(isTreeClean(repo)).toBe(true); // untracked only
    execFileSync("git", ["-C", repo, "add", "a.txt"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-m", "add a"], { stdio: "ignore" });
    expect(isTreeClean(repo)).toBe(true);
    writeFileSync(path.join(repo, "a.txt"), "two\n", "utf8");
    expect(isTreeClean(repo)).toBe(false);
  });
});
