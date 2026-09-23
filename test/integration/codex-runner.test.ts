import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { runRole } from "../../src/cli/run.js";
import { CodexRunner } from "../../src/runner/codex-runner.js";

const fixturesBin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "bin",
);

function makeProject(): { repo: string; stateBase: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "fh-codex-run-"));
  const stateBase = mkdtempSync(path.join(tmpdir(), "fh-codex-runstate-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], { stdio: "ignore" });
  runInit(repo, { stateBase });
  return { repo, stateBase };
}

function fake(script: string): { bin: string; binArgs: string[] } {
  return { bin: process.execPath, binArgs: [path.join(fixturesBin, script)] };
}

describe("runRole with the CodexRunner (fake codex binaries, #42)", () => {
  it("reports ok and captures the session_id from a session_configured event", async () => {
    const { repo, stateBase } = makeProject();
    const outcome = await runRole(repo, "dev", {
      issue: 42,
      paths: { stateBase },
      runner: new CodexRunner(),
      ...fake("codex-ok.cjs"),
    });
    expect(outcome.record.status).toBe("ok");
    expect(outcome.sessionId).toBe("codex-sess-1");
  });

  it("streams exec_command_begin/patch_apply_begin as progress events, across a chunk boundary", async () => {
    const { repo, stateBase } = makeProject();
    const events: string[] = [];
    const outcome = await runRole(repo, "dev", {
      issue: 42,
      paths: { stateBase },
      runner: new CodexRunner(),
      onProgress: (e) => events.push(e.text),
      ...fake("codex-stream.cjs"),
    });
    expect(outcome.record.status).toBe("ok");
    expect(events).toEqual(["running npm test", "editing src/x.ts"]);
  });

  it("passes exec resume <id> when a session id is given and captures the reported session_id", async () => {
    const { repo, stateBase } = makeProject();
    const outcome = await runRole(repo, "pm", {
      mode: "reply",
      resumeSessionId: "sess-prev",
      paths: { stateBase },
      runner: new CodexRunner(),
      ...fake("codex-session.cjs"),
    });
    expect(outcome.record.status).toBe("ok");
    expect(outcome.sessionId).toBe("codex-sess-fixture-1");
    const output = readFileSync(outcome.outputLog, "utf8");
    expect(output).toContain("RESUME_ARG:sess-prev");
  });

  it("omits resume when no session id is stored yet", async () => {
    const { repo, stateBase } = makeProject();
    const outcome = await runRole(repo, "pm", {
      mode: "reply",
      paths: { stateBase },
      runner: new CodexRunner(),
      ...fake("codex-session.cjs"),
    });
    expect(outcome.sessionId).toBe("codex-sess-fixture-1");
    const output = readFileSync(outcome.outputLog, "utf8");
    expect(output).toContain("RESUME_ARG:none");
  });

  it("skips a malformed line mid-stream without failing the run", async () => {
    const { repo, stateBase } = makeProject();
    const outcome = await runRole(repo, "dev", {
      issue: 42,
      paths: { stateBase },
      runner: new CodexRunner(),
      ...fake("codex-garbage-line.cjs"),
    });
    expect(outcome.record.status).toBe("ok");
    expect(outcome.sessionId).toBe("codex-sess-1");
  });

  it("detects a structured auth failure via the error event, not exit code alone", async () => {
    const { repo, stateBase } = makeProject();
    const outcome = await runRole(repo, "pm", {
      paths: { stateBase },
      runner: new CodexRunner(),
      ...fake("codex-auth.cjs"),
    });
    expect(outcome.record.status).toBe("auth");
  });

  it("detects a rate-limit signal with no reset time (Codex has none, unverified)", async () => {
    const { repo, stateBase } = makeProject();
    const outcome = await runRole(repo, "pm", {
      paths: { stateBase },
      runner: new CodexRunner(),
      ...fake("codex-limit.cjs"),
    });
    expect(outcome.record.status).toBe("limit");
    expect(outcome.limitResetText).toBeUndefined();
    expect(outcome.limitResetAt).toBeUndefined();
  });

  it("flushes a rate-limit signal even when the final write has no trailing newline", async () => {
    const { repo, stateBase } = makeProject();
    const outcome = await runRole(repo, "pm", {
      paths: { stateBase },
      runner: new CodexRunner(),
      ...fake("codex-limit-no-newline.cjs"),
    });
    expect(outcome.record.status).toBe("limit");
  });

  it("falls back to plain-text status detection when --json is rejected, staying silent on progress", async () => {
    const { repo, stateBase } = makeProject();
    const events: string[] = [];
    const outcome = await runRole(repo, "pm", {
      paths: { stateBase },
      runner: new CodexRunner(),
      onProgress: (e) => events.push(e.text),
      ...fake("codex-fallback.cjs"),
    });
    expect(outcome.record.status).toBe("limit");
    expect(events).toEqual([]);
  });

  it("kills the whole tree on timeout", { timeout: 20000 }, async () => {
    const { repo, stateBase } = makeProject();
    const outcome = await runRole(repo, "pm", {
      paths: { stateBase },
      timeoutMsOverride: 2000,
      runner: new CodexRunner(),
      ...fake("hang.cjs"),
    });
    expect(outcome.record.status).toBe("timeout");
  });

  it("logs a caveat instead of silently dropping settingsFile (no per-command allow/deny list under codex)", async () => {
    const { repo, stateBase } = makeProject();
    const outcome = await runRole(repo, "dev", {
      issue: 42,
      paths: { stateBase },
      runner: new CodexRunner(),
      ...fake("codex-ok.cjs"),
    });
    const output = readFileSync(outcome.outputLog, "utf8");
    expect(output).toContain("settingsFile allowlist does not apply to this engine");
  });

  it('runner.kind: "codex" in config selects CodexRunner end to end', async () => {
    const { repo, stateBase } = makeProject();
    const configFile = path.join(repo, ".founder-helpers", "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    config.runner.kind = "codex";
    writeFileSync(configFile, JSON.stringify(config, null, 2), "utf8");

    const outcome = await runRole(repo, "dev", {
      issue: 42,
      paths: { stateBase },
      ...fake("codex-ok.cjs"),
    });
    expect(outcome.record.status).toBe("ok");
    expect(outcome.sessionId).toBe("codex-sess-1");
  });
});
