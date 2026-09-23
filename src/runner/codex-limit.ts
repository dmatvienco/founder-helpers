/**
 * Codex-side rate-limit / auth-signal detection from a run's output tail —
 * text-based, parallel to session-limit.ts but NOT sharing its regexes:
 * Claude's own wording there is asserted on by #30/#33's tests and must not
 * change (and must not be touched for this issue, #42).
 *
 * Codex prints no known equivalent of Claude's "resets <time>" line (this is
 * itself unverified — no `codex exec --help` output was available while this
 * was written), so a Codex limit hit never carries a LimitReset; the
 * caller's existing 15-minute blind-retry fallback (reply.ts/worker.ts)
 * applies untouched.
 */
import type { LimitReset } from "./session-limit.js";

const RATE_LIMIT_RE = /rate limit|usage limit|quota exceeded|too many requests/i;
const AUTH_RE = /not logged in|unauthorized|401|please log in|authentication/i;

/** `undefined` when the tail carries no limit signal, `{}` (never a reset) otherwise. */
export function detectCodexLimit(output: string): LimitReset | undefined {
  return RATE_LIMIT_RE.test(output) ? {} : undefined;
}

/** A not-logged-in / 401 signal in the tail — a backstop alongside codex-stream.ts's structured auth_error. */
export function detectCodexAuthError(output: string): boolean {
  return AUTH_RE.test(output);
}
