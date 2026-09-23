import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  branchExistsOnOrigin,
  defaultBranch,
  hasOriginRemote,
  isGitRepo,
  isTreeClean,
} from "../../src/util/git.js";

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

  it("hasOriginRemote: false with no remote, true once one is added", () => {
    const repo = makeRepo();
    expect(hasOriginRemote(repo)).toBe(false);
    const bare = mkdtempSync(path.join(tmpdir(), "fh-origin-"));
    execFileSync("git", ["init", "--bare", "-q", bare], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "remote", "add", "origin", bare], { stdio: "ignore" });
    expect(hasOriginRemote(repo)).toBe(true);
  });

  it("branchExistsOnOrigin: false until the branch is actually pushed", () => {
    const repo = makeRepo();
    const bare = mkdtempSync(path.join(tmpdir(), "fh-origin-"));
    execFileSync("git", ["init", "--bare", "-q", bare], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "remote", "add", "origin", bare], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" });
    expect(branchExistsOnOrigin(repo, "main")).toBe(false);
    execFileSync("git", ["-C", repo, "push", "origin", "main"], { stdio: "ignore" });
    expect(branchExistsOnOrigin(repo, "main")).toBe(true);
  });
});
