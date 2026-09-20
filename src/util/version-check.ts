import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJsonAtomic } from "../state/atomic.js";
import { VersionCheckSchema } from "../state/schema.js";

const PACKAGE_NAME = "founder-helpers";
// dist-tags answers with a few dozen bytes; /founder-helpers/latest would ship
// the whole package.json of that release for the same one fact.
const DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`;

export const VERSION_CHECK_TTL_MS = 24 * 60 * 60_000;
export const VERSION_CHECK_TIMEOUT_MS = 2_000;

/**
 * The version of the package the RUNNING code belongs to — for the daemon that
 * is the global npm install, not whatever repo it happens to serve.
 */
export function packageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/util and dist/util both sit two levels below the package root.
  const pkg = JSON.parse(readFileSync(path.join(here, "..", "..", "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

interface ParsedVersion {
  nums: [number, number, number];
  prerelease: boolean;
}

function parseVersion(v: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: m[4] !== undefined };
}

/**
 * true when `latest` is strictly newer than `installed`, comparing numeric
 * triples; a prerelease sorts below its own release (0.11.0-rc.1 < 0.11.0).
 * Two prereleases of one triple count as equal. Unparseable input is never
 * "newer" — the check errs toward silence.
 */
export function isNewerVersion(latest: string, installed: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const diff = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return b.prerelease && !a.prerelease;
}

export interface VersionCheckOptions {
  /** state dir file caching the last registry answer. */
  cacheFile: string;
  /** Test hooks. */
  installed?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  ttlMs?: number | undefined;
  timeoutMs?: number | undefined;
  /** Where "why nothing happened" goes — never louder than debug. */
  debug?: ((msg: string) => void) | undefined;
}

async function fetchLatest(fetchImpl: typeof fetch, timeoutMs: number): Promise<string> {
  // The signal covers reading the body too, so a server that stalls after the
  // headers cannot hold the check open past the timeout.
  const res = await fetchImpl(DIST_TAGS_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status !== 200) throw new Error(`registry answered ${res.status}`);
  const body: unknown = await res.json();
  const latest =
    typeof body === "object" && body !== null ? (body as { latest?: unknown }).latest : undefined;
  if (typeof latest !== "string" || !parseVersion(latest)) {
    throw new Error("registry answer has no usable `latest` tag");
  }
  return latest;
}

/** The newest published version, from the cache while it is fresh, else the registry. */
async function latestPublished(o: VersionCheckOptions): Promise<string> {
  const now = (o.now ?? Date.now)();
  const ttlMs = o.ttlMs ?? VERSION_CHECK_TTL_MS;
  try {
    const cached = readJson(o.cacheFile, VersionCheckSchema);
    const age = now - Date.parse(cached.checkedAt);
    // A checkedAt in the future (clock change) must not freeze the cache.
    if (age >= 0 && age < ttlMs) return cached.latest;
  } catch {
    // no usable cache: ask the registry
  }
  const latest = await fetchLatest(o.fetchImpl ?? fetch, o.timeoutMs ?? VERSION_CHECK_TIMEOUT_MS);
  try {
    writeJsonAtomic(
      o.cacheFile,
      { checkedAt: new Date(now).toISOString(), latest },
      VersionCheckSchema,
    );
  } catch (err) {
    o.debug?.(`version check: cache not written: ${err}`);
  }
  return latest;
}

/**
 * The one-liner telling the founder the installed package is behind npm, or
 * null when it is current — or when anything at all went wrong (offline,
 * timeout, non-200, garbage, unreadable package.json). Never throws: a
 * version notice is a courtesy, and failing to fetch it must not cost anyone
 * a startup, a status call or a message.
 */
export async function checkForNewerVersion(o: VersionCheckOptions): Promise<string | null> {
  try {
    const installed = o.installed ?? packageVersion();
    const latest = await latestPublished(o);
    if (!isNewerVersion(latest, installed)) return null;
    return `${PACKAGE_NAME} ${installed} installed, ${latest} on npm — npm update -g ${PACKAGE_NAME} + restart`;
  } catch (err) {
    o.debug?.(`version check skipped: ${err}`);
    return null;
  }
}
