import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { runRole } from "../../src/cli/run.js";
import { MockRunner } from "../../src/runner/mock-runner.js";
import { statePaths } from "../../src/state/paths.js";
import { isAlive } from "../../src/util/tree-kill.js";
import { until } from "../helpers/mock-telegram.js";

const fixturesBin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "bin",
);

function makeProject(): { repo: string; stateBase: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "fh-run-"));
  const stateBase = mkdtempSync(path.join(tmpdir(), "fh-runstate-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], { stdio: "ignore" });
  runInit(repo, { stateBase });
  return { repo, stateBase };
}

function fake(script: string): { bin: string; binArgs: string[] } {
  return { bin: process.execPath, binArgs: [path.join(fixturesBin, script)] };
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

describe("runRole with the ClaudeRunner (fake claude binaries)", () => {
  it("assembles the prompt with all sections and reports ok", async () => {
    const { repo, stateBase } = makeProject();
    const outcome = await runRole(repo, "dev", {
      issue: 7,
      paths: { stateBase },
      ...fake("ok.cjs"),
    });
    expect(outcome.record.status).toBe("ok");

    const prompt = readFileSync(path.join(outcome.runDir, "prompt.md"), "utf8");
    expect(prompt).toContain("# Role: Developer"); // shipped template
    expect(prompt).toContain("# Project profile"); // founder questionnaire
    expect(prompt).toContain("Project overlay"); // team's own knowledge
    expect(prompt).toContain("Active standing grants");
    expect(prompt).toContain("None."); // no grants yet
    expect(prompt).toContain("NEVER covered by standing grants");
    expect(prompt).toContain("Mirror the founder's language");
    expect(prompt).toContain("- Issue: #7");
    expect(prompt).toContain("report-issue7.md");
    expect(prompt).toContain("review-issue7.md");
    expect(prompt).toContain("running HEADLESS");

    // ClaudeRunner calls stream.end() without awaiting it (fire-and-forget),
    // so the output.log flush can still be in flight when run() resolves —
    // poll instead of asserting synchronously, same race class as #15.
    await until(
      () =>
        existsSync(outcome.outputLog) && readFileSync(outcome.outputLog, "utf8").includes("done"),
      2000,
      "output log flush",
    );
    const output = readFileSync(outcome.outputLog, "utf8");
    expect(output).toContain("done");

    // Regression for #9: the generated allowlist must never land inside the
    // repo (it would dirty the tree on every run) — only in the state dir.
    expect(existsSync(path.join(repo, ".founder-helpers", "claude-settings.json"))).toBe(false);
    const sp = statePaths(repo, { stateBase });
    expect(existsSync(path.join(sp.root, "claude-settings.json"))).toBe(true);
  });

  it("includes recorded grants in the prompt", async () => {
    const { repo, stateBase } = makeProject();
    writeFileSync(
      path.join(repo, ".founder-helpers", "permissions.json"),
      JSON.stringify({
        version: 1,
        grants: [
          {
            id: "g-merge",
            scope: "git.merge_integration_branch",
            granted: true,
            date: "2026-08-08T10:00:00Z",
            quote: "мержи сам, если ревью зелёное",
            revoked: null,
          },
        ],
      }),
      "utf8",
    );
    const outcome = await runRole(repo, "pm", {
      mode: "reply",
      paths: { stateBase },
      ...fake("ok.cjs"),
    });
    const prompt = readFileSync(path.join(outcome.runDir, "prompt.md"), "utf8");
    expect(prompt).toContain("git.merge_integration_branch");
    expect(prompt).toContain("мержи сам, если ревью зелёное");
    expect(prompt).toContain("fh grant revoke g-merge");
  });

  it("detects the shared session limit", async () => {
    const { repo, stateBase } = makeProject();
    const outcome = await runRole(repo, "pm", {
      paths: { stateBase },
      ...fake("limit.cjs"),
    });
    expect(outcome.record.status).toBe("limit");
  });

  it("detects the session limit even when the final write has no trailing newline (#22)", async () => {
    const { repo, stateBase } = makeProject();
    const outcome = await runRole(repo, "pm", {
      paths: { stateBase },
      ...fake("limit-no-newline.cjs"),
    });
    expect(outcome.record.status).toBe("limit");
  });

  it("detects an expired OAuth session via the structured error field, not exit code alone (#21)", async () => {
    const { repo, stateBase } = makeProject();
    const outcome = await runRole(repo, "pm", {
      paths: { stateBase },
      ...fake("auth.cjs"),
    });
    expect(outcome.record.status).toBe("auth");
  });

  it("streams tool_use events as progress lines, skipping thinking/text blocks (stream-json, #20)", async () => {
    const { repo, stateBase } = makeProject();
    const events: string[] = [];
    const outcome = await runRole(repo, "dev", {
      issue: 7,
      paths: { stateBase },
      onProgress: (e) => events.push(e.text),
      ...fake("stream.cjs"),
    });
    expect(outcome.record.status).toBe("ok");
    // line2 (the Read tool_use) is written across two separate stdout
    // chunks by the fixture — this also exercises partial-line buffering.
    expect(events).toEqual(["reading src/x.ts", "running npm test"]);
  });

  it("passes --resume when a session id is given and captures the reported session_id", async () => {
    const { repo, stateBase } = makeProject();
    const outcome = await runRole(repo, "pm", {
      mode: "reply",
      resumeSessionId: "sess-prev",
      paths: { stateBase },
      ...fake("session.cjs"),
    });
    expect(outcome.record.status).toBe("ok");
    expect(outcome.sessionId).toBe("sess-fixture-1");
    const output = readFileSync(outcome.outputLog, "utf8");
    expect(output).toContain("RESUME_ARG:sess-prev");
  });

  it("omits --resume when no session id is stored yet", async () => {
    const { repo, stateBase } = makeProject();
    const outcome = await runRole(repo, "pm", {
      mode: "reply",
      paths: { stateBase },
      ...fake("session.cjs"),
    });
    expect(outcome.sessionId).toBe("sess-fixture-1");
    const output = readFileSync(outcome.outputLog, "utf8");
    expect(output).toContain("RESUME_ARG:none");
  });

  it("retries once without --resume when a resumed session errors out (stale/unknown id)", async () => {
    const { repo, stateBase } = makeProject();
    const outcome = await runRole(repo, "pm", {
      mode: "reply",
      resumeSessionId: "stale-id",
      paths: { stateBase },
      ...fake("session-stale.cjs"),
    });
    expect(outcome.record.status).toBe("ok");
    expect(outcome.sessionId).toBe("sess-fresh-retry");
  });

  it("maps non-zero exit to error", async () => {
    const { repo, stateBase } = makeProject();
    const outcome = await runRole(repo, "pm", {
      paths: { stateBase },
      ...fake("err.cjs"),
    });
    expect(outcome.record.status).toBe("error");
    expect(outcome.record.exitCode).toBe(2);
  });

  it("kills the whole tree on timeout", { timeout: 20000 }, async () => {
    const { repo, stateBase } = makeProject();
    const outcome = await runRole(repo, "pm", {
      paths: { stateBase },
      timeoutMsOverride: 2000,
      ...fake("hang.cjs"),
    });
    expect(outcome.record.status).toBe("timeout");
    const output = readFileSync(outcome.outputLog, "utf8");
    const m = output.match(/GRANDCHILD:(\d+)/);
    expect(m).toBeTruthy();
    expect(await waitUntilDead(Number(m?.[1]), 5000)).toBe(true);
  });

  it("rejects an unknown role with a clear error", async () => {
    const { repo, stateBase } = makeProject();
    await expect(
      runRole(repo, "nonexistent", { paths: { stateBase }, ...fake("ok.cjs") }),
    ).rejects.toThrow(/Unknown role "nonexistent"/);
  });

  it("a project-only role file works as a custom role", async () => {
    const { repo, stateBase } = makeProject();
    writeFileSync(
      path.join(repo, ".founder-helpers", "roles", "marketer.md"),
      "# Marketer custom role\nDo marketing things.\n",
      "utf8",
    );
    const outcome = await runRole(repo, "marketer", {
      paths: { stateBase },
      ...fake("ok.cjs"),
    });
    const prompt = readFileSync(path.join(outcome.runDir, "prompt.md"), "utf8");
    expect(prompt).toContain("Custom role definition: marketer");
    expect(prompt).toContain("Do marketing things.");
  });
});

describe("MockRunner", () => {
  it("writes scenario files and reports ok", async () => {
    const { repo, stateBase } = makeProject();
    const sp = mkdtempSync(path.join(tmpdir(), "fh-mockbase-"));
    const runner = new MockRunner(
      [
        {
          role: "pm",
          writeFiles: [{ path: "outbox/morning.txt", content: "digest text" }],
          stdout: "pm mock run",
        },
      ],
      sp,
    );
    const outcome = await runRole(repo, "pm", { paths: { stateBase }, runner });
    expect(outcome.record.status).toBe("ok");
    expect(readFileSync(path.join(sp, "outbox", "morning.txt"), "utf8")).toBe("digest text");
  });

  it("hang scenario resolves as timeout; limit text resolves as limit", async () => {
    const { repo, stateBase } = makeProject();
    const sp = mkdtempSync(path.join(tmpdir(), "fh-mockbase2-"));
    const hangRunner = new MockRunner([{ role: "dev", hang: true }], sp);
    const limitRunner = new MockRunner(
      [{ role: "pm", stdout: "You've hit your session limit." }],
      sp,
    );
    expect(
      (await runRole(repo, "dev", { paths: { stateBase }, runner: hangRunner })).record.status,
    ).toBe("timeout");
    expect(
      (await runRole(repo, "pm", { paths: { stateBase }, runner: limitRunner })).record.status,
    ).toBe("limit");
  });

  it("authFailed scenario resolves as auth (#21)", async () => {
    const { repo, stateBase } = makeProject();
    const sp = mkdtempSync(path.join(tmpdir(), "fh-mockbase-auth-"));
    const authRunner = new MockRunner([{ role: "dev", authFailed: true }], sp);
    expect(
      (await runRole(repo, "dev", { paths: { stateBase }, runner: authRunner })).record.status,
    ).toBe("auth");
  });

  it("replays scripted progressEvents through onProgress (#20)", async () => {
    const { repo, stateBase } = makeProject();
    const sp = mkdtempSync(path.join(tmpdir(), "fh-mockbase3-"));
    const runner = new MockRunner(
      [
        {
          role: "pm",
          progressEvents: [{ text: "reading src/x.ts", delayMs: 5 }, { text: "running tests" }],
        },
      ],
      sp,
    );
    const events: string[] = [];
    const outcome = await runRole(repo, "pm", {
      paths: { stateBase },
      runner,
      onProgress: (e) => events.push(e.text),
    });
    expect(outcome.record.status).toBe("ok");
    expect(events).toEqual(["reading src/x.ts", "running tests"]);
  });
});
