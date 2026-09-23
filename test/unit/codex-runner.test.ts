import { describe, expect, it } from "vitest";
import { buildCodexArgs } from "../../src/runner/codex-runner.js";
import type { RunSpec } from "../../src/runner/runner.js";

function baseSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    role: "dev",
    promptFile: "/tmp/prompt.md",
    spawnPrompt: "@/tmp/prompt.md",
    cwd: "/repo",
    runDir: "/tmp/run",
    timeoutMs: 60_000,
    model: "gpt-5-codex",
    permissionMode: "allowlist",
    addDirs: [],
    ...overrides,
  };
}

describe("buildCodexArgs", () => {
  it("builds a non-interactive exec invocation with --json and the workspace-write sandbox", () => {
    expect(buildCodexArgs(baseSpec())).toEqual([
      "exec",
      "@/tmp/prompt.md",
      "--model",
      "gpt-5-codex",
      "--json",
      "--sandbox",
      "workspace-write",
    ]);
  });

  it("maps acceptEdits to the same workspace-write sandbox as allowlist", () => {
    expect(buildCodexArgs(baseSpec({ permissionMode: "acceptEdits" }))).toEqual(
      expect.arrayContaining(["--sandbox", "workspace-write"]),
    );
  });

  it("maps bypass to Codex's bypass-approvals-and-sandbox flag, no --sandbox", () => {
    const args = buildCodexArgs(baseSpec({ permissionMode: "bypass" }));
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--sandbox");
  });

  it("uses the exec resume form when a session id is given", () => {
    const args = buildCodexArgs(baseSpec({ resumeSessionId: "sess-1" }));
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "sess-1"]);
  });

  it("omits resume when no session id is given", () => {
    expect(buildCodexArgs(baseSpec())).not.toContain("resume");
  });

  it("injects binArgs before the computed args, and bin overrides the binary (test hooks)", () => {
    const args = buildCodexArgs(baseSpec({ binArgs: ["/path/to/fake-codex.cjs"] }));
    expect(args[0]).toBe("/path/to/fake-codex.cjs");
    expect(args[1]).toBe("exec");
  });

  it("ignores settingsFile — Codex has no per-command allow/deny list", () => {
    const args = buildCodexArgs(baseSpec({ settingsFile: "/tmp/claude-settings.json" }));
    expect(args.join(" ")).not.toContain("claude-settings.json");
  });

  it("threads addDirs into the sandboxed run as writable roots", () => {
    const args = buildCodexArgs(baseSpec({ addDirs: ["/tmp/state"] }));
    expect(args).toEqual([
      "exec",
      "@/tmp/prompt.md",
      "--model",
      "gpt-5-codex",
      "--json",
      "--sandbox",
      "workspace-write",
      "--config",
      'sandbox_workspace_write.writable_roots=["/tmp/state"]',
    ]);
  });

  it("omits the writable-roots flag under bypass even when addDirs is set — no sandbox to widen", () => {
    const args = buildCodexArgs(
      baseSpec({ permissionMode: "bypass", addDirs: ["/tmp/state"] }),
    );
    expect(args).not.toContain("--config");
    expect(args.join(" ")).not.toContain("writable_roots");
  });

  it("produces exactly today's argument list when addDirs is empty — no stray flag", () => {
    const args = buildCodexArgs(baseSpec({ addDirs: [] }));
    expect(args).toEqual([
      "exec",
      "@/tmp/prompt.md",
      "--model",
      "gpt-5-codex",
      "--json",
      "--sandbox",
      "workspace-write",
    ]);
    expect(args).not.toContain("--config");
  });
});
