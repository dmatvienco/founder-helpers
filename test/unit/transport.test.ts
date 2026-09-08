import { describe, expect, it } from "vitest";
import { RedeliverLater, isRedeliverLater } from "../../src/transport/transport.js";

describe("isRedeliverLater", () => {
  it("recognises the class, and a duck-typed copy of it", () => {
    expect(isRedeliverLater(new RedeliverLater("session limit"))).toBe(true);
    // Module duplication (test bundling, ESM/CJS) breaks instanceof; the flag
    // is what survives it.
    expect(isRedeliverLater({ redeliverLater: true })).toBe(true);
  });

  it("reads the flag's value, not its presence", () => {
    // An error that explicitly says "this is NOT a redelivery" was being taken
    // for one, so a real failure skipped the alert streak (#33).
    expect(isRedeliverLater({ redeliverLater: false })).toBe(false);
    expect(isRedeliverLater({ redeliverLater: undefined })).toBe(false);
    expect(isRedeliverLater({ redeliverLater: "yes" })).toBe(false);
    expect(isRedeliverLater(Object.assign(new Error("boom"), { redeliverLater: false }))).toBe(
      false,
    );
  });

  it("says no to everything else", () => {
    expect(isRedeliverLater(new Error("boom"))).toBe(false);
    expect(isRedeliverLater(null)).toBe(false);
    expect(isRedeliverLater(undefined)).toBe(false);
    expect(isRedeliverLater("redeliverLater")).toBe(false);
    expect(isRedeliverLater({})).toBe(false);
  });
});
