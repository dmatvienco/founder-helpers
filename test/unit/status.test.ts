import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { addJob } from "../../src/core/queue.js";
import { recordGrant, revokeGrant } from "../../src/permissions/ledger.js";
import { gatherStatus, statusCommand } from "../../src/cli/status.js";
import { statePaths, type PathsOptions } from "../../src/state/paths.js";
import { writeJsonAtomic } from "../../src/state/atomic.js";
import { headCommit } from "../../src/util/git.js";
import { ProjectConfigSchema, RunRecordSchema } from "../../src/state/schema.js";

function makeProject(): { repo: string; stateBase: string; opts: PathsOptions } {
  const repo = mkdtempSync(path.join(tmpdir(), "fh-status-repo-"));
  mkdirSync(path.join(repo, ".founder-helpers"), { recursive: true });
  const stateBase = mkdtempSync(path.join(tmpdir(), "fh-status-state-"));
  return { repo, stateBase, opts: { stateBase } };
}

/** Same as makeProject(), but `repo` is a real git repo so commit-drift checks have HEAD to read. */
function makeGitProject(): { repo: string; stateBase: string; opts: PathsOptions } {
  const project = makeProject();
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", project.repo], { stdio: "ignore" });
  execFileSync("git", ["-C", project.repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", project.repo, "config", "user.name", "Test"]);
  return project;
}

function commit(repo: string, message: string): string {
  writeFileSync(path.join(repo, `${message.replace(/\s+/g, "-")}.txt`), message, "utf8");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-m", message], { stdio: "ignore" });
  return headCommit(repo) as string;
}

function writeHeartbeat(repo: string, opts: PathsOptions, commitHash: string | null): void {
  const sp = statePaths(repo, opts);
  mkdirSync(sp.root, { recursive: true });
  writeFileSync(
    path.join(sp.root, "heartbeat.json"),
    JSON.stringify({ pid: process.pid, at: new Date().toISOString(), commit: commitHash }),
    "utf8",
  );
}

function writeConfig(repo: string, overrides: Partial<{ enabled: boolean; cron: string }> = {}): void {
  const config = ProjectConfigSchema.parse({
    integrationBranch: "main",
    digest: { enabled: overrides.enabled ?? true, cron: overrides.cron ?? "0 8 * * *" },
  });
  writeFileSync(
    path.join(repo, ".founder-helpers", "config.json"),
    JSON.stringify(config, null, 2),
    "utf8",
  );
}

function writeRun(repo: string, opts: PathsOptions, id: string, role: string, status: string): void {
  const sp = statePaths(repo, opts);
  const record = RunRecordSchema.parse({
    id,
    role,
    startedAt: "2026-01-01T00:00:00.000Z",
    status,
  });
  writeJsonAtomic(path.join(sp.runsDir, id, "record.json"), record, RunRecordSchema);
}

describe("gatherStatus", () => {
  it("reports empty defaults for a project that never started", () => {
    const { repo, opts } = makeProject();
    const data = gatherStatus(repo, opts);
    expect(data).toEqual({
      daemon: { running: false, pid: null, heartbeatAgeSec: null, commit: null, commitsBehind: null },
      queue: [],
      lastRuns: [],
      grants: [],
      digest: { enabled: false, cron: null },
    });
  });

  it("reflects a live daemon heartbeat", () => {
    const { repo, opts } = makeProject();
    const sp = statePaths(repo, opts);
    mkdirSync(sp.root, { recursive: true });
    writeFileSync(
      path.join(sp.root, "heartbeat.json"),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      "utf8",
    );
    const data = gatherStatus(repo, opts);
    expect(data.daemon.running).toBe(true);
    expect(data.daemon.pid).toBe(process.pid);
    expect(data.daemon.heartbeatAgeSec).toBeTypeOf("number");
  });

  it("reports commit unknown when the heartbeat predates this field", () => {
    const { repo, opts } = makeGitProject();
    commit(repo, "initial");
    writeHeartbeat(repo, opts, null);
    const data = gatherStatus(repo, opts);
    expect(data.daemon.commit).toBeNull();
    expect(data.daemon.commitsBehind).toBeNull();
  });

  it("reports no drift when the daemon's commit matches HEAD", () => {
    const { repo, opts } = makeGitProject();
    const head = commit(repo, "initial");
    writeHeartbeat(repo, opts, head);
    const data = gatherStatus(repo, opts);
    expect(data.daemon.commit).toBe(head);
    expect(data.daemon.commitsBehind).toBe(0);
  });

  it("counts commits behind HEAD when the repo has moved on since the daemon started", () => {
    const { repo, opts } = makeGitProject();
    const started = commit(repo, "initial");
    commit(repo, "second");
    commit(repo, "third");
    writeHeartbeat(repo, opts, started);
    const data = gatherStatus(repo, opts);
    expect(data.daemon.commit).toBe(started);
    expect(data.daemon.commitsBehind).toBe(2);
  });

  it("reports drift as unknown, not a crash, when the recorded commit isn't reachable", () => {
    const { repo, opts } = makeGitProject();
    commit(repo, "initial");
    writeHeartbeat(repo, opts, "0000000000000000000000000000000000dead");
    const data = gatherStatus(repo, opts);
    expect(data.daemon.commit).toBe("0000000000000000000000000000000000dead");
    expect(data.daemon.commitsBehind).toBeNull();
  });

  it("collects queue jobs, last runs (newest first, capped at 5), grants and digest", () => {
    const { repo, opts } = makeProject();
    const sp = statePaths(repo, opts);
    writeConfig(repo, { enabled: true, cron: "*/15 * * * *" });

    addJob(sp.queueFile, { kind: "issue", issue: 8, base: "main" });
    addJob(sp.queueFile, { kind: "digest" });

    for (let i = 0; i < 7; i++) {
      writeRun(repo, opts, `run-${i}`, "dev", "ok");
    }

    recordGrant(repo, { scope: "git.merge_integration_branch", quote: "go ahead" }, opts);
    const revoked = recordGrant(repo, { scope: "deploy.production", quote: "not yet" }, opts);
    revokeGrant(repo, revoked.id, opts);

    const data = gatherStatus(repo, opts);

    expect(data.queue).toHaveLength(2);
    expect(data.queue[0]).toMatchObject({ kind: "issue", issue: 8 });
    expect(data.queue[1]).toMatchObject({ kind: "digest" });

    expect(data.lastRuns.map((r) => r.id)).toEqual(["run-6", "run-5", "run-4", "run-3", "run-2"]);
    expect(data.lastRuns[0]).toEqual({ id: "run-6", role: "dev", status: "ok" });

    expect(data.grants).toEqual(["git.merge_integration_branch"]);
    expect(data.digest).toEqual({ enabled: true, cron: "*/15 * * * *" });
  });
});

describe("statusCommand --json", () => {
  it("prints exactly one line that JSON.parses to the documented shape", async () => {
    const { repo, stateBase, opts } = makeProject();
    const sp = statePaths(repo, opts);
    writeConfig(repo);
    addJob(sp.queueFile, { kind: "issue", issue: 8 });

    const cwd = process.cwd();
    const prevStateDir = process.env["FH_STATE_DIR"];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(repo);
    process.env["FH_STATE_DIR"] = stateBase;
    try {
      const code = await statusCommand(["--json"]);
      expect(code).toBe(0);
      expect(log).toHaveBeenCalledTimes(1);
      const printed = log.mock.calls[0]?.[0] as string;
      expect(printed).not.toMatch(/\x1b\[/); // no ANSI escapes
      expect(printed.split("\n")).toHaveLength(1); // single line, nothing wrapped around it
      const parsed = JSON.parse(printed);
      expect(parsed).toEqual({
        daemon: { running: false, pid: null, heartbeatAgeSec: null, commit: null, commitsBehind: null },
        queue: [{ id: expect.any(String), kind: "issue", issue: 8 }],
        lastRuns: [],
        grants: [],
        digest: { enabled: true, cron: "0 8 * * *" },
      });
    } finally {
      if (prevStateDir === undefined) delete process.env["FH_STATE_DIR"];
      else process.env["FH_STATE_DIR"] = prevStateDir;
      process.chdir(cwd);
      log.mockRestore();
    }
  });

  it("plain fh status prints human-readable text, unaffected by --json", async () => {
    const { repo, stateBase } = makeProject();
    writeConfig(repo);

    const cwd = process.cwd();
    const prevStateDir = process.env["FH_STATE_DIR"];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(repo);
    process.env["FH_STATE_DIR"] = stateBase;
    try {
      const code = await statusCommand([]);
      expect(code).toBe(0);
      const lines = log.mock.calls.flat();
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.some((l) => String(l).startsWith("daemon:"))).toBe(true);
      expect(lines.some((l) => String(l).startsWith("queue:"))).toBe(true);
      expect(() => JSON.parse(String(lines[0]))).toThrow();
    } finally {
      if (prevStateDir === undefined) delete process.env["FH_STATE_DIR"];
      else process.env["FH_STATE_DIR"] = prevStateDir;
      process.chdir(cwd);
      log.mockRestore();
    }
  });

  it("flags commit drift in the human-readable output", async () => {
    const { repo, stateBase, opts } = makeGitProject();
    writeConfig(repo);
    const started = commit(repo, "initial");
    commit(repo, "second");
    writeHeartbeat(repo, opts, started);

    const cwd = process.cwd();
    const prevStateDir = process.env["FH_STATE_DIR"];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(repo);
    process.env["FH_STATE_DIR"] = stateBase;
    try {
      const code = await statusCommand([]);
      expect(code).toBe(0);
      const lines = log.mock.calls.flat().map(String);
      expect(
        lines.some((l) => l.includes("1 commit(s) behind HEAD") && l.includes("restart")),
      ).toBe(true);
    } finally {
      if (prevStateDir === undefined) delete process.env["FH_STATE_DIR"];
      else process.env["FH_STATE_DIR"] = prevStateDir;
      process.chdir(cwd);
      log.mockRestore();
    }
  });
});
