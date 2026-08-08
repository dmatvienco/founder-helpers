import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installSkill, runInit } from "../../src/cli/init.js";
import { readLedger, recordGrant, revokeGrant } from "../../src/permissions/ledger.js";

function makeProject(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "fh-grant-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], { stdio: "ignore" });
  runInit(repo, { stateBase: mkdtempSync(path.join(tmpdir(), "fh-gstate-")) });
  return repo;
}

function settingsOf(repo: string): { permissions: { allow: string[]; deny: string[] } } {
  return JSON.parse(
    readFileSync(path.join(repo, ".founder-helpers", "claude-settings.json"), "utf8"),
  );
}

describe("grant ledger", () => {
  it("recording a merge grant lifts the integration-branch deny and keeps the audit trail", () => {
    const repo = makeProject();
    const grant = recordGrant(repo, {
      scope: "git.merge_integration_branch",
      quote: "мержи сам, если ревью зелёное — не спрашивай каждый раз",
      conditions: "tests green AND verdict ✅ only",
    });

    const ledger = readLedger(repo);
    expect(ledger.grants).toHaveLength(1);
    expect(ledger.grants[0]?.quote).toContain("мержи сам");
    expect(grant.id).toMatch(/^g-\d{4}-\d{2}-\d{2}-git-merge/);

    const s = settingsOf(repo);
    expect(s.permissions.deny.some((d) => d.includes("git push origin main"))).toBe(false);
    expect(s.permissions.deny).toContain("Bash(git push --force:*)");
  });

  it("revoking restores the deny", () => {
    const repo = makeProject();
    const grant = recordGrant(repo, {
      scope: "git.merge_integration_branch",
      quote: "go ahead",
    });
    expect(settingsOf(repo).permissions.deny.some((d) => d.includes("git push origin main"))).toBe(
      false,
    );
    revokeGrant(repo, grant.id);
    expect(settingsOf(repo).permissions.deny.some((d) => d.includes("git push origin main"))).toBe(
      true,
    );
    expect(readLedger(repo).grants[0]?.revoked).toBeTruthy();
  });

  it("a freeform scope is recorded but does not touch the settings layer", () => {
    const repo = makeProject();
    recordGrant(repo, { scope: "growth.publish_reddit_drafts", quote: "drafts are fine" });
    expect(settingsOf(repo).permissions.deny.some((d) => d.includes("git push origin main"))).toBe(
      true,
    );
    expect(readLedger(repo).grants).toHaveLength(1);
  });

  it("revoking an unknown or already-revoked grant fails loudly", () => {
    const repo = makeProject();
    expect(() => revokeGrant(repo, "g-nope")).toThrow(/No grant/);
    const g = recordGrant(repo, { scope: "spend.money", quote: "ads up to $50" });
    revokeGrant(repo, g.id);
    expect(() => revokeGrant(repo, g.id)).toThrow(/already revoked/);
  });
});

describe("skill install", () => {
  it("copies the skill into .claude/skills and refresh overwrites", () => {
    const repo = makeProject();
    const written = installSkill(repo, false);
    expect(written.length).toBe(2);
    const skillFile = path.join(repo, ".claude", "skills", "founder-helpers", "SKILL.md");
    expect(readFileSync(skillFile, "utf8")).toContain("name: founder-helpers");
    // second non-forced install is a no-op; forced rewrites
    expect(installSkill(repo, false)).toEqual([]);
    expect(installSkill(repo, true).length).toBe(2);
  });
});
