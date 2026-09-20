#!/usr/bin/env node
// CI guard: package-lock.json carries the package's own version in two places
// (top-level `version` and `packages[""].version`). Releases are cut by hand
// and bump only package.json, so the lockfile drifts unless something fails
// the release push (see issue #38: it sat at 0.6.0 while package.json was
// at 0.10.0). Wired into .github/workflows/ci.yml.
//
// Run from anywhere: the files are resolved relative to this script, not cwd.

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Returns one human-readable problem per mismatch; an empty array means the
// lockfile agrees with package.json at both places.
export function findVersionDrift(pkg, lock) {
  const expected = pkg?.version;
  if (typeof expected !== "string" || expected === "") {
    return ["package.json has no string `version` field"];
  }
  const places = [
    ["version", lock?.version],
    ['packages[""].version', lock?.packages?.[""]?.version],
  ];
  const problems = [];
  for (const [where, actual] of places) {
    if (actual !== expected) {
      problems.push(
        `package-lock.json ${where} is ${actual === undefined ? "missing" : JSON.stringify(actual)}, package.json says ${JSON.stringify(expected)}`,
      );
    }
  }
  return problems;
}

async function readJson(file) {
  return JSON.parse(await readFile(path.join(repoRoot, file), "utf8"));
}

async function main() {
  const problems = findVersionDrift(await readJson("package.json"), await readJson("package-lock.json"));
  if (problems.length === 0) {
    console.log("check-lockfile-version: package-lock.json matches package.json");
    return;
  }
  for (const problem of problems) console.error(`check-lockfile-version: ${problem}`);
  console.error(
    "check-lockfile-version: run `npm install --package-lock-only` and commit package-lock.json (only its version fields should change)",
  );
  process.exitCode = 1;
}

// Node puts the realpath of the entry module into import.meta.url, but
// process.argv[1] is only path.resolve'd, so compare against its realpath or a
// symlinked path (macOS /var -> /private/var) makes main() silently not run.
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  let resolved = entry;
  try {
    resolved = realpathSync(entry);
  } catch {
    // Missing path: keep the path as given, which then simply won't match.
  }
  return import.meta.url === pathToFileURL(resolved).href;
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.error(`check-lockfile-version: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
