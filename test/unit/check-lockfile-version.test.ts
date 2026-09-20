import { execFile } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { findVersionDrift } from "../../scripts/check-lockfile-version.mjs";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("../../scripts/check-lockfile-version.mjs", import.meta.url));

const lockAt = (top: string, root: string) => ({
  name: "founder-helpers",
  version: top,
  packages: { "": { name: "founder-helpers", version: root } },
});

describe("findVersionDrift", () => {
  it("reports nothing when both lockfile places match package.json", () => {
    expect(findVersionDrift({ version: "0.10.0" }, lockAt("0.10.0", "0.10.0"))).toEqual([]);
  });

  it("flags the top-level version alone", () => {
    const problems = findVersionDrift({ version: "0.10.0" }, lockAt("0.6.0", "0.10.0"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('package-lock.json version is "0.6.0"');
    expect(problems[0]).toContain('"0.10.0"');
  });

  it('flags packages[""].version alone', () => {
    const problems = findVersionDrift({ version: "0.10.0" }, lockAt("0.10.0", "0.6.0"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('packages[""].version is "0.6.0"');
  });

  it("flags both places when the lockfile is behind, as it was in #38", () => {
    expect(findVersionDrift({ version: "0.10.0" }, lockAt("0.6.0", "0.6.0"))).toHaveLength(2);
  });

  it("says `missing` rather than crashing when the lockfile lacks the fields", () => {
    const problems = findVersionDrift({ version: "0.10.0" }, { lockfileVersion: 3 });
    expect(problems).toHaveLength(2);
    expect(problems.every((p) => p.includes("is missing"))).toBe(true);
  });

  it("refuses to pass when package.json has no version to compare against", () => {
    expect(findVersionDrift({}, lockAt("0.10.0", "0.10.0"))).toEqual([
      "package.json has no string `version` field",
    ]);
  });
});

// The script resolves package.json / package-lock.json relative to its own
// location, so a copy inside a temp "repo" exercises the real entry point
// (exit code + message) against fixtures without touching the real files.
describe("check-lockfile-version script", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // realpath the temp root: on macOS tmpdir() is /var/folders/..., and /var is a
  // symlink to /private/var. Node puts the realpath into import.meta.url for the
  // entry module, so a symlinked root is only ever exercised on purpose (the
  // symlink test below), never by accident.
  const tempRoot = () => realpathSync(tmpdir());

  function fakeRepo(pkgVersion: string, lock: unknown): string {
    const root = mkdtempSync(path.join(tempRoot(), "fh-lockcheck-"));
    dirs.push(root);
    mkdirSync(path.join(root, "scripts"));
    copyFileSync(script, path.join(root, "scripts", "check-lockfile-version.mjs"));
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: pkgVersion }));
    writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
    return path.join(root, "scripts", "check-lockfile-version.mjs");
  }

  it("passes on the repo's own package.json / package-lock.json", async () => {
    const { stdout } = await execFileAsync(process.execPath, [script]);
    expect(stdout).toContain("matches package.json");
  });

  it("exits 0 when the fixture lockfile matches", async () => {
    const copy = fakeRepo("1.2.3", lockAt("1.2.3", "1.2.3"));
    const { stdout } = await execFileAsync(process.execPath, [copy]);
    expect(stdout).toContain("matches package.json");
  });

  it("exits non-zero on a mismatch and says how to fix it", async () => {
    const copy = fakeRepo("1.2.3", lockAt("1.2.2", "1.2.3"));
    const err = await execFileAsync(process.execPath, [copy]).then(
      () => null,
      (e: { code?: number; stderr?: string }) => e,
    );
    expect(err).not.toBeNull();
    expect(err?.code).toBe(1);
    expect(err?.stderr).toContain('package-lock.json version is "1.2.2"');
    expect(err?.stderr).toContain("npm install --package-lock-only");
  });

  // A silent exit 0 on drift would defeat the CI guard, so the mismatch case is
  // the one worth running through a link. "junction" is ignored off Windows and
  // needs no privilege on it, unlike a "dir" symlink.
  it("still catches a mismatch when launched through a symlinked directory", async () => {
    const copy = fakeRepo("1.2.3", lockAt("1.2.2", "1.2.3"));
    const linkHome = mkdtempSync(path.join(tempRoot(), "fh-lockcheck-link-"));
    dirs.push(linkHome);
    const link = path.join(linkHome, "repo");
    symlinkSync(path.dirname(path.dirname(copy)), link, "junction");
    expect(realpathSync(link)).not.toBe(link);

    const err = await execFileAsync(process.execPath, [
      path.join(link, "scripts", path.basename(copy)),
    ]).then(
      () => null,
      (e: { code?: number; stderr?: string }) => e,
    );
    expect(err).not.toBeNull();
    expect(err?.code).toBe(1);
    expect(err?.stderr).toContain('package-lock.json version is "1.2.2"');
  });
});
