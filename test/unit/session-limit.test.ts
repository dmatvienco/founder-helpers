import { describe, expect, it } from "vitest";
import {
  detectSessionLimit,
  limitPauseMs,
  parseResetAt,
  MAX_LIMIT_PAUSE_MS,
  RESET_MARGIN_MS,
} from "../../src/runner/session-limit.js";

/** The 2026-09-07 incident's own clock: 07:24:53Z = 09:24:53 in Amsterdam (CEST). */
const INCIDENT = Date.parse("2026-09-07T07:24:53.000Z");

const iso = (ms: number | undefined): string | undefined =>
  ms === undefined ? undefined : new Date(ms).toISOString();

/** The CLI's line, byte-identical to the 2026-09-07 and 2026-09-08 samples. */
const limitLine = (tail = ""): string => `You've hit your session limit${tail}`;

describe("parseResetAt", () => {
  it("resolves a 12-hour time in an IANA zone to the next matching instant", () => {
    // 1pm Amsterdam in September is CEST (UTC+2) -> 11:00Z, the reset the
    // daemon waited 14 extra minutes past in the incident.
    expect(iso(parseResetAt("1pm (Europe/Amsterdam)", INCIDENT))).toBe("2026-09-07T11:00:00.000Z");
  });

  it("handles minutes and UTC", () => {
    expect(iso(parseResetAt("11:30am (UTC)", INCIDENT))).toBe("2026-09-07T11:30:00.000Z");
  });

  it("reads a 24-hour clock without a meridiem", () => {
    expect(iso(parseResetAt("13:05 (UTC)", INCIDENT))).toBe("2026-09-07T13:05:00.000Z");
  });

  it("rolls over to tomorrow when the time is already past there", () => {
    const lateNight = Date.parse("2026-09-07T22:10:00.000Z");
    expect(iso(parseResetAt("9pm (UTC)", lateNight))).toBe("2026-09-08T21:00:00.000Z");
    // Amsterdam is two hours ahead: it is already 00:10 on the 8th there, so
    // 9pm is later the same (local) day, not a full 24h away.
    expect(iso(parseResetAt("9pm (Europe/Amsterdam)", lateNight))).toBe("2026-09-08T19:00:00.000Z");
  });

  it("treats a reset that has only just passed as 'about now', not tomorrow", () => {
    // 13:01 in Amsterdam. We deliberately retry at reset + RESET_MARGIN_MS and
    // the CLI prints the hour rounded, so the retry re-reads the same "1pm".
    // Rolling that to tomorrow is how one notice became a day of silence (#33).
    const justPast = Date.parse("2026-09-07T11:01:00.000Z");
    expect(parseResetAt("1pm (Europe/Amsterdam)", justPast)).toBeUndefined();
  });

  it("still rolls to tomorrow once the reset is well behind us", () => {
    const wellPast = Date.parse("2026-09-07T13:00:00.000Z"); // 15:00 in Amsterdam
    expect(iso(parseResetAt("1pm (Europe/Amsterdam)", wellPast))).toBe("2026-09-08T11:00:00.000Z");
  });

  it("refuses a clock with no zone — the host's zone can be hours off", () => {
    expect(parseResetAt("1pm", INCIDENT)).toBeUndefined();
    expect(parseResetAt("11:30am", INCIDENT)).toBeUndefined();
    expect(parseResetAt("13:05", INCIDENT)).toBeUndefined();
  });

  it("refuses anything it cannot read with confidence", () => {
    expect(parseResetAt("soon", INCIDENT)).toBeUndefined();
    expect(parseResetAt("", INCIDENT)).toBeUndefined();
    expect(parseResetAt("tomorrow morning", INCIDENT)).toBeUndefined();
    expect(parseResetAt("25:00 (UTC)", INCIDENT)).toBeUndefined(); // hour out of range
    expect(parseResetAt("13pm (UTC)", INCIDENT)).toBeUndefined(); // 12-hour clock, 13 o'clock
    expect(parseResetAt("1:70pm (UTC)", INCIDENT)).toBeUndefined(); // minute out of range
    expect(parseResetAt("1pm (Mars/Olympus)", INCIDENT)).toBeUndefined(); // unknown zone
  });
});

describe("detectSessionLimit", () => {
  it("captures the phrase and the reset that rides with it", () => {
    const limit = detectSessionLimit(
      "…\nYou've hit your session limit · resets 1pm (Europe/Amsterdam)\n",
      INCIDENT,
    );
    expect(limit?.limitResetText).toBe("1pm (Europe/Amsterdam)");
    expect(limit?.limitResetAt).toBe("2026-09-07T11:00:00.000Z");
  });

  it("still reports the limit when no reset time is printed", () => {
    const limit = detectSessionLimit("You've hit your session limit.", INCIDENT);
    expect(limit).toBeDefined();
    expect(limit?.limitResetText).toBeUndefined();
    expect(limit?.limitResetAt).toBeUndefined();
  });

  it("keeps the text but no instant when the reset is unparseable", () => {
    const limit = detectSessionLimit("You've hit your session limit · resets later", INCIDENT);
    expect(limit?.limitResetText).toBe("later");
    expect(limit?.limitResetAt).toBeUndefined();
  });

  it("ignores a 'resets' that appears before the phrase — that is not this run's reset", () => {
    const limit = detectSessionLimit(
      "the docs say the counter resets 4am (UTC)\nYou've hit your session limit.",
      INCIDENT,
    );
    expect(limit).toBeDefined();
    expect(limit?.limitResetText).toBeUndefined();
  });

  it("ignores a 'resets' on a LATER line — only the phrase's own line is ours", () => {
    // A role run writing about this very code prints such a line; borrowing
    // its time used to cost the whole clamp instead of one blind retry (#33).
    const limit = detectSessionLimit(
      `${limitLine(".")}\nthe issue says it resets 1pm (Europe/Amsterdam)\n`,
      INCIDENT,
    );
    expect(limit).toBeDefined();
    expect(limit?.limitResetText).toBeUndefined();
    expect(limit?.limitResetAt).toBeUndefined();
  });

  it("does pick it up on the phrase's own line, CRLF included", () => {
    const limit = detectSessionLimit(
      `${limitLine(" · resets 1pm (Europe/Amsterdam)")}\r\nnext line\r\n`,
      INCIDENT,
    );
    expect(limit?.limitResetText).toBe("1pm (Europe/Amsterdam)");
    expect(limit?.limitResetAt).toBe("2026-09-07T11:00:00.000Z");
  });

  it("keeps only the clock, not the CLI's framing around it", () => {
    const limit = detectSessionLimit(
      limitLine(" · resets 1pm (Europe/Amsterdam) [0m │ press ctrl-c"),
      INCIDENT,
    );
    expect(limit?.limitResetText).toBe("1pm (Europe/Amsterdam)");
  });

  it("waits the blind fallback when the announced reset has just passed", () => {
    const justPast = Date.parse("2026-09-07T11:01:00.000Z"); // 13:01 in Amsterdam
    const limit = detectSessionLimit(limitLine(" · resets 1pm (Europe/Amsterdam)"), justPast);
    expect(limit?.limitResetText).toBe("1pm (Europe/Amsterdam)"); // founder still gets the time
    expect(limit?.limitResetAt).toBeUndefined();
    expect(limitPauseMs(limit?.limitResetAt, justPast, 15 * 60_000)).toBe(15 * 60_000);
  });

  it("returns undefined for output without the phrase", () => {
    expect(detectSessionLimit("all good, resets 1pm (UTC)", INCIDENT)).toBeUndefined();
  });
});

describe("limitPauseMs", () => {
  const fallback = 15 * 60_000;

  it("uses the blind fallback when nothing was parsed", () => {
    expect(limitPauseMs(undefined, INCIDENT, fallback)).toBe(fallback);
    expect(limitPauseMs("not a date", INCIDENT, fallback)).toBe(fallback);
  });

  it("waits until the reset plus a margin", () => {
    const at = new Date(INCIDENT + 3 * 60 * 60_000).toISOString();
    expect(limitPauseMs(at, INCIDENT, fallback)).toBe(3 * 60 * 60_000 + RESET_MARGIN_MS);
  });

  it("never retries instantly on an already-past reset, and never stalls past a window", () => {
    const past = new Date(INCIDENT - 60 * 60_000).toISOString();
    expect(limitPauseMs(past, INCIDENT, fallback)).toBe(RESET_MARGIN_MS);
    const absurd = new Date(INCIDENT + 30 * 24 * 60 * 60_000).toISOString();
    expect(limitPauseMs(absurd, INCIDENT, fallback)).toBe(MAX_LIMIT_PAUSE_MS);
  });

  it("caps at a session window, not a day — limits last five hours", () => {
    expect(MAX_LIMIT_PAUSE_MS).toBe(6 * 60 * 60_000);
    const tomorrow = new Date(INCIDENT + 23 * 60 * 60_000).toISOString();
    expect(limitPauseMs(tomorrow, INCIDENT, fallback)).toBe(MAX_LIMIT_PAUSE_MS);
  });
});
