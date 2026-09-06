import { describe, expect, it } from "vitest";
import { KNOWN_MODELS, pickModel } from "../../src/cli/model-picker.js";

function io(answers: string[]): { ask: (q: string) => Promise<string>; say: (l: string) => void; said: string[] } {
  const said: string[] = [];
  const queue = [...answers];
  return {
    said,
    say: (l) => said.push(l),
    ask: async () => queue.shift() ?? "",
  };
}

describe("pickModel", () => {
  it("keeps the current default on an empty answer (Enter)", async () => {
    const picker = io([""]);
    const model = await pickModel(picker, "claude-sonnet-5");
    expect(model).toBe("claude-sonnet-5");
  });

  it("picks a known alias by list number", async () => {
    const picker = io(["2"]);
    const model = await pickModel(picker, "claude-sonnet-5");
    expect(model).toBe(KNOWN_MODELS[1]?.alias);
  });

  it("accepts a full model id typed directly, unlisted models included", async () => {
    const picker = io(["claude-opus-4-1-special"]);
    const model = await pickModel(picker, "claude-sonnet-5");
    expect(model).toBe("claude-opus-4-1-special");
  });

  it("treats an out-of-range number as a literal custom id, not a crash", async () => {
    const picker = io(["99"]);
    const model = await pickModel(picker, "claude-sonnet-5");
    expect(model).toBe("99");
  });

  it("lists every known alias before asking", async () => {
    const picker = io([""]);
    await pickModel(picker, "claude-sonnet-5");
    for (const m of KNOWN_MODELS) {
      expect(picker.said.some((l) => l.includes(m.alias))).toBe(true);
    }
  });
});
