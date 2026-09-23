import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { doctorCommand, runChecks, runDeepCheck, runTelegramChecks } from "../../src/cli/doctor.js";
import { CodexRunner } from "../../src/runner/codex-runner.js";
import { MockRunner, type MockScenario } from "../../src/runner/mock-runner.js";
import { statePaths } from "../../src/state/paths.js";
import { saveSecrets } from "../../src/state/secrets.js";
import type { GhExec } from "../../src/util/gh.js";
import { startMockTelegram } from "../helpers/mock-telegram.js";

const fixturesBin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "bin",
);

// gh auth/network can't run for real in tests (#47) — a fake that says yes to
// everything, so the doctorCommand tests below reach the code path they're
// actually testing instead of short-circuiting on an unrelated new fail check.
const greenGh: GhExec = (args) => {
  const cmd = args.join(" ");
  if (cmd === "auth status") return { ok: true, stdout: "", stderr: "" };
  if (cmd === "repo view --json name") return { ok: true, stdout: '{"name":"x"}', stderr: "" };
  if (cmd.startsWith("label list")) {
    return {
      ok: true,
      stdout: JSON.stringify(
        ["status:approved", "status:in-progress", "status:review", "status:blocked"].map(
          (name) => ({ name }),
        ),
      ),
      stderr: "",
    };
  }
  return { ok: false, stdout: "", stderr: `unexpected gh call: ${cmd}` };
};

const SENTINEL_NAME = "doctor-selftest-sentinel.txt";
const SENTINEL_TOKEN = "founder-helpers-selftest-ok";

function makeProject(): { repo: string; stateBase: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "fh-doctor-"));
  const stateBase = mkdtempSync(path.join(tmpdir(), "fh-doctor-state-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], { stdio: "ignore" });
  runInit(repo, { stateBase });
  return { repo, stateBase };
}

/** `makeProject()` plus a real "origin" remote with the integration branch pushed — the fully-set-up baseline doctorCommand's own tests (unlike runDeepCheck's) need to reach "All good"/the deep-run stage instead of failing on the new origin/integration-branch checks (#47). */
function makeGreenProject(): { repo: string; stateBase: string } {
  const { repo, stateBase } = makeProject();
  const bare = mkdtempSync(path.join(tmpdir(), "fh-doctor-origin-"));
  execFileSync("git", ["init", "--bare", "-q", bare], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", bare], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.test"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "push", "origin", "main"], { stdio: "ignore" });
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
    const { repo, stateBase } = makeGreenProject();
    const cwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(repo);
    try {
      await withEnv({ FH_STATE_DIR: stateBase }, async () => {
        const code = await doctorCommand([], { gh: greenGh });
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
    const { repo, stateBase } = makeGreenProject();
    writeFileSync(path.join(repo, ".founder-helpers", "config.json"), "{not valid json", "utf8");
    const sp = statePaths(repo, { stateBase });

    const cwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(repo);
    try {
      await withEnv({ FH_STATE_DIR: stateBase }, async () => {
        const code = await doctorCommand(["--deep"], { gh: greenGh });
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
    const { repo, stateBase } = makeGreenProject();
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
          const code = await doctorCommand(["--deep"], { gh: greenGh });
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
    const { repo, stateBase } = makeGreenProject();
    const scenariosFile = path.join(stateBase, "scenarios.json");
    writeFileSync(scenariosFile, JSON.stringify([]), "utf8");

    const cwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(repo);
    try {
      await withEnv(
        { FH_STATE_DIR: stateBase, FH_RUNNER: "mock", FH_MOCK_SCENARIOS: scenariosFile },
        async () => {
          const code = await doctorCommand(["--deep"], { gh: greenGh });
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

function byName(
  checks: { name: string; level: string; detail: string }[],
): Record<string, { level: string; detail: string }> {
  return Object.fromEntries(checks.map((c) => [c.name, c]));
}

describe("runChecks: gh access and labels (#47)", () => {
  it("gh auth fails (not the vaguer gh CLI warn) when gh is on PATH but not logged in", () => {
    const { repo, stateBase } = makeGreenProject();
    const gh: GhExec = (args) =>
      args[0] === "auth"
        ? { ok: false, stdout: "", stderr: "" }
        : { ok: false, stdout: "", stderr: "unreachable" };

    const names = byName(runChecks(repo, { stateBase, gh }));

    expect(names["gh auth"]?.level).toBe("fail");
    expect(names["gh auth"]?.detail).toContain("gh auth login");
    expect(names["gh repo access"]).toBeUndefined();
    expect(names["labels"]).toBeUndefined();
  });

  it("gh repo access fails with a message distinct from an auth failure, once auth is ok", () => {
    const { repo, stateBase } = makeGreenProject();
    const gh: GhExec = (args) =>
      args[0] === "auth"
        ? { ok: true, stdout: "", stderr: "" }
        : { ok: false, stdout: "", stderr: "" };

    const names = byName(runChecks(repo, { stateBase, gh }));

    expect(names["gh auth"]?.level).toBe("ok");
    expect(names["gh repo access"]?.level).toBe("fail");
    expect(names["gh repo access"]?.detail).toContain("can't read this repository");
    expect(names["labels"]).toBeUndefined();
  });

  it("labels: passes when all four configured labels are present", () => {
    const { repo, stateBase } = makeGreenProject();

    const names = byName(runChecks(repo, { stateBase, gh: greenGh }));

    expect(names["labels"]?.level).toBe("ok");
  });

  it("labels: fails and prints a gh label create recipe for each missing one", () => {
    const { repo, stateBase } = makeGreenProject();
    const gh: GhExec = (args) => {
      const cmd = args.join(" ");
      if (cmd === "auth status") return { ok: true, stdout: "", stderr: "" };
      if (cmd === "repo view --json name") return { ok: true, stdout: '{"name":"x"}', stderr: "" };
      // Only two of the four default labels exist.
      return {
        ok: true,
        stdout: JSON.stringify([{ name: "status:approved" }, { name: "status:review" }]),
        stderr: "",
      };
    };

    const names = byName(runChecks(repo, { stateBase, gh }));

    expect(names["labels"]?.level).toBe("fail");
    expect(names["labels"]?.detail).toContain("status:in-progress");
    expect(names["labels"]?.detail).toContain("status:blocked");
    expect(names["labels"]?.detail).toContain('gh label create "status:in-progress"');
    expect(names["labels"]?.detail).not.toContain("status:approved"); // present label not listed as missing
  });
});

describe("runChecks: repo topology (#47)", () => {
  it("origin remote: fails with a recipe when none is configured", () => {
    const { repo, stateBase } = makeProject();

    const names = byName(runChecks(repo, { stateBase, gh: greenGh }));

    expect(names["origin remote"]?.level).toBe("fail");
    expect(names["origin remote"]?.detail).toContain("git remote add origin");
    expect(names["integration branch"]).toBeUndefined();
  });

  it("integration branch: fails when origin exists but the configured branch was never pushed", () => {
    const { repo, stateBase } = makeProject();
    const bare = mkdtempSync(path.join(tmpdir(), "fh-doctor-origin-"));
    execFileSync("git", ["init", "--bare", "-q", bare], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "remote", "add", "origin", bare], { stdio: "ignore" });

    const names = byName(runChecks(repo, { stateBase, gh: greenGh }));

    expect(names["origin remote"]?.level).toBe("ok");
    expect(names["integration branch"]?.level).toBe("fail");
    expect(names["integration branch"]?.detail).toContain("main");
  });

  it("integration branch: ok once the configured branch is actually on origin", () => {
    const { repo, stateBase } = makeGreenProject();

    const names = byName(runChecks(repo, { stateBase, gh: greenGh }));

    expect(names["integration branch"]?.level).toBe("ok");
  });
});

describe("runTelegramChecks (#47)", () => {
  it("not paired: a single warn, no network attempted", async () => {
    const { repo, stateBase } = makeProject();

    const checks = await runTelegramChecks(repo, { stateBase });

    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe("telegram pairing");
    expect(checks[0]?.level).toBe("warn");
    expect(checks[0]?.detail).toContain("fh init");
  });

  it("paired and token valid: both checks ok, no message sent by default", async () => {
    const { repo, stateBase } = makeProject();
    const sp = statePaths(repo, { stateBase });
    saveSecrets(sp, { telegram: { botToken: "TOKEN", chatId: 42 } });
    const server = await startMockTelegram();
    try {
      const checks = await runTelegramChecks(repo, { stateBase, apiBase: server.url });

      const names = byName(checks);
      expect(names["telegram pairing"]?.level).toBe("ok");
      expect(names["telegram token"]?.level).toBe("ok");
      expect(names["telegram token"]?.detail).toContain("mockbot");
      expect(names["telegram send"]).toBeUndefined();
      expect(server.sentMessages).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("paired but the token is rejected: warns, never fails (Telegram is the reporting channel, not the work)", async () => {
    const { repo, stateBase } = makeProject();
    const sp = statePaths(repo, { stateBase });
    saveSecrets(sp, { telegram: { botToken: "TOKEN", chatId: 42 } });
    const rejecting = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, description: "Unauthorized" }));
    });
    await new Promise<void>((resolve) => rejecting.listen(0, "127.0.0.1", resolve));
    const port = (rejecting.address() as AddressInfo).port;
    try {
      const checks = await runTelegramChecks(repo, {
        stateBase,
        apiBase: `http://127.0.0.1:${port}`,
      });

      const names = byName(checks);
      expect(names["telegram token"]?.level).toBe("warn");
      expect(names["telegram token"]?.detail).toContain("Unauthorized");
    } finally {
      await new Promise<void>((resolve) => rejecting.close(() => resolve()));
    }
  });

  it("--send delivers an actual test message, only when explicitly requested", async () => {
    const { repo, stateBase } = makeProject();
    const sp = statePaths(repo, { stateBase });
    saveSecrets(sp, { telegram: { botToken: "TOKEN", chatId: 42 } });
    const server = await startMockTelegram();
    try {
      const checks = await runTelegramChecks(repo, { stateBase, apiBase: server.url, send: true });

      const names = byName(checks);
      expect(names["telegram send"]?.level).toBe("ok");
      expect(server.sentMessages).toHaveLength(1);
      expect(server.sentMessages[0]?.chat_id).toBe(42);
    } finally {
      await server.close();
    }
  });
});
