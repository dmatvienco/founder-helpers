import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readJsonWithRecovery, writeJsonAtomic } from "../../src/state/atomic.js";

const Schema = z.object({ n: z.number(), s: z.string() });
type T = z.infer<typeof Schema>;

function tmpFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "fh-atomic-")), "state.json");
}

describe("writeJsonAtomic / readJsonWithRecovery", () => {
  it("round-trips a valid object", () => {
    const file = tmpFile();
    writeJsonAtomic<T>(file, { n: 1, s: "a" }, Schema);
    expect(readJsonWithRecovery(file, Schema)).toEqual({ value: { n: 1, s: "a" }, recovered: false });
  });

  it("refuses to write an invalid object and leaves the previous file intact", () => {
    const file = tmpFile();
    writeJsonAtomic<T>(file, { n: 1, s: "a" }, Schema);
    expect(() => writeJsonAtomic(file, { n: "boom" } as unknown as T, Schema)).toThrow();
    expect(readJsonWithRecovery(file, Schema).value).toEqual({ n: 1, s: "a" });
  });

  it("recovers from .bak when the main file is corrupt (the \\q lesson)", () => {
    const file = tmpFile();
    writeJsonAtomic<T>(file, { n: 1, s: "v1" }, Schema);
    writeJsonAtomic<T>(file, { n: 2, s: "v2" }, Schema); // .bak now holds v1
    writeFileSync(file, '{"n": 2, "s": "literal \\q backslash', "utf8"); // simulated corruption
    const res = readJsonWithRecovery(file, Schema);
    expect(res.recovered).toBe(true);
    expect(res.value).toEqual({ n: 1, s: "v1" });
  });

  it("falls back to the provided default when nothing is readable", () => {
    const file = tmpFile();
    const res = readJsonWithRecovery<T>(file, Schema, { n: 0, s: "default" });
    expect(res.value).toEqual({ n: 0, s: "default" });
  });

  it("throws when nothing is readable and no fallback is given", () => {
    const file = tmpFile();
    writeFileSync(file, "not json at all", "utf8");
    expect(() => readJsonWithRecovery(file, Schema)).toThrow(/no usable backup/);
  });

  it("cleans up stale tmp files from crashed writers", () => {
    const file = tmpFile();
    writeFileSync(`${file}.tmp-999-dead`, "half-written", "utf8");
    writeJsonAtomic<T>(file, { n: 3, s: "c" }, Schema);
    const leftovers = readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });

  it("tolerates a UTF-8 BOM (files inherited from the PowerShell era)", () => {
    const file = tmpFile();
    writeFileSync(file, `﻿${JSON.stringify({ n: 7, s: "bom" })}`, "utf8");
    expect(readJsonWithRecovery(file, Schema).value).toEqual({ n: 7, s: "bom" });
  });
});
