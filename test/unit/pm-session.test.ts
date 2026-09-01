import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadPmSession,
  loadPmSessionId,
  mtimesUnchanged,
  resetPmSession,
  savePmSessionId,
  watchedFileMtimes,
} from "../../src/core/pm-session.js";

function tmpFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fh-pmsession-"));
  return path.join(dir, "session.json");
}

describe("pm-session", () => {
  it("round-trips a session id through save/load", () => {
    const file = tmpFile();
    savePmSessionId(file, "sess-1");
    expect(loadPmSessionId(file)).toBe("sess-1");

    savePmSessionId(file, "sess-2");
    expect(loadPmSessionId(file)).toBe("sess-2");

    const raw = JSON.parse(readFileSync(file, "utf8")) as { sessionId: string; updatedAt: string };
    expect(raw.sessionId).toBe("sess-2");
    expect(raw.updatedAt).toBeTruthy();
  });

  it("returns undefined when no session was ever saved", () => {
    expect(loadPmSessionId(tmpFile())).toBeUndefined();
  });

  it("returns undefined instead of throwing on a corrupt session file", () => {
    const file = tmpFile();
    writeFileSync(file, "{not json", "utf8");
    expect(loadPmSessionId(file)).toBeUndefined();
  });

  it("reset clears both the file and its .bak, and is a safe no-op when nothing exists", () => {
    const file = tmpFile();
    savePmSessionId(file, "sess-1");
    savePmSessionId(file, "sess-2"); // second write produces a .bak
    resetPmSession(file);
    expect(loadPmSessionId(file)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.bak`)).toBe(false);

    // Calling it again with nothing left on disk must not throw.
    expect(() => resetPmSession(file)).not.toThrow();
  });

  it("round-trips watchedMtimes alongside the session id", () => {
    const file = tmpFile();
    savePmSessionId(file, "sess-1", { a: 111, b: 222 });
    expect(loadPmSession(file)?.watchedMtimes).toEqual({ a: 111, b: 222 });

    // Omitting the third arg defaults to an empty map, not the previous one.
    savePmSessionId(file, "sess-2");
    expect(loadPmSession(file)?.watchedMtimes).toEqual({});
  });
});

describe("watchedFileMtimes", () => {
  it("reports 0 for a missing file instead of throwing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fh-watchfiles-"));
    const missing = path.join(dir, "nope.md");
    expect(watchedFileMtimes({ x: missing })).toEqual({ x: 0 });
  });

  it("reports the file's real mtime, keyed by the caller's label", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fh-watchfiles-"));
    const file = path.join(dir, "a.md");
    writeFileSync(file, "hi", "utf8");
    const stamp = new Date(2026, 0, 1, 12, 0, 0);
    utimesSync(file, stamp, stamp);
    expect(watchedFileMtimes({ a: file }).a).toBeCloseTo(stamp.getTime(), -2);
  });
});

describe("mtimesUnchanged", () => {
  it("is false when nothing was stored yet (first turn of a session)", () => {
    expect(mtimesUnchanged({ a: 1 }, undefined)).toBe(false);
  });

  it("is true only when every watched mtime matches exactly", () => {
    expect(mtimesUnchanged({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(mtimesUnchanged({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
  });

  it("is false when the watched-file set itself changed (e.g. a role added/removed)", () => {
    expect(mtimesUnchanged({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });
});
