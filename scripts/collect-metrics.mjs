#!/usr/bin/env node
// Project-owned prepare script for the digest pipeline (see
// .founder-helpers/config.json digest.pipeline[0].prepare). Collects
// adoption metrics -- GitHub repo stats and npm download counts -- and
// writes them to pm/metrics.json in the state dir for the PM's morning
// digest to read. No runtime dependency beyond `gh` (already on PATH for
// this team) and Node 20's built-in fetch.
//
// The state dir path arrives via FH_STATE_ROOT, set by the daemon
// (src/core/digest.ts) on the prepare command's environment -- this script
// never recomputes the per-OS/per-project path itself.

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const REPO = "dmatvienco/founder-helpers";
export const PACKAGE = "founder-helpers";

export function parseGithubStats(json) {
  return {
    stars: typeof json.stargazers_count === "number" ? json.stargazers_count : null,
    forks: typeof json.forks_count === "number" ? json.forks_count : null,
    watchers: typeof json.subscribers_count === "number" ? json.subscribers_count : null,
    openIssues: typeof json.open_issues_count === "number" ? json.open_issues_count : null,
  };
}

export function parseNpmDownloadPoint(json) {
  return typeof json.downloads === "number" ? json.downloads : null;
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

export async function fetchGithubRepoJson(repo, execFn = execFileAsync) {
  const { stdout } = await execFn("gh", ["api", `repos/${repo}`]);
  return JSON.parse(stdout);
}

export async function fetchDownloadPoint(period, pkg, fetchFn = fetch) {
  const url = `https://api.npmjs.org/downloads/point/${period}/${encodeURIComponent(pkg)}`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`npm downloads ${period} HTTP ${res.status}`);
  return res.json();
}

export async function collectGithub(repo = REPO, execFn = execFileAsync) {
  try {
    const json = await fetchGithubRepoJson(repo, execFn);
    return { ...parseGithubStats(json), error: null };
  } catch (err) {
    return { stars: null, forks: null, watchers: null, openIssues: null, error: errorMessage(err) };
  }
}

export async function collectNpm(pkg = PACKAGE, fetchFn = fetch) {
  try {
    const [week, month] = await Promise.all([
      fetchDownloadPoint("last-week", pkg, fetchFn),
      fetchDownloadPoint("last-month", pkg, fetchFn),
    ]);
    return { weekly: parseNpmDownloadPoint(week), monthly: parseNpmDownloadPoint(month), error: null };
  } catch (err) {
    return { weekly: null, monthly: null, error: errorMessage(err) };
  }
}

export async function collectMetrics() {
  const [github, npm] = await Promise.all([collectGithub(), collectNpm()]);
  return { collectedAt: new Date().toISOString(), github, npm };
}

async function main() {
  const stateRoot = process.env.FH_STATE_ROOT;
  if (!stateRoot) {
    console.error("collect-metrics: FH_STATE_ROOT is not set, cannot write output -- skipping");
    process.exitCode = 1;
    return;
  }

  const metrics = await collectMetrics();
  const pmDir = path.join(stateRoot, "pm");
  await mkdir(pmDir, { recursive: true });
  const outFile = path.join(pmDir, "metrics.json");
  await writeFile(outFile, JSON.stringify(metrics, null, 2) + "\n", "utf8");
  console.log(`collect-metrics: wrote ${outFile}`);

  if (metrics.github.error) console.error(`collect-metrics: github error: ${metrics.github.error}`);
  if (metrics.npm.error) console.error(`collect-metrics: npm error: ${metrics.npm.error}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
