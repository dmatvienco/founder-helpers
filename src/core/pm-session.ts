import { existsSync, rmSync, statSync } from "node:fs";
import { readJson, writeJsonAtomic } from "../state/atomic.js";
import { PmSessionSchema, type PmSession } from "../state/schema.js";

/**
 * Reply-mode conversation continuity for the PM: the claude CLI's own
 * session id, resumed across founder messages so a follow-up question
 * doesn't pay for a from-scratch re-verification of everything it already
 * checked. Work-lane roles (dev/reviewer/digest) never touch this — they
 * stay one-shot by design.
 */

export function loadPmSession(file: string): PmSession | undefined {
  try {
    return readJson(file, PmSessionSchema);
  } catch {
    // Missing (first ever reply) or corrupt — never let this block a reply.
    return undefined;
  }
}

export function loadPmSessionId(file: string): string | undefined {
  return loadPmSession(file)?.sessionId;
}

export function savePmSessionId(
  file: string,
  sessionId: string,
  watchedMtimes: Record<string, number> = {},
): void {
  writeJsonAtomic(
    file,
    { sessionId, updatedAt: new Date().toISOString(), watchedMtimes },
    PmSessionSchema,
  );
}

export function resetPmSession(file: string): void {
  for (const f of [file, `${file}.bak`]) {
    if (existsSync(f)) rmSync(f);
  }
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    // Missing file (e.g. no profile.md yet) is a valid, stable state of its own.
    return 0;
  }
}

/** Current on-disk mtimes of the files the role prompt embeds, keyed by a caller-chosen label. */
export function watchedFileMtimes(files: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, filePath] of Object.entries(files)) out[key] = mtimeOf(filePath);
  return out;
}

/** True only when every watched file's mtime matches what was recorded after the last turn. */
export function mtimesUnchanged(
  current: Record<string, number>,
  stored: Record<string, number> | undefined,
): boolean {
  if (!stored) return false;
  const keys = Object.keys(current);
  if (keys.length !== Object.keys(stored).length) return false;
  return keys.every((k) => current[k] === stored[k]);
}
