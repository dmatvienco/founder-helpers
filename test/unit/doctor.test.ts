import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { doctorCommand, runDeepCheck } from "../../src/cli/doctor.js";
import { CodexRunner } from "../../src/runner/codex-runner.js";
import { MockRunner, type MockScenario } from "../../src/runner/mock-runner.js";
import { statePaths } from "../../src/state/paths.js";

const fixturesBin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "bin",
);

const SENTINEL_NAME = "doctor-selftest-sentinel.txt";
const SENTINEL_TOKEN = "founder-helpers-selftest-ok";

function makeProject(): { repo: string; stateBase: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "fh-doctor-"));
  const stateBase = mkdtempSync(path.join(tmpdir(), "fh-doctor-state-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], { stdio: "ignore" });
  runInit(repo, { stateBase });
  return { repo, stateBase };
}

function setEngineKind(repo: string, kind: "claude" | "codex" | "mock"): void {
  const configFile = path.join(repo, ".founder-helpers", "config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.runner.kind = kind;
  writeFileSync(configFile, JSON.stringify(config, null, 2), "utf8");
}

function greenScenario(sentinelPath: string): MockScenario {
  return {
    role: "selftest",
    writeFiles: [{ path: sentinelPath, content: SENTINEL_TOKEN }],
    stdout: `SELFTEST_TOKEN:${SENTINEL_TOKEN}\n`,
  };
}

describe("runDeepCheck", () => {
  it("passes when the sentinel file and token both show up (all green)", async () => {
    const { repo, stateBase } = makeProject();
    const sp = statePaths(repo, { stateBase });
    const sentinelPath = path.join(sp.root, SENTINEL_NAME);
    const runner = new MockRunner([greenScenario(sentinelPath)], repo);

    const result = await runDeepCheck(repo, { stateBase, runner });

    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toContain("ok");
  });

  it("deletes the sentinel file after a passing run", async () => {
    const { repo, stateBase } = makeProject();
    const sp = statePaths(repo, { stateBase });
    const sentinelPath = path.join(sp.root, SENTINEL_NAME);
    const runner = new MockRunner([greenScenario(sentinelPath)], repo);

    await runDeepCheck(repo, { stateBase, runner });

    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("clears a stale sentinel left by a crashed prior run before spawning, so it can't fake a pass", async () => {
    const { repo, stateBase } = makeProject();
    const sp = statePaths(repo, { stateBase });
    const sentinelPath = path.join(sp.root, SENTINEL_NAME);
    // A leftover from an earlier crashed run — this run's engine never writes it.
    writeFileSync(sentinelPath, SENTINEL_TOKEN, "utf8");
    const runner = new MockRunner(
      [{ role: "selftest", stdout: `SELFTEST_TOKEN:${SENTINEL_TOKEN}\n` }],
      repo,
    );

    const result = await runDeepCheck(repo, { stateBase, runner });

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("sentinel file is missing");
  });

  it("fails when status ok but the sentinel file was never written (#45 class of bug)", async () => {
    const { repo, stateBase } = makeProject();
    const runner = new MockRunner(
      [{ role: "selftest", stdout: `SELFTEST_TOKEN:${SENTINEL_TOKEN}\n` }],
      repo,
    );

    const result = await runDeepCheck(repo, { stateBase, runner });

    expect(result.ok).toBe(false);
    const text = result.lines.join("\n");
    expect(text).toContain("sentinel file is missing");
    expect(text).toContain("writable-roots");
  });

  it("fails when status ok, sentinel present, but the token never showed up in the output", async () => {
    const { repo, stateBase } = makeProject();
    const sp = statePaths(repo, { stateBase });
    const sentinelPath = path.join(sp.root, SENTINEL_NAME);
    const runner = new MockRunner(
      [
        {
          role: "selftest",
          writeFiles: [{ path: sentinelPath, content: SENTINEL_TOKEN }],
          stdout: "no token here\n",
        },
      ],
      repo,
    );

    const result = await runDeepCheck(repo, { stateBase, runner });

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("token was not found");
  });

  it("maps an auth failure to the engine's login command", async () => {
    const { repo, stateBase } = makeProject();
    const runner = new MockRunner([{ role: "selftest", authFailed: true }], repo);

    const result = await runDeepCheck(repo, { stateBase, runner });

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("claude /login");
  });

  it("maps a timeout to a message naming the timeout budget", async () => {
    const { repo, stateBase } = makeProject();
    const runner = new MockRunner([{ role: "selftest", hang: true }], repo);

    const result = await runDeepCheck(repo, { stateBase, timeoutMsOverride: 200, runner });

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("never finished within");
  });

  it("prints argv, status, exit code and a log tail on a generic error", async () => {
    const { repo, stateBase } = makeProject();
    const runner = new MockRunner([{ role: "selftest", exitCode: 1, stdout: "boom\n" }], repo);

    const result = await runDeepCheck(repo, { stateBase, runner });

    expect(result.ok).toBe(false);
    const text = result.lines.join("\n");
    expect(text).toContain("argv:");
    expect(text).toContain("status: error");
    expect(text).toContain("exit code: 1");
    expect(text).toContain("boom");
  });

  it("names an argument-rejection failure via the real argv CodexRunner spawned", async () => {
    const { repo, stateBase } = makeProject();
    setEngineKind(repo, "codex");

    const result = await runDeepCheck(repo, {
      stateBase,
      runner: new CodexRunner(),
      bin: process.execPath,
      binArgs: [path.join(fixturesBin, "codex-unknown-arg.cjs")],
    });

    expect(result.ok).toBe(false);
    const text = result.lines.join("\n");
    expect(text).toContain("argv:");
    expect(text).toContain("--sandbox"); // the real argv CodexRunner built, not a hand-rolled guess
    expect(text).toContain("the engine rejected an argument");
    expect(text).toContain("buildCodexArgs");
  });

  it('writes a run record under role "selftest", distinguishable from a real role run', async () => {
    const { repo, stateBase } = makeProject();
    const sp = statePaths(repo, { stateBase });
    const sentinelPath = path.join(sp.root, SENTINEL_NAME);
    const runner = new MockRunner([greenScenario(sentinelPath)], repo);

    await runDeepCheck(repo, { stateBase, runner });

    const runs = readdirSync(sp.runsDir);
    const selftestRun = runs.find((r) => r.includes("_selftest_"));
    expect(selftestRun).toBeDefined();
    const record = JSON.parse(
      readFileSync(path.join(sp.runsDir, selftestRun!, "record.json"), "utf8"),
    );
    expect(record.role).toBe("selftest");
    expect(record.status).toBe("ok");
  });
});

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

describe("doctorCommand", () => {
  it("plain fh doctor is unaffected: same checks, same exit code, no live section", async () => {
    const { repo, stateBase } = makeProject();
    const cwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(repo);
    try {
      await withEnv({ FH_STATE_DIR: stateBase }, async () => {
        const code = await doctorCommand([]);
        expect(code).toBe(0);
        const printed = log.mock.calls.flat().join("\n");
        expect(printed).toContain("All good.");
        expect(printed).not.toContain("Starting a live");
      });
    } finally {
      process.chdir(cwd);
      log.mockRestore();
    }
  });

  it("--deep short-circuits on a static failure, without ever starting the live run", async () => {
    const { repo, stateBase } = makeProject();
    writeFileSync(path.join(repo, ".founder-helpers", "config.json"), "{not valid json", "utf8");
    const sp = statePaths(repo, { stateBase });

    const cwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(repo);
    try {
      await withEnv({ FH_STATE_DIR: stateBase }, async () => {
        const code = await doctorCommand(["--deep"]);
        expect(code).toBe(1);
        const printed = log.mock.calls.flat().join("\n");
        expect(printed).toContain("check(s) failed");
        expect(printed).not.toContain("Starting a live");
      });
      // The live check creates its runDir *before* invoking the runner — proof it never ran at all.
      const selftestRuns = existsSync(sp.runsDir)
        ? readdirSync(sp.runsDir).filter((r) => r.includes("_selftest_"))
        : [];
      expect(selftestRuns).toEqual([]);
    } finally {
      process.chdir(cwd);
      log.mockRestore();
    }
  });

  it("--deep runs the live check end to end and reports ok (FH_RUNNER=mock)", async () => {
    const { repo, stateBase } = makeProject();
    const sp = statePaths(repo, { stateBase });
    const sentinelPath = path.join(sp.root, SENTINEL_NAME);
    const scenariosFile = path.join(stateBase, "scenarios.json");
    writeFileSync(scenariosFile, JSON.stringify([greenScenario(sentinelPath)]), "utf8");

    const cwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(repo);
    try {
      await withEnv(
        { FH_STATE_DIR: stateBase, FH_RUNNER: "mock", FH_MOCK_SCENARIOS: scenariosFile },
        async () => {
          const code = await doctorCommand(["--deep"]);
          const printed = log.mock.calls.flat().join("\n");
          expect(printed).toContain("Starting a live");
          expect(code).toBe(0);
          expect(printed).toContain("All good (deep check passed).");
        },
      );
    } finally {
      process.chdir(cwd);
      log.mockRestore();
    }
  });

  it("--deep runs the live check end to end and reports a failure (FH_RUNNER=mock, no scenario)", async () => {
    const { repo, stateBase } = makeProject();
    const scenariosFile = path.join(stateBase, "scenarios.json");
    writeFileSync(scenariosFile, JSON.stringify([]), "utf8");

    const cwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(repo);
    try {
      await withEnv(
        { FH_STATE_DIR: stateBase, FH_RUNNER: "mock", FH_MOCK_SCENARIOS: scenariosFile },
        async () => {
          const code = await doctorCommand(["--deep"]);
          expect(code).toBe(1);
          const printed = log.mock.calls.flat().join("\n");
          expect(printed).toContain("Deep check failed.");
          expect(printed).toContain("status: error");
        },
      );
    } finally {
      process.chdir(cwd);
      log.mockRestore();
    }
  });
});
