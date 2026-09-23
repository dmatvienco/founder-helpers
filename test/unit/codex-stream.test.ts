import { describe, expect, it } from "vitest";
import { describeCodexAction, parseCodexLine } from "../../src/runner/codex-stream.js";

describe("parseCodexLine", () => {
  it("extracts session_id from a session_configured event", () => {
    const line = JSON.stringify({
      id: "0",
      msg: { type: "session_configured", session_id: "sess-abc" },
    });
    expect(parseCodexLine(line)).toEqual([{ kind: "session_id", id: "sess-abc" }]);
  });

  it("extracts an exec_command_begin as a tool_use event", () => {
    const line = JSON.stringify({
      id: "1",
      msg: { type: "exec_command_begin", command: ["npm", "test"] },
    });
    expect(parseCodexLine(line)).toEqual([
      { kind: "tool_use", name: "exec_command", input: { command: "npm test" } },
    ]);
  });

  it("extracts a patch_apply_begin as a tool_use event", () => {
    const line = JSON.stringify({ id: "2", msg: { type: "patch_apply_begin", path: "src/x.ts" } });
    expect(parseCodexLine(line)).toEqual([
      { kind: "tool_use", name: "patch_apply", input: { path: "src/x.ts" } },
    ]);
  });

  it("extracts agent_message text for the status tail", () => {
    const line = JSON.stringify({ id: "3", msg: { type: "agent_message", message: "hello" } });
    expect(parseCodexLine(line)).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("maps an error event with an auth-shaped message to auth_error", () => {
    const line = JSON.stringify({
      id: "4",
      msg: { type: "error", message: "Not logged in. Run codex login." },
    });
    expect(parseCodexLine(line)).toEqual([{ kind: "auth_error" }]);
  });

  it("maps an unrelated error event to plain text instead of auth_error", () => {
    const line = JSON.stringify({
      id: "5",
      msg: { type: "error", message: "rate limit exceeded" },
    });
    expect(parseCodexLine(line)).toEqual([{ kind: "text", text: "rate limit exceeded" }]);
  });

  it("skips an unrecognized msg.type without throwing", () => {
    expect(parseCodexLine(JSON.stringify({ id: "6", msg: { type: "task_complete" } }))).toEqual([]);
  });

  it("degrades gracefully on malformed, empty or non-envelope lines instead of throwing", () => {
    expect(parseCodexLine("")).toEqual([]);
    expect(parseCodexLine("   ")).toEqual([]);
    expect(parseCodexLine("not json at all")).toEqual([]);
    expect(parseCodexLine("{broken")).toEqual([]);
    expect(parseCodexLine("42")).toEqual([]);
    expect(parseCodexLine(JSON.stringify({ id: "7" }))).toEqual([]); // no msg field
  });
});

describe("describeCodexAction", () => {
  it("describes an exec_command action with its command", () => {
    expect(describeCodexAction("exec_command", { command: "npm test" })).toBe("running npm test");
  });

  it("describes a patch_apply action with its path", () => {
    expect(describeCodexAction("patch_apply", { path: "src/x.ts" })).toBe("editing src/x.ts");
  });

  it("falls back to a generic verb for an unrecognized action name", () => {
    expect(describeCodexAction("some_other_action", {})).toBe("using some_other_action");
  });

  it("falls back to the verb alone when there is no usable target", () => {
    expect(describeCodexAction("exec_command", {})).toBe("running");
    expect(describeCodexAction("patch_apply", {})).toBe("editing");
  });

  it("truncates a long command instead of echoing it verbatim (secret-leak risk)", () => {
    const command = `curl https://api.example.com --header "Authorization: Bearer supersecrettoken123456"`;
    const text = describeCodexAction("exec_command", { command });
    expect(text.length).toBeLessThan(command.length);
    expect(text.startsWith("running ")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
  });

  it("ignores non-object input without throwing", () => {
    expect(describeCodexAction("exec_command", "not an object")).toBe("running");
    expect(describeCodexAction("exec_command", undefined)).toBe("running");
  });
});
