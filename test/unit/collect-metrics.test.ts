import { describe, expect, it } from "vitest";
import {
  collectGithub,
  collectNpm,
  parseGithubStats,
  parseNpmDailyRange,
  parseNpmDownloadPoint,
  parseNpmVersions,
} from "../../scripts/collect-metrics.mjs";

describe("parseGithubStats", () => {
  it("maps the GitHub repo fields the digest cares about", () => {
    expect(
      parseGithubStats({
        stargazers_count: 12,
        forks_count: 3,
        subscribers_count: 5,
        open_issues_count: 2,
        full_name: "dmatvienco/founder-helpers",
      }),
    ).toEqual({ stars: 12, forks: 3, watchers: 5, openIssues: 2 });
  });

  it("falls back to null for missing/non-numeric fields instead of guessing", () => {
    expect(parseGithubStats({})).toEqual({
      stars: null,
      forks: null,
      watchers: null,
      openIssues: null,
    });
  });
});

describe("parseNpmDownloadPoint", () => {
  it("reads the downloads count together with the date range it covers", () => {
    expect(
      parseNpmDownloadPoint({
        downloads: 0,
        start: "2026-08-31",
        end: "2026-09-06",
        package: "founder-helpers",
      }),
    ).toEqual({ downloads: 0, start: "2026-08-31", end: "2026-09-06" });
    expect(
      parseNpmDownloadPoint({ downloads: 42, start: "2026-08-08", end: "2026-09-06" }),
    ).toEqual({
      downloads: 42,
      start: "2026-08-08",
      end: "2026-09-06",
    });
  });

  it("keeps the count when start/end are absent instead of dropping the whole point", () => {
    expect(parseNpmDownloadPoint({ downloads: 7 })).toEqual({
      downloads: 7,
      start: null,
      end: null,
    });
  });

  it("returns nulls when the shape is unexpected", () => {
    expect(parseNpmDownloadPoint({ error: "package not found" })).toEqual({
      downloads: null,
      start: null,
      end: null,
    });
    expect(parseNpmDownloadPoint({ downloads: "42", start: 20260808, end: null })).toEqual({
      downloads: null,
      start: null,
      end: null,
    });
  });
});

describe("collectGithub", () => {
  it("parses gh api output via an injected exec function (no real gh/network call)", async () => {
    const execFn = async (file, args) => {
      expect(file).toBe("gh");
      expect(args).toEqual(["api", "repos/dmatvienco/founder-helpers"]);
      return {
        stdout: JSON.stringify({
          stargazers_count: 1,
          forks_count: 2,
          subscribers_count: 3,
          open_issues_count: 4,
        }),
      };
    };
    await expect(collectGithub("dmatvienco/founder-helpers", execFn)).resolves.toEqual({
      stars: 1,
      forks: 2,
      watchers: 3,
      openIssues: 4,
      error: null,
    });
  });

  it("reports an honest error instead of throwing when gh fails", async () => {
    const execFn = async () => {
      throw new Error("gh: command not found");
    };
    await expect(collectGithub("dmatvienco/founder-helpers", execFn)).resolves.toEqual({
      stars: null,
      forks: null,
      watchers: null,
      openIssues: null,
      error: "gh: command not found",
    });
  });
});

describe("parseNpmVersions", () => {
  it("keeps the per-version map and picks the highest semver as latest", () => {
    expect(
      parseNpmVersions({
        package: "founder-helpers",
        downloads: { "0.9.0": 5, "0.13.4": 7, "0.13.10": 2, "0.13.10-rc.1": 9 },
      }),
    ).toEqual({
      byVersion: { "0.9.0": 5, "0.13.4": 7, "0.13.10": 2, "0.13.10-rc.1": 9 },
      latest: "0.13.10",
      latestDownloads: 2,
    });
  });

  it("drops non-numeric entries and leaves latest null when no key is semver", () => {
    expect(parseNpmVersions({ downloads: { next: 3, "0.1.0": "x" } })).toEqual({
      byVersion: { next: 3 },
      latest: null,
      latestDownloads: null,
    });
    expect(parseNpmVersions({ downloads: {} })).toEqual({
      byVersion: {},
      latest: null,
      latestDownloads: null,
    });
  });

  it("returns nulls when the shape is unexpected", () => {
    const none = { byVersion: null, latest: null, latestDownloads: null };
    expect(parseNpmVersions({ error: "package not found" })).toEqual(none);
    expect(parseNpmVersions({ downloads: [1, 2] })).toEqual(none);
    expect(parseNpmVersions(null)).toEqual(none);
  });
});

describe("parseNpmDailyRange", () => {
  it("returns the day/downloads array as npm sends it", () => {
    expect(
      parseNpmDailyRange({
        start: "2026-09-01",
        end: "2026-09-02",
        package: "founder-helpers",
        downloads: [
          { day: "2026-09-01", downloads: 4 },
          { day: "2026-09-02", downloads: 0 },
        ],
      }),
    ).toEqual([
      { day: "2026-09-01", downloads: 4 },
      { day: "2026-09-02", downloads: 0 },
    ]);
  });

  it("drops malformed entries and returns null for an unexpected shape", () => {
    expect(
      parseNpmDailyRange({ downloads: [{ day: "2026-09-01", downloads: "4" }, { day: 1 }, null] }),
    ).toEqual([]);
    expect(parseNpmDailyRange({ error: "nope" })).toBeNull();
    expect(parseNpmDailyRange(undefined)).toBeNull();
  });
});

const POINT_WEEK = { downloads: 10, start: "2026-08-31", end: "2026-09-06" };
const POINT_MONTH = { downloads: 100, start: "2026-08-08", end: "2026-09-06" };
const VERSIONS = { package: "founder-helpers", downloads: { "0.13.3": 6, "0.13.4": 4 } };
const RANGE = {
  start: "2026-09-01",
  end: "2026-09-02",
  package: "founder-helpers",
  downloads: [
    { day: "2026-09-01", downloads: 3 },
    { day: "2026-09-02", downloads: 7 },
  ],
};

type Body = unknown;
type Reply = { ok: boolean; status?: number; json: () => Promise<Body> };

// Routes by URL like the real endpoints; `overrides` swaps one reply out.
function npmFetch(overrides: Record<string, Reply> = {}, calledUrls: string[] = []) {
  const replies: Record<string, Reply> = {
    "downloads/point/last-week": { ok: true, json: async () => POINT_WEEK },
    "downloads/point/last-month": { ok: true, json: async () => POINT_MONTH },
    "versions/founder-helpers/last-week": { ok: true, json: async () => VERSIONS },
    "downloads/range/last-month": { ok: true, json: async () => RANGE },
    ...overrides,
  };
  return async (url: string) => {
    calledUrls.push(url);
    const key = Object.keys(replies).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected url ${url}`);
    return replies[key];
  };
}

describe("collectNpm", () => {
  it("collects points, per-version and daily downloads via an injected fetch (no real network call)", async () => {
    const calledUrls: string[] = [];
    await expect(collectNpm("founder-helpers", npmFetch({}, calledUrls))).resolves.toEqual({
      weekly: 10,
      weeklyRange: { start: "2026-08-31", end: "2026-09-06" },
      monthly: 100,
      monthlyRange: { start: "2026-08-08", end: "2026-09-06" },
      error: null,
      byVersion: { "0.13.3": 6, "0.13.4": 4 },
      latest: "0.13.4",
      latestDownloads: 4,
      byVersionError: null,
      daily: RANGE.downloads,
      dailyError: null,
    });
    expect(calledUrls.sort()).toEqual([
      "https://api.npmjs.org/downloads/point/last-month/founder-helpers",
      "https://api.npmjs.org/downloads/point/last-week/founder-helpers",
      "https://api.npmjs.org/downloads/range/last-month/founder-helpers",
      "https://api.npmjs.org/versions/founder-helpers/last-week",
    ]);
  });

  it("still reports the counts when npm omits start/end", async () => {
    const fetchFn = npmFetch({
      "downloads/point/last-week": { ok: true, json: async () => ({ downloads: 22 }) },
      "downloads/point/last-month": { ok: true, json: async () => ({ downloads: 663 }) },
    });
    const result = await collectNpm("founder-helpers", fetchFn);
    expect(result).toMatchObject({
      weekly: 22,
      weeklyRange: { start: null, end: null },
      monthly: 663,
      monthlyRange: { start: null, end: null },
      error: null,
    });
  });

  it("reports an honest error on a non-OK point response and still collects the rest", async () => {
    const fetchFn = npmFetch({
      "downloads/point/last-week": { ok: false, status: 503, json: async () => ({}) },
    });
    const result = await collectNpm("founder-helpers", fetchFn);
    expect(result.weekly).toBeNull();
    expect(result.monthly).toBeNull();
    expect(result.weeklyRange).toEqual({ start: null, end: null });
    expect(result.monthlyRange).toEqual({ start: null, end: null });
    expect(result.error).toMatch(/503/);
    expect(result.byVersion).toEqual({ "0.13.3": 6, "0.13.4": 4 });
    expect(result.daily).toEqual(RANGE.downloads);
  });

  it("a failing versions endpoint sets only byVersionError", async () => {
    const fetchFn = npmFetch({
      "versions/founder-helpers/last-week": { ok: false, status: 500, json: async () => ({}) },
    });
    const result = await collectNpm("founder-helpers", fetchFn);
    expect(result.byVersion).toBeNull();
    expect(result.latest).toBeNull();
    expect(result.latestDownloads).toBeNull();
    expect(result.byVersionError).toMatch(/500/);
    expect(result).toMatchObject({ weekly: 10, monthly: 100, error: null, dailyError: null });
    expect(result.daily).toEqual(RANGE.downloads);
  });

  it("a failing daily endpoint sets only dailyError", async () => {
    const fetchFn = npmFetch({
      "downloads/range/last-month": { ok: false, status: 429, json: async () => ({}) },
    });
    const result = await collectNpm("founder-helpers", fetchFn);
    expect(result.daily).toBeNull();
    expect(result.dailyError).toMatch(/429/);
    expect(result).toMatchObject({
      weekly: 10,
      error: null,
      byVersionError: null,
      latest: "0.13.4",
    });
  });

  it("malformed JSON in one endpoint is contained to that endpoint's error field", async () => {
    const badJson = async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    };
    const result = await collectNpm(
      "founder-helpers",
      npmFetch({
        "versions/founder-helpers/last-week": { ok: true, json: badJson },
        "downloads/range/last-month": { ok: true, json: async () => ({ downloads: "oops" }) },
      }),
    );
    expect(result.byVersion).toBeNull();
    expect(result.byVersionError).toMatch(/Unexpected token/);
    expect(result.daily).toBeNull();
    expect(result.dailyError).toMatch(/unexpected response shape/);
    expect(result).toMatchObject({ weekly: 10, monthly: 100, error: null });
  });
});
