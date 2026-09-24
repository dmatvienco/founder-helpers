import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { extractChangelogSection } from "../../scripts/changelog-section.mjs";

const realChangelog = readFileSync(
  fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url)),
  "utf8",
);

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("../../scripts/changelog-section.mjs", import.meta.url));

const CHANGELOG = [
  "# Changelog",
  "",
  "## 0.3.0",
  "",
  "- third entry",
  "",
  "## 0.2.0",
  "",
  "- middle entry, line one",
  "- middle entry, line two",
  "",
  "## 0.1.0",
  "",
  "- first entry",
  "",
].join("\n");

describe("extractChangelogSection", () => {
  it("extracts a middle section, stopping at the next heading", () => {
    expect(extractChangelogSection(CHANGELOG, "0.2.0")).toBe(
      "- middle entry, line one\n- middle entry, line two",
    );
  });

  it("extracts the first section", () => {
    expect(extractChangelogSection(CHANGELOG, "0.3.0")).toBe("- third entry");
  });

  it("extracts the last section, running to end of file", () => {
    expect(extractChangelogSection(CHANGELOG, "0.1.0")).toBe("- first entry");
  });

  it("returns null for a version with no section", () => {
    expect(extractChangelogSection(CHANGELOG, "9.9.9")).toBeNull();
  });

  it("trims leading and trailing blank lines from the section", () => {
    const changelog = ["## 1.0.0", "", "", "- padded entry", "", "", "## 0.9.0", ""].join("\n");
    expect(extractChangelogSection(changelog, "1.0.0")).toBe("- padded entry");
  });

  it("does not match a version that is only a substring of a heading", () => {
    const changelog = ["## 1.0.0", "", "- entry", ""].join("\n");
    expect(extractChangelogSection(changelog, "1.0")).toBeNull();
  });

  // Runs against the repo's real CHANGELOG.md, not a fixture, so a shape the
  // fixture doesn't cover (e.g. a mid-file "## " that isn't a version) fails
  // here first. Logged so `npm test` output doubles as the manual spot-check
  // the release workflow's own verification asked for (#52).
  it("extracts real sections from the repo's own CHANGELOG.md", () => {
    for (const version of ["0.13.1", "0.13.0", "0.1.0"]) {
      const section = extractChangelogSection(realChangelog, version);
      console.log(`-- ## ${version} --\n${section}\n`);
      expect(section).not.toBeNull();
      expect(section?.length).toBeGreaterThan(0);
    }
    expect(extractChangelogSection(realChangelog, "0.999.0")).toBeNull();
  });
});

// The script resolves CHANGELOG.md relative to its own location, so a copy
// inside a temp "repo" exercises the real entry point (exit code + stdout)
// without touching the real file.
describe("changelog-section script", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fakeRepo(changelog: string): string {
    const root = mkdtempSync(path.join(tmpdir(), "fh-changelog-"));
    dirs.push(root);
    mkdirSync(path.join(root, "scripts"));
    copyFileSync(script, path.join(root, "scripts", "changelog-section.mjs"));
    writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
    return path.join(root, "scripts", "changelog-section.mjs");
  }

  it("prints the section and exits 0 when it exists", async () => {
    const copy = fakeRepo(CHANGELOG);
    const { stdout } = await execFileAsync(process.execPath, [copy, "0.2.0"]);
    expect(stdout.trim()).toBe("- middle entry, line one\n- middle entry, line two");
  });

  it("prints nothing to stdout and exits non-zero when the version has no section", async () => {
    const copy = fakeRepo(CHANGELOG);
    const err = await execFileAsync(process.execPath, [copy, "9.9.9"]).then(
      () => null,
      (e: { code?: number; stdout?: string; stderr?: string }) => e,
    );
    expect(err).not.toBeNull();
    expect(err?.code).toBe(1);
    expect(err?.stdout).toBe("");
    expect(err?.stderr).toContain('no "## 9.9.9" section');
  });

  it("exits non-zero with a usage message when no version argument is given", async () => {
    const copy = fakeRepo(CHANGELOG);
    const err = await execFileAsync(process.execPath, [copy]).then(
      () => null,
      (e: { code?: number; stderr?: string }) => e,
    );
    expect(err).not.toBeNull();
    expect(err?.code).toBe(1);
    expect(err?.stderr).toContain("usage:");
  });
});
