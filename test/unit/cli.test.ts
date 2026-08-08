import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { main } from "../../src/main.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("cli dispatcher", () => {
  it("prints the package version for --version", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main(["--version"])).toBe(0);
      expect(log).toHaveBeenCalledWith(pkg.version);
    } finally {
      log.mockRestore();
    }
  });

  it("prints help and exits 0 with no arguments", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main([])).toBe(0);
      expect(log.mock.calls.flat().join("\n")).toContain("Usage: fh");
    } finally {
      log.mockRestore();
    }
  });

  it("exits 1 on an unknown command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await main(["frobnicate"])).toBe(1);
      expect(error.mock.calls.flat().join("\n")).toContain("Unknown command: frobnicate");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
