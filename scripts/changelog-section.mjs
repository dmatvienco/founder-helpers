#!/usr/bin/env node
// CI helper: extracts one version's section from CHANGELOG.md, so
// .github/workflows/release.yml can hand it to `gh release create
// --notes-file` instead of an unreadable shell one-liner (issue #52).
//
// Run from anywhere: CHANGELOG.md is resolved relative to this script, not cwd.

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// CHANGELOG.md sections start at a `## <version>` heading and run to the next
// `## ` heading or end of file. Returns null when the version has no section
// -- a real case: a CI-only or test-only release ships no changelog entry.
export function extractChangelogSection(changelog, version) {
  const heading = `## ${version}`;
  const lines = changelog.split("\n");
  const startIndex = lines.findIndex((line) => line === heading);
  if (startIndex === -1) return null;

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      endIndex = i;
      break;
    }
  }
  return lines.slice(startIndex + 1, endIndex).join("\n").trim();
}

async function main() {
  const version = process.argv[2];
  if (!version) {
    console.error("changelog-section: usage: changelog-section.mjs <version>");
    process.exitCode = 1;
    return;
  }

  const changelog = await readFile(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  const section = extractChangelogSection(changelog, version);
  if (section === null) {
    console.error(`changelog-section: CHANGELOG.md has no "## ${version}" section`);
    process.exitCode = 1;
    return;
  }

  console.log(section);
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
    console.error(`changelog-section: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
