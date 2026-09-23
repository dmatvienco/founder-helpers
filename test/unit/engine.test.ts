import { describe, expect, it } from "vitest";
import { ENGINES, pickEngine } from "../../src/cli/engine.js";

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

describe("pickEngine", () => {
  it("keeps the current default on an empty answer (Enter)", async () => {
    const picker = io([""]);
    expect(await pickEngine(picker, "claude")).toBe("claude");
  });

  it("picks codex by number", async () => {
    const picker = io(["2"]);
    expect(await pickEngine(picker, "claude")).toBe("codex");
  });

  it("picks codex by name, case-insensitively", async () => {
    const picker = io(["Codex"]);
    expect(await pickEngine(picker, "claude")).toBe("codex");
  });

  it("picks claude by number even when the current default is codex", async () => {
    const picker = io(["1"]);
    expect(await pickEngine(picker, "codex")).toBe("claude");
  });

  it("treats an unrecognized answer as keeping current, not a crash", async () => {
    const picker = io(["banana"]);
    expect(await pickEngine(picker, "claude")).toBe("claude");
  });

  it("lists both engines before asking", async () => {
    const picker = io([""]);
    await pickEngine(picker, "claude");
    expect(picker.said.some((l) => l.includes(ENGINES.claude.label))).toBe(true);
    expect(picker.said.some((l) => l.includes(ENGINES.codex.label))).toBe(true);
  });
});
