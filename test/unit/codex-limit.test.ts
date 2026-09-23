import { describe, expect, it } from "vitest";
import { detectCodexAuthError, detectCodexLimit } from "../../src/runner/codex-limit.js";

describe("detectCodexLimit", () => {
  it("detects a rate/usage-limit phrase and never returns a reset time", () => {
    expect(detectCodexLimit("Error: rate limit exceeded, try again later")).toEqual({});
    expect(detectCodexLimit("usage limit reached for this account")).toEqual({});
    expect(detectCodexLimit("quota exceeded, try again tomorrow")).toEqual({});
    expect(detectCodexLimit("429 too many requests")).toEqual({});
  });

  it("returns undefined when there is no limit signal", () => {
    expect(detectCodexLimit("all good, task complete")).toBeUndefined();
  });
});

describe("detectCodexAuthError", () => {
  it("detects a not-logged-in / 401 signal", () => {
    expect(detectCodexAuthError("Not logged in. Run `codex login`.")).toBe(true);
    expect(detectCodexAuthError("401 Unauthorized")).toBe(true);
    expect(detectCodexAuthError("please log in again")).toBe(true);
  });

  it("returns false when there is no auth signal", () => {
    expect(detectCodexAuthError("all good, task complete")).toBe(false);
    expect(detectCodexAuthError("rate limit exceeded")).toBe(false);
  });
});
