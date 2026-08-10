import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { addJob } from "../../src/core/queue.js";
import { recordGrant, revokeGrant } from "../../src/permissions/ledger.js";
import { gatherStatus, statusCommand } from "../../src/cli/status.js";
import { statePaths, type PathsOptions } from "../../src/state/paths.js";
import { writeJsonAtomic } from "../../src/state/atomic.js";
import { ProjectConfigSchema, RunRecordSchema } from "../../src/state/schema.js";

function makeProject(): { repo: string; stateBase: string; opts: PathsOptions } {
  const repo = mkdtempSync(path.join(tmpdir(), "fh-status-repo-"));
  mkdirSync(path.join(repo, ".founder-helpers"), { recursive: true });
  const stateBase = mkdtempSync(path.join(tmpdir(), "fh-status-state-"));
  return { repo, stateBase, opts: { stateBase } };
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
      daemon: { running: false, pid: null, heartbeatAgeSec: null },
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
        daemon: { running: false, pid: null, heartbeatAgeSec: null },
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
});
