import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit, persistPairing } from "../../src/cli/init.js";
import { pairTelegram } from "../../src/cli/pair.js";
import { checkClaudeAuth, runChecks } from "../../src/cli/doctor.js";
import { readJson } from "../../src/state/atomic.js";
import { statePaths } from "../../src/state/paths.js";
import { ProjectConfigSchema, TransportStateSchema } from "../../src/state/schema.js";
import { startMockTelegram } from "../helpers/mock-telegram.js";

function makeRepo(): { repo: string; stateBase: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "fh-init-"));
  const stateBase = mkdtempSync(path.join(tmpdir(), "fh-state-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], { stdio: "ignore" });
  writeFileSync(path.join(repo, "package.json"), '{"name":"x","version":"0.0.0"}\n', "utf8");
  return { repo, stateBase };
}

describe("fh init (files only)", () => {
  it("refuses to run outside a git repository", () => {
    const plain = mkdtempSync(path.join(tmpdir(), "fh-nogit-"));
    expect(() => runInit(plain, { stateBase: mkdtempSync(path.join(tmpdir(), "fh-sb-")) })).toThrow(
      /Not a git repository/,
    );
  });

  it("scaffolds the committed set and the state dir", () => {
    const { repo, stateBase } = makeRepo();
    const res = runInit(repo, { stateBase });

    const cfgDir = path.join(repo, ".founder-helpers");
    for (const f of [
      "config.json",
      "profile.md",
      "permissions.json",
      path.join("roles", "pm.md"),
      path.join("roles", "dev.md"),
      path.join("roles", "reviewer.md"),
    ]) {
      expect(existsSync(path.join(cfgDir, f)), f).toBe(true);
    }

    const config = ProjectConfigSchema.parse(
      JSON.parse(readFileSync(path.join(cfgDir, "config.json"), "utf8")),
    );
    expect(config.integrationBranch).toBe("main");
    // package.json fixture -> stack sniff proposes npm test
    expect(config.checks.some((c) => c.cmd === "npm test")).toBe(true);

    expect(existsSync(path.join(res.stateRoot, "queue.json"))).toBe(true);
    expect(existsSync(path.join(res.stateRoot, "transport-state.json"))).toBe(true);
    expect(existsSync(path.join(res.stateRoot, "logs"))).toBe(true);
  });

  it("persists the pairing offset into transport-state.json (no replay on first daemon start)", async () => {
    const { repo, stateBase } = makeRepo();
    runInit(repo, { stateBase });
    const sp = statePaths(repo, { stateBase });

    const server = await startMockTelegram();
    try {
      const hiId = server.pushUpdate("hi", 4242);
      const pairing = await pairTelegram(
        { ask: async () => "TOKEN", say: () => {} },
        { apiBase: server.url, projectName: "demo", maxWaitMs: 5000 },
      );
      persistPairing(sp, pairing);
      expect(readJson(sp.transportStateFile, TransportStateSchema).lastUpdateId).toBe(hiId);
    } finally {
      await server.close();
    }
  });

  it("is idempotent and never overwrites what the team wrote", () => {
    const { repo, stateBase } = makeRepo();
    runInit(repo, { stateBase });

    const overlay = path.join(repo, ".founder-helpers", "roles", "dev.md");
    writeFileSync(overlay, "# my hard-won lessons\n", "utf8");

    const second = runInit(repo, { stateBase });
    expect(readFileSync(overlay, "utf8")).toBe("# my hard-won lessons\n");
    expect(second.created).toEqual([]);
    expect(second.skipped.length).toBeGreaterThan(0);
  });
});

describe("fh doctor (partial)", () => {
  it("reports node and git ok on an initialized repo", () => {
    const { repo, stateBase } = makeRepo();
    runInit(repo, { stateBase });
    const checks = runChecks(repo, { stateBase });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName["node"]?.level).toBe("ok");
    expect(byName["git repo"]?.level).toBe("ok");
    expect(byName["config"]?.level).toBe("ok");
    expect(byName["permissions ledger"]?.level).toBe("ok");
    expect(byName["state dir"]?.level).toBe("ok");
    // claude/gh may or may not exist on CI machines — only assert presence
    expect(byName["claude CLI"]).toBeDefined();
    expect(byName["gh CLI"]).toBeDefined();
  });

  it("claude auth: warns (never fails) when no credentials file was ever written (#21)", () => {
    const home = mkdtempSync(path.join(tmpdir(), "fh-nocreds-"));
    const check = checkClaudeAuth({ home });
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("/login");
  });

  it("claude auth: ok when the credentials file was touched recently (#21)", () => {
    const home = mkdtempSync(path.join(tmpdir(), "fh-freshcreds-"));
    const claudeDir = path.join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(path.join(claudeDir, ".credentials.json"), "{}", "utf8");
    expect(checkClaudeAuth({ home }).level).toBe("ok");
  });

  it("claude auth: warns when the credentials file has gone stale (#21)", () => {
    const home = mkdtempSync(path.join(tmpdir(), "fh-stalecreds-"));
    const claudeDir = path.join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const file = path.join(claudeDir, ".credentials.json");
    writeFileSync(file, "{}", "utf8");
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days
    utimesSync(file, longAgo, longAgo);
    const check = checkClaudeAuth({ home });
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("/login");
  });
});
