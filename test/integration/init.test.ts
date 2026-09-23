import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chooseEngineAndModel, runInit, persistPairing } from "../../src/cli/init.js";
import { ENGINES } from "../../src/cli/engine.js";
import { pairTelegram } from "../../src/cli/pair.js";
import { checkEngineAuth, runChecks } from "../../src/cli/doctor.js";
import { readJson } from "../../src/state/atomic.js";
import { statePaths } from "../../src/state/paths.js";
import { ProjectConfigSchema, TransportStateSchema } from "../../src/state/schema.js";
import { startMockTelegram } from "../helpers/mock-telegram.js";

function io(answers: string[]): {
  ask: (q: string) => Promise<string>;
  say: (l: string) => void;
  said: string[];
} {
  const said: string[] = [];
  const queue = [...answers];
  return {
    said,
    say: (l) => said.push(l),
    ask: async () => queue.shift() ?? "",
  };
}

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

describe("fh init: engine + model choice", () => {
  it("defaults to claude on Enter, then lists the claude model set", async () => {
    const picker = io(["", ""]);
    const choice = await chooseEngineAndModel(picker, {
      kind: "claude",
      model: "claude-sonnet-5",
    });
    expect(choice.engine).toBe("claude");
    expect(choice.model).toBe("claude-sonnet-5");
  });

  it("switches to codex and then offers the codex model list, not claude's", async () => {
    const picker = io(["2", "1"]);
    const choice = await chooseEngineAndModel(picker, {
      kind: "claude",
      model: "claude-sonnet-5",
    });
    expect(choice.engine).toBe("codex");
    expect(choice.model).toBe("gpt-5-codex");
  });

  it("accepts a free-text model id for either engine, unlisted models included", async () => {
    const picker = io(["2", "some-future-codex-model"]);
    const choice = await chooseEngineAndModel(picker, {
      kind: "claude",
      model: "claude-sonnet-5",
    });
    expect(choice.engine).toBe("codex");
    expect(choice.model).toBe("some-future-codex-model");
  });

  it("switching engine and pressing Enter at the model prompt uses the NEW engine's default, not the stale one (#44)", async () => {
    const picker = io(["2", ""]);
    const choice = await chooseEngineAndModel(picker, {
      kind: "claude",
      model: "claude-sonnet-5",
    });
    expect(choice.engine).toBe("codex");
    expect(choice.model).toBe(ENGINES.codex.defaultModel);
    expect(choice.model).not.toBe("claude-sonnet-5");
  });

  it("mirror: switching Codex to Claude and pressing Enter uses claude's default, not a leftover gpt- model (#44)", async () => {
    const picker = io(["1", ""]);
    const choice = await chooseEngineAndModel(picker, {
      kind: "codex",
      model: "gpt-5-codex",
    });
    expect(choice.engine).toBe("claude");
    expect(choice.model).toBe(ENGINES.claude.defaultModel);
    expect(choice.model).not.toMatch(/^gpt-/);
  });

  it("engine unchanged + Enter still keeps the stored model, guard against over-fixing (#44)", async () => {
    const picker = io(["", ""]);
    const choice = await chooseEngineAndModel(picker, {
      kind: "claude",
      model: "claude-opus-4-1-special",
    });
    expect(choice.engine).toBe("claude");
    expect(choice.model).toBe("claude-opus-4-1-special");
  });
});

function setRunnerKind(repo: string, kind: "claude" | "codex"): void {
  const configFile = path.join(repo, ".founder-helpers", "config.json");
  const config = ProjectConfigSchema.parse(JSON.parse(readFileSync(configFile, "utf8")));
  config.runner.kind = kind;
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function setRunnerModel(repo: string, model: string): void {
  const configFile = path.join(repo, ".founder-helpers", "config.json");
  const config = ProjectConfigSchema.parse(JSON.parse(readFileSync(configFile, "utf8")));
  config.runner.model = model;
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

describe("fh doctor (partial)", () => {
  it("reports node and git ok on an initialized (claude, the default) repo", () => {
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
    // a claude-configured project must show no codex check at all
    expect(byName["codex CLI"]).toBeUndefined();
    expect(byName["codex auth"]).toBeUndefined();
  });

  it("falls back to claude when config.json is missing (the pre-init case)", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "fh-nocfg-"));
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], { stdio: "ignore" });
    const checks = runChecks(repo, { stateBase: mkdtempSync(path.join(tmpdir(), "fh-sb-")) });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName["claude CLI"]).toBeDefined();
    expect(byName["codex CLI"]).toBeUndefined();
  });

  it("switches to the codex CLI/auth checks, and drops the claude ones, when runner.kind is codex", () => {
    const { repo, stateBase } = makeRepo();
    runInit(repo, { stateBase });
    setRunnerKind(repo, "codex");
    const checks = runChecks(repo, { stateBase });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName["codex CLI"]).toBeDefined();
    expect(byName["codex auth"]).toBeDefined();
    expect(byName["claude CLI"]).toBeUndefined();
    expect(byName["claude auth"]).toBeUndefined();
  });

  it("claude auth: warns (never fails) when no credentials file was ever written (#21)", () => {
    const home = mkdtempSync(path.join(tmpdir(), "fh-nocreds-"));
    const check = checkEngineAuth("claude", { home });
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("login");
  });

  it("claude auth: ok when the credentials file was touched recently (#21)", () => {
    const home = mkdtempSync(path.join(tmpdir(), "fh-freshcreds-"));
    const claudeDir = path.join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(path.join(claudeDir, ".credentials.json"), "{}", "utf8");
    expect(checkEngineAuth("claude", { home }).level).toBe("ok");
  });

  it("claude auth: warns when the credentials file has gone stale (#21)", () => {
    const home = mkdtempSync(path.join(tmpdir(), "fh-stalecreds-"));
    const claudeDir = path.join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const file = path.join(claudeDir, ".credentials.json");
    writeFileSync(file, "{}", "utf8");
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days
    utimesSync(file, longAgo, longAgo);
    const check = checkEngineAuth("claude", { home });
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("login");
  });

  it("codex auth: warns (never fails) when no credentials file was ever written", () => {
    const home = mkdtempSync(path.join(tmpdir(), "fh-nocodexcreds-"));
    const check = checkEngineAuth("codex", { home });
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("codex login");
  });

  it("codex auth: ok when the credentials file was touched recently", () => {
    const home = mkdtempSync(path.join(tmpdir(), "fh-freshcodexcreds-"));
    const codexDir = path.join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(path.join(codexDir, "auth.json"), "{}", "utf8");
    expect(checkEngineAuth("codex", { home }).level).toBe("ok");
  });

  it("codex auth: warns when the credentials file has gone stale", () => {
    const home = mkdtempSync(path.join(tmpdir(), "fh-stalecodexcreds-"));
    const codexDir = path.join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const file = path.join(codexDir, "auth.json");
    writeFileSync(file, "{}", "utf8");
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days
    utimesSync(file, longAgo, longAgo);
    const check = checkEngineAuth("codex", { home });
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("codex login");
  });

  it("runner.model: warns when runner.kind is codex but the model is still the claude default (#44 stale-model-after-switch)", () => {
    const { repo, stateBase } = makeRepo();
    runInit(repo, { stateBase });
    setRunnerKind(repo, "codex"); // model stays "claude-sonnet-5", the fresh-init default
    const checks = runChecks(repo, { stateBase });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName["runner.model"]?.level).toBe("warn");
    expect(byName["runner.model"]?.detail).toContain("Claude Code");
  });

  it("mirror: warns when runner.kind is claude but the model is a codex id", () => {
    const { repo, stateBase } = makeRepo();
    runInit(repo, { stateBase });
    setRunnerModel(repo, "gpt-5-codex"); // runner.kind stays "claude", the fresh-init default
    const checks = runChecks(repo, { stateBase });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName["runner.model"]?.level).toBe("warn");
    expect(byName["runner.model"]?.detail).toContain("Codex");
  });

  it("runner.model: silent when engine and model actually match", () => {
    const { repo, stateBase } = makeRepo();
    runInit(repo, { stateBase }); // fresh config: claude + claude-sonnet-5
    const checks = runChecks(repo, { stateBase });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName["runner.model"]).toBeUndefined();
  });

  it("runner.model: silent for an unrecognized free-text id — it must stay legal", () => {
    const { repo, stateBase } = makeRepo();
    runInit(repo, { stateBase });
    setRunnerKind(repo, "codex");
    setRunnerModel(repo, "my-self-hosted-model");
    const checks = runChecks(repo, { stateBase });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName["runner.model"]).toBeUndefined();
  });
});
