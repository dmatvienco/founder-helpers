/**
 * The shared Claude session limit: detecting it, and reading the reset time
 * the CLI prints next to it —
 *
 *     You've hit your session limit · resets 1pm (Europe/Amsterdam)
 *
 * Knowing WHEN it lifts turns a blind 15-minute back-off (14 pointless
 * retries in the 2026-09-07 incident) into one accurate wait, and gives the
 * founder a notice with a time in it instead of "as soon as it lifts" (#30).
 */

/** The phrase the claude CLI prints when the shared session limit is hit. */
export const SESSION_LIMIT_RE = /hit your session limit/i;

/** What may follow it on the same line: "· resets 1pm (Europe/Amsterdam)". */
const RESET_RE = /resets\s+([^\r\n]+?)\s*$/im;

/** "1pm", "11:30am", "13:00" — optionally followed by "(Europe/Amsterdam)". */
const CLOCK_RE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i;

const DAY_MS = 24 * 60 * 60_000;

/** Retry no sooner than this after an announced reset — their clock is not ours. */
export const RESET_MARGIN_MS = 60_000;

/** Ceiling on any limit pause: a mis-parsed reset must never stall the daemon. */
export const MAX_LIMIT_PAUSE_MS = DAY_MS;

/** The reset facts a limited run carries to whoever decides how long to wait. */
export interface LimitReset {
  /** The reset time as the CLI printed it, e.g. "1pm (Europe/Amsterdam)". */
  limitResetText?: string | undefined;
  /** The same reset as an absolute instant (ISO), when it could be parsed. */
  limitResetAt?: string | undefined;
}

/**
 * Reads a run's output tail: `undefined` when it is not a session-limit run,
 * otherwise whatever could be learned about the reset (possibly nothing —
 * the CLI does not always print one).
 */
export function detectSessionLimit(output: string, now = Date.now()): LimitReset | undefined {
  const hit = SESSION_LIMIT_RE.exec(output);
  if (!hit) return undefined;
  // Only what comes AFTER the phrase: an unrelated "resets" earlier in the
  // run's own output is not this run's reset time.
  const limitResetText = RESET_RE.exec(output.slice(hit.index))?.[1]?.trim();
  if (!limitResetText) return {};
  const at = parseResetAt(limitResetText, now);
  return {
    limitResetText,
    ...(at === undefined ? {} : { limitResetAt: new Date(at).toISOString() }),
  };
}

/**
 * "1pm (Europe/Amsterdam)" → the epoch ms of the next 13:00 in that zone.
 *
 * Wall-clock arithmetic inside the zone via `Intl` (Node 20 ships full ICU —
 * no new dependency): the distance from what the clock reads there now to
 * what it must read, wrapping to tomorrow when that time is already behind
 * us. Anything it cannot read with confidence — no clock, an hour out of
 * range, an unknown zone — returns undefined and the caller falls back.
 */
export function parseResetAt(text: string, now: number): number | undefined {
  const m = CLOCK_RE.exec(text.trim());
  if (!m) return undefined;
  const meridiem = m[3]?.toLowerCase();
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (minute > 59) return undefined;
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  } else if (hour > 23) {
    return undefined;
  }

  const zone = m[4]?.trim();
  const nowSeconds = wallClockSeconds(now, zone);
  if (nowSeconds === undefined) return undefined;
  let delta = hour * 3600 + minute * 60 - nowSeconds;
  if (delta < 0) delta += DAY_MS / 1000; // already past there today → same time tomorrow
  return now + delta * 1000;
}

/** Seconds since midnight on `zone`'s wall clock (the host's zone when absent). */
function wallClockSeconds(at: number, zone?: string): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      ...(zone ? { timeZone: zone } : {}),
    }).formatToParts(new Date(at));
    const value = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    const [h, m, s] = [value("hour"), value("minute"), value("second")];
    if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return undefined;
    return h * 3600 + m * 60 + s;
  } catch {
    return undefined; // RangeError: an unknown time zone → no confident instant
  }
}

/**
 * How long to wait after a session-limit run: until the announced reset plus
 * a margin, or the blind fallback when the CLI told us nothing. Clamped on
 * both ends — never hammer, never stall for more than a day.
 */
export function limitPauseMs(
  limitResetAt: string | undefined,
  now: number,
  fallbackMs: number,
): number {
  if (!limitResetAt) return fallbackMs;
  const at = Date.parse(limitResetAt);
  if (Number.isNaN(at)) return fallbackMs;
  return Math.min(Math.max(at + RESET_MARGIN_MS - now, RESET_MARGIN_MS), MAX_LIMIT_PAUSE_MS);
}
