import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/state/log.js";

describe("createLogger", () => {
  it("writes leveled, timestamped lines", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "fh-log-")), "t.log");
    const log = createLogger(file);
    log.info("hello");
    log.warn("careful");
    const content = readFileSync(file, "utf8");
    expect(content).toMatch(/INFO hello\n/);
    expect(content).toMatch(/WARN careful\n/);
    expect(content).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
  });

  it("rotates when the file exceeds maxBytes and keeps a bounded set", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "fh-rot-")), "d.log");
    const log = createLogger(file, { maxBytes: 300, keep: 2 });
    for (let i = 0; i < 60; i++) log.info(`line ${i} ${"x".repeat(40)}`);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(statSync(file).size).toBeLessThan(400);
    expect(existsSync(`${file}.3`)).toBe(false); // keep=2 -> never a .3
  });
});
