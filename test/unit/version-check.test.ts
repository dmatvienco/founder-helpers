import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkForNewerVersion,
  isNewerVersion,
  packageVersion,
  VERSION_CHECK_TTL_MS,
} from "../../src/util/version-check.js";

const HOUR = 60 * 60_000;

function cacheFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "fh-vcheck-")), "version-check.json");
}

/** A registry that answers `dist-tags` with `latest`. */
function registry(latest: string) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ latest, next: "9.9.9" })));
}

describe("isNewerVersion", () => {
  it.each([
    ["0.11.0", "0.10.0", true],
    ["0.10.1", "0.10.0", true],
    ["1.0.0", "0.99.99", true],
    ["0.10.10", "0.10.9", true], // numeric, not lexicographic
    ["0.10.0", "0.10.0", false],
    ["0.9.0", "0.10.0", false],
    ["0.11.0", "0.11.0-rc.1", true], // a prerelease sorts below its own release
    ["0.11.0-rc.1", "0.11.0", false],
    ["0.11.0-rc.2", "0.11.0-rc.1", false], // same triple, both prereleases: equal
    ["0.12.0-rc.1", "0.11.0", true],
    ["v0.11.0", "0.10.0", true],
    ["0.11.0+build.5", "0.10.0", true],
    ["banana", "0.10.0", false],
    ["0.11.0", "banana", false],
    ["0.11", "0.10.0", false],
    ["", "", false],
  ])("isNewerVersion(%j, %j) -> %s", (latest, installed, expected) => {
    expect(isNewerVersion(latest, installed)).toBe(expected);
  });
});

describe("packageVersion", () => {
  it("reads the version of the package.json that ships with the running code", () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    expect(packageVersion()).toBe(pkg.version);
  });
});

describe("checkForNewerVersion", () => {
  it("returns the one-liner when the registry has a higher version", async () => {
    const fetchImpl = registry("0.11.0");
    const line = await checkForNewerVersion({
      cacheFile: cacheFile(),
      installed: "0.10.0",
      fetchImpl,
    });
    expect(line).toBe(
      "founder-helpers 0.10.0 installed, 0.11.0 on npm — npm update -g founder-helpers + restart",
    );
  });

  it("reads the installed version from the package by default", async () => {
    const line = await checkForNewerVersion({
      cacheFile: cacheFile(),
      fetchImpl: registry("999.0.0"),
    });
    expect(line).toBe(
      `founder-helpers ${packageVersion()} installed, 999.0.0 on npm — npm update -g founder-helpers + restart`,
    );
  });

  it("asks only for the dist-tags URL, with a timeout signal and nothing identifying", async () => {
    const fetchImpl = registry("0.10.0");
    await checkForNewerVersion({ cacheFile: cacheFile(), installed: "0.10.0", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://registry.npmjs.org/-/package/founder-helpers/dist-tags");
    // No method/body/headers: the request carries no data of ours at all.
    expect(Object.keys(init ?? {})).toEqual(["signal"]);
  });

  it.each([
    ["the same version", "0.10.0"],
    ["a lower version", "0.9.0"],
    ["a prerelease of the installed release", "0.10.0-rc.1"],
  ])("stays silent when the registry has %s", async (_name, latest) => {
    const line = await checkForNewerVersion({
      cacheFile: cacheFile(),
      installed: "0.10.0",
      fetchImpl: registry(latest),
    });
    expect(line).toBeNull();
  });

  it("stays silent, without throwing, when the fetch rejects", async () => {
    const debug = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    const line = await checkForNewerVersion({
      cacheFile: cacheFile(),
      installed: "0.10.0",
      fetchImpl,
      debug,
    });
    expect(line).toBeNull();
    // The only trace of a failure is a debug line.
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0]?.[0]).toContain("fetch failed");
  });

  it("gives up after the timeout when the registry never answers", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const started = Date.now();
    const line = await checkForNewerVersion({
      cacheFile: cacheFile(),
      installed: "0.10.0",
      fetchImpl,
      timeoutMs: 30,
    });
    expect(line).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("gives up when the body stalls after the headers arrived", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // headers are out, the body never finishes — only the abort ends it
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(body, { status: 200 });
    });
    const line = await checkForNewerVersion({
      cacheFile: cacheFile(),
      installed: "0.10.0",
      fetchImpl,
      timeoutMs: 30,
    });
    expect(line).toBeNull();
  });

  it.each([
    ["a 404 (unknown package)", () => new Response("{}", { status: 404 })],
    ["a 500", () => new Response("oops", { status: 500 })],
    ["a 304", () => new Response(null, { status: 304 })],
    ["unparseable JSON", () => new Response("<html>captive portal</html>", { status: 200 })],
    ["an empty body", () => new Response("", { status: 200 })],
    ["JSON null", () => new Response("null", { status: 200 })],
    ["JSON without a latest tag", () => new Response('{"next":"1.0.0"}', { status: 200 })],
    ["a non-string latest", () => new Response('{"latest":11}', { status: 200 })],
    ["a latest that is not a version", () => new Response('{"latest":"banana"}', { status: 200 })],
  ])("stays silent, without throwing, on %s", async (_name, respond) => {
    const line = await checkForNewerVersion({
      cacheFile: cacheFile(),
      installed: "0.10.0",
      fetchImpl: vi.fn<typeof fetch>(async () => respond()),
    });
    expect(line).toBeNull();
  });

  it("stays silent when the installed version cannot be determined", async () => {
    const fetchImpl = registry("0.11.0");
    expect(
      await checkForNewerVersion({ cacheFile: cacheFile(), installed: "not-a-version", fetchImpl }),
    ).toBeNull();
  });

  it("does not cache a failed lookup, so the next call tries again", async () => {
    const file = cacheFile();
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    await checkForNewerVersion({ cacheFile: file, installed: "0.10.0", fetchImpl: failing });
    expect(() => readFileSync(file, "utf8")).toThrow();

    const line = await checkForNewerVersion({
      cacheFile: file,
      installed: "0.10.0",
      fetchImpl: registry("0.11.0"),
    });
    expect(line).toContain("0.11.0 on npm");
  });

  describe("cache", () => {
    it("writes { checkedAt, latest } to the state file", async () => {
      const file = cacheFile();
      await checkForNewerVersion({
        cacheFile: file,
        installed: "0.10.0",
        fetchImpl: registry("0.11.0"),
        now: () => Date.parse("2026-09-20T10:00:00.000Z"),
      });
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
        checkedAt: "2026-09-20T10:00:00.000Z",
        latest: "0.11.0",
      });
    });

    it("a fresh entry inside the TTL triggers no second request, and still yields the line", async () => {
      const file = cacheFile();
      const t0 = Date.parse("2026-09-20T10:00:00.000Z");
      const first = registry("0.11.0");
      const a = await checkForNewerVersion({
        cacheFile: file,
        installed: "0.10.0",
        fetchImpl: first,
        now: () => t0,
      });

      const second = registry("0.12.0");
      const b = await checkForNewerVersion({
        cacheFile: file,
        installed: "0.10.0",
        fetchImpl: second,
        now: () => t0 + 23 * HOUR,
      });

      expect(first).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();
      expect(b).toBe(a);
    });

    it("a cached answer that matches the install by now (after the update) is silent", async () => {
      const file = cacheFile();
      const t0 = Date.parse("2026-09-20T10:00:00.000Z");
      await checkForNewerVersion({
        cacheFile: file,
        installed: "0.10.0",
        fetchImpl: registry("0.11.0"),
        now: () => t0,
      });
      const fetchImpl = registry("0.11.0");
      const line = await checkForNewerVersion({
        cacheFile: file,
        installed: "0.11.0",
        fetchImpl,
        now: () => t0 + HOUR,
      });
      expect(line).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("asks the registry again once the entry is older than the TTL", async () => {
      const file = cacheFile();
      const t0 = Date.parse("2026-09-20T10:00:00.000Z");
      await checkForNewerVersion({
        cacheFile: file,
        installed: "0.10.0",
        fetchImpl: registry("0.11.0"),
        now: () => t0,
      });
      const later = registry("0.12.0");
      const line = await checkForNewerVersion({
        cacheFile: file,
        installed: "0.10.0",
        fetchImpl: later,
        now: () => t0 + VERSION_CHECK_TTL_MS + 1,
      });
      expect(later).toHaveBeenCalledTimes(1);
      expect(line).toContain("0.12.0 on npm");
    });

    it("does not trust an entry stamped in the future", async () => {
      const file = cacheFile();
      writeFileSync(
        file,
        JSON.stringify({ checkedAt: "2099-01-01T00:00:00.000Z", latest: "0.9.0" }),
      );
      const fetchImpl = registry("0.11.0");
      const line = await checkForNewerVersion({ cacheFile: file, installed: "0.10.0", fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(line).toContain("0.11.0 on npm");
    });

    it.each([
      ["garbage", "\\q not json"],
      ["the wrong shape", JSON.stringify({ latest: 11 })],
      ["a bad timestamp", JSON.stringify({ checkedAt: "yesterday-ish", latest: "0.11.0" })],
    ])("treats a cache file with %s as no cache", async (_name, content) => {
      const file = cacheFile();
      writeFileSync(file, content);
      const fetchImpl = registry("0.11.0");
      const line = await checkForNewerVersion({ cacheFile: file, installed: "0.10.0", fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(line).toContain("0.11.0 on npm");
    });

    it("still answers when the cache cannot be written", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "fh-vcheck-"));
      // A regular file where the cache's directory should be: mkdir fails.
      const blocker = path.join(dir, "blocker");
      writeFileSync(blocker, "");
      const debug = vi.fn();
      const line = await checkForNewerVersion({
        cacheFile: path.join(blocker, "version-check.json"),
        installed: "0.10.0",
        fetchImpl: registry("0.11.0"),
        debug,
      });
      expect(line).toContain("0.11.0 on npm");
      expect(debug).toHaveBeenCalledWith(expect.stringContaining("cache not written"));
    });
  });
});
