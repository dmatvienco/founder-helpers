import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPmSessionId, resetPmSession, savePmSessionId } from "../../src/core/pm-session.js";

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
});
