import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Ledger, ProjectConfig } from "../state/schema.js";

export function hasActiveGrant(ledger: Ledger, scope: string): boolean {
  return ledger.grants.some((g) => g.scope === scope && g.granted && !g.revoked);
}

/**
 * Claude Code settings for headless runs — the "modest by default" layer.
 * Allow the tools a team needs to build and test; deny pushing to the
 * integration branch until the founder records a standing grant. Force-push
 * stays denied always. In `-p` mode a denied command fails SOFT: the model
 * gets the error, and the role templates require it to report the exact grant
 * recipe instead of faking success.
 */
export function generateClaudeSettings(config: ProjectConfig, ledger: Ledger): object {
  const allow = new Set<string>([
    "Bash(git:*)",
    "Bash(gh:*)",
    "Bash(fh:*)",
    "Bash(founder-helpers:*)",
  ]);
  for (const check of config.checks) {
    const head = check.cmd.trim().split(/\s+/)[0];
    if (head) allow.add(`Bash(${head}:*)`);
  }

  const deny: string[] = ["Bash(git push --force:*)", "Bash(git push -f:*)"];
  const mergeAllowed =
    hasActiveGrant(ledger, "git.merge_integration_branch") ||
    hasActiveGrant(ledger, "git.push_integration_branch");
  if (!mergeAllowed) {
    deny.push(`Bash(git push origin ${config.integrationBranch}:*)`);
    deny.push(`Bash(git push -u origin ${config.integrationBranch}:*)`);
  }

  return {
    permissions: {
      allow: [...allow].sort(),
      deny,
    },
  };
}

/**
 * Write (regenerate) claude-settings.json into the state dir; returns its
 * path. Lives outside the repo — it's a generated artifact of config +
 * ledger, never something to commit or hand-edit.
 */
export function writeClaudeSettings(
  stateRoot: string,
  config: ProjectConfig,
  ledger: Ledger,
): string {
  const file = path.join(stateRoot, "claude-settings.json");
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(file, `${JSON.stringify(generateClaudeSettings(config, ledger), null, 2)}\n`, "utf8");
  return file;
}
