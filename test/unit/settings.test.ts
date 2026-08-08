import { describe, expect, it } from "vitest";
import { generateClaudeSettings, hasActiveGrant } from "../../src/permissions/settings.js";
import { LedgerSchema, ProjectConfigSchema } from "../../src/state/schema.js";

const config = ProjectConfigSchema.parse({
  integrationBranch: "main",
  checks: [
    { name: "tests", cmd: "npm test" },
    { name: "go", cmd: "go test ./..." },
  ],
});

interface Perms {
  permissions: { allow: string[]; deny: string[] };
}

describe("generateClaudeSettings", () => {
  it("denies pushing to the integration branch by default (modest PM)", () => {
    const s = generateClaudeSettings(config, LedgerSchema.parse({})) as Perms;
    expect(s.permissions.deny).toContain("Bash(git push origin main:*)");
    expect(s.permissions.deny).toContain("Bash(git push --force:*)");
    expect(s.permissions.allow).toContain("Bash(git:*)");
    expect(s.permissions.allow).toContain("Bash(npm:*)");
    expect(s.permissions.allow).toContain("Bash(go:*)");
  });

  it("lifts the integration-branch deny when a merge grant is recorded — force-push stays denied", () => {
    const ledger = LedgerSchema.parse({
      grants: [
        {
          id: "g-1",
          scope: "git.merge_integration_branch",
          date: "2026-08-08T00:00:00Z",
          quote: "merge on green review, don't ask every time",
        },
      ],
    });
    expect(hasActiveGrant(ledger, "git.merge_integration_branch")).toBe(true);
    const s = generateClaudeSettings(config, ledger) as Perms;
    expect(s.permissions.deny.some((d) => d.includes("git push origin main"))).toBe(false);
    expect(s.permissions.deny).toContain("Bash(git push --force:*)");
  });

  it("a revoked grant does not lift the deny", () => {
    const ledger = LedgerSchema.parse({
      grants: [
        {
          id: "g-1",
          scope: "git.merge_integration_branch",
          date: "2026-08-08T00:00:00Z",
          quote: "merge freely",
          revoked: "2026-08-09T00:00:00Z",
        },
      ],
    });
    const s = generateClaudeSettings(config, ledger) as Perms;
    expect(s.permissions.deny.some((d) => d.includes("git push origin main"))).toBe(true);
  });
});
