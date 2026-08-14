import { describe, expect, it } from "vitest";
import {
  collectGithub,
  collectNpm,
  parseGithubStats,
  parseNpmDownloadPoint,
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
  it("reads the downloads count", () => {
    expect(parseNpmDownloadPoint({ downloads: 0, package: "founder-helpers" })).toBe(0);
    expect(parseNpmDownloadPoint({ downloads: 42 })).toBe(42);
  });

  it("returns null when the shape is unexpected", () => {
    expect(parseNpmDownloadPoint({ error: "package not found" })).toBeNull();
  });
});

describe("collectGithub", () => {
  it("parses gh api output via an injected exec function (no real gh/network call)", async () => {
    const execFn = async (file, args) => {
      expect(file).toBe("gh");
      expect(args).toEqual(["api", "repos/dmatvienco/founder-helpers"]);
      return { stdout: JSON.stringify({ stargazers_count: 1, forks_count: 2, subscribers_count: 3, open_issues_count: 4 }) };
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

describe("collectNpm", () => {
  it("parses weekly and monthly download points via an injected fetch (no real network call)", async () => {
    const calledUrls = [];
    const fetchFn = async (url) => {
      calledUrls.push(url);
      const downloads = url.includes("last-week") ? 10 : 100;
      return { ok: true, json: async () => ({ downloads }) };
    };
    await expect(collectNpm("founder-helpers", fetchFn)).resolves.toEqual({
      weekly: 10,
      monthly: 100,
      error: null,
    });
    expect(calledUrls).toEqual([
      "https://api.npmjs.org/downloads/point/last-week/founder-helpers",
      "https://api.npmjs.org/downloads/point/last-month/founder-helpers",
    ]);
  });

  it("reports an honest error instead of throwing on a non-OK response", async () => {
    const fetchFn = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const result = await collectNpm("founder-helpers", fetchFn);
    expect(result.weekly).toBeNull();
    expect(result.monthly).toBeNull();
    expect(result.error).toMatch(/503/);
  });
});
