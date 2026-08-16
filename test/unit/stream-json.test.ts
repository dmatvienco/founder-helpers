import { describe, expect, it } from "vitest";
import { describeToolUse, parseStreamJsonLine, splitLines } from "../../src/runner/stream-json.js";

describe("parseStreamJsonLine", () => {
  it("extracts a tool_use block as a progress event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/x.ts" } }] },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { kind: "tool_use", name: "Read", input: { file_path: "src/x.ts" } },
    ]);
  });

  it("extracts a text block for the session-limit tail", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });
    expect(parseStreamJsonLine(line)).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("skips thinking blocks — never surfaced as progress or tail text", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "secret reasoning" }] },
    });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  it("extracts multiple blocks from one assistant message in order", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "looking" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
        ],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { kind: "text", text: "looking" },
      { kind: "tool_use", name: "Bash", input: { command: "npm test" } },
    ]);
  });

  it("extracts the result text from a result line", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" });
    expect(parseStreamJsonLine(line)).toEqual([{ kind: "result", text: "done" }]);
  });

  it("detects an expired OAuth session via the structured error field, wherever it lands (#21)", () => {
    // Real shape observed in the incident: "error" rides on the assistant
    // line, sibling to "message", not inside message.content.
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Failed to authenticate: OAuth session expired and could not be refreshed" }] },
      error: "authentication_failed",
      is_api_error_message: true,
    });
    expect(parseStreamJsonLine(line)).toEqual([{ kind: "auth_error" }]);
  });

  it("does not misfire on an unrelated error value", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [] }, error: "rate_limited" });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  it("ignores user/tool_result and system lines", () => {
    expect(
      parseStreamJsonLine(
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
      ),
    ).toEqual([]);
    expect(parseStreamJsonLine(JSON.stringify({ type: "system", subtype: "init" }))).toEqual([]);
  });

  it("degrades gracefully on malformed or empty lines instead of throwing", () => {
    expect(parseStreamJsonLine("")).toEqual([]);
    expect(parseStreamJsonLine("   ")).toEqual([]);
    expect(parseStreamJsonLine("not json at all")).toEqual([]);
    expect(parseStreamJsonLine("{broken")).toEqual([]);
    expect(parseStreamJsonLine("42")).toEqual([]);
    expect(parseStreamJsonLine(JSON.stringify({ type: "assistant" }))).toEqual([]);
  });
});

describe("splitLines", () => {
  it("holds a trailing partial line across calls", () => {
    const a = splitLines("", "line1\nline2\npart");
    expect(a.lines).toEqual(["line1", "line2"]);
    expect(a.pending).toBe("part");

    const b = splitLines(a.pending, "ial\nline3\n");
    expect(b.lines).toEqual(["partial", "line3"]);
    expect(b.pending).toBe("");
  });

  it("tolerates a trailing CR before the newline", () => {
    const { lines } = splitLines("", '{"a":1}\r\n');
    expect(lines).toEqual(['{"a":1}\r']);
    expect(JSON.parse(lines[0] ?? "")).toEqual({ a: 1 });
  });
});

describe("describeToolUse", () => {
  it("renders tool name + short target for known tools", () => {
    expect(describeToolUse("Read", { file_path: "src/x.ts" })).toBe("reading src/x.ts");
    expect(describeToolUse("Write", { file_path: "out.txt" })).toBe("writing out.txt");
    expect(describeToolUse("Edit", { file_path: "a.ts" })).toBe("editing a.ts");
    expect(describeToolUse("Grep", { pattern: "TODO" })).toBe("searching TODO");
    expect(describeToolUse("Bash", { command: "npm test" })).toBe("running npm test");
  });

  it("falls back to the verb alone when there is no usable target", () => {
    expect(describeToolUse("TodoWrite", { todos: [] })).toBe("updating the todo list");
    expect(describeToolUse("Bash", {})).toBe("running");
  });

  it("uses a generic fallback for unrecognized tool names, never dumping raw input", () => {
    expect(describeToolUse("SomeMcpTool", { secret: "xyz" })).toBe("using SomeMcpTool");
  });

  it("truncates a long target instead of echoing it verbatim (secret-leak risk)", () => {
    const command = `curl https://api.example.com --header "Authorization: Bearer supersecrettoken123456"`;
    const text = describeToolUse("Bash", { command });
    expect(text.length).toBeLessThan(command.length);
    expect(text.startsWith("running ")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
  });

  it("ignores non-object input without throwing", () => {
    expect(describeToolUse("Read", "not an object")).toBe("reading");
    expect(describeToolUse("Read", undefined)).toBe("reading");
  });
});
