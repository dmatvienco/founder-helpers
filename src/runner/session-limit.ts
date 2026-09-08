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

/** What may follow it, on the phrase's own line: "· resets 1pm (Europe/Amsterdam)". */
const RESET_RE = /resets\s+(.+?)\s*$/i;

/** "1pm", "11:30am", "13:00" — the zone in parentheses is what makes it usable. */
const CLOCK_RE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i;

const DAY_MS = 24 * 60 * 60_000;

/** Retry no sooner than this after an announced reset — their clock is not ours. */
export const RESET_MARGIN_MS = 60_000;

/**
 * A reset that reads as already past by less than this is "any moment now",
 * not tomorrow: the CLI rounds the printed time to the hour, so the real reset
 * can sit up to an hour behind what it shows — and our retry at reset +
 * RESET_MARGIN_MS re-reads that very same text (#33).
 */
const RESET_GRACE_SECONDS = 60 * 60;

/**
 * Ceiling on any limit pause. Session limits are 5-hour windows, so a wait
 * near a full day is a mis-parse, not a reset — cap it past where a real
 * window can end and let the retry find out (#33).
 */
export const MAX_LIMIT_PAUSE_MS = 6 * 60 * 60_000;

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
  // Only the phrase's OWN line. Earlier output is not ours, and neither is a
  // later "resets …" line — a role writing about this very code produces one,
  // and borrowing its time would pause the daemon for hours (#33).
  const [line = ""] = output.slice(hit.index).split(/\r?\n/, 1);
  const tail = RESET_RE.exec(line)?.[1]?.trim();
  if (!tail) return {};
  // Keep only the clock (and its zone): box-drawing and stray words from the
  // CLI's own framing must not ride along into the founder's notice (#33).
  // Nothing clock-shaped at all — keep the words, they still tell us something.
  const clock = CLOCK_RE.exec(tail)?.[0]?.trim();
  const at = parseResetAt(tail, now);
  return {
    limitResetText: clock || tail,
    ...(at === undefined ? {} : { limitResetAt: new Date(at).toISOString() }),
  };
}

/**
 * "1pm (Europe/Amsterdam)" → the epoch ms of the next 13:00 in that zone.
 *
 * Wall-clock arithmetic inside the zone via `Intl` (Node 20 ships full ICU —
 * no new dependency): the distance from what the clock reads there now to
 * what it must read, wrapping to tomorrow only when that time is well behind
 * us. Anything it cannot read with confidence — no clock, an hour out of
 * range, no zone, an unknown zone — returns undefined and the caller falls
 * back to its blind retry, which costs minutes instead of hours.
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

  // No zone printed → no instant. Guessing the host's zone can be hours off,
  // and hours of silence is worse than a 15-minute blind retry (#33).
  const zone = m[4]?.trim();
  if (!zone) return undefined;
  const nowSeconds = wallClockSeconds(now, zone);
  if (nowSeconds === undefined) return undefined;
  let delta = hour * 3600 + minute * 60 - nowSeconds;
  if (delta < 0) {
    // Just past → it is lifting about now; let the caller's short fallback
    // find out. Only a reset well behind us means the same time tomorrow.
    if (delta > -RESET_GRACE_SECONDS) return undefined;
    delta += DAY_MS / 1000;
  }
  return now + delta * 1000;
}

/** Seconds since midnight on `zone`'s wall clock. */
function wallClockSeconds(at: number, zone: string): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: zone,
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
 * both ends — never hammer, never stall past a session window.
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
