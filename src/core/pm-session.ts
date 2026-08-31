import { existsSync, rmSync } from "node:fs";
import { readJson, writeJsonAtomic } from "../state/atomic.js";
import { PmSessionSchema } from "../state/schema.js";

/**
 * Reply-mode conversation continuity for the PM: the claude CLI's own
 * session id, resumed across founder messages so a follow-up question
 * doesn't pay for a from-scratch re-verification of everything it already
 * checked. Work-lane roles (dev/reviewer/digest) never touch this — they
 * stay one-shot by design.
 */

export function loadPmSessionId(file: string): string | undefined {
  try {
    return readJson(file, PmSessionSchema).sessionId;
  } catch {
    // Missing (first ever reply) or corrupt — never let this block a reply.
    return undefined;
  }
}

export function savePmSessionId(file: string, sessionId: string): void {
  writeJsonAtomic(file, { sessionId, updatedAt: new Date().toISOString() }, PmSessionSchema);
}

export function resetPmSession(file: string): void {
  for (const f of [file, `${file}.bak`]) {
    if (existsSync(f)) rmSync(f);
  }
}
