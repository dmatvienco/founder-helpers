import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataBase, projectId, statePaths } from "../../src/state/paths.js";

describe("projectId", () => {
  it("is stable for the same directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fh-paths-"));
    expect(projectId(dir)).toBe(projectId(dir));
  });

  it("differs for two directories with the same basename", () => {
    const a = mkdtempSync(path.join(tmpdir(), "fh-same-"));
    const b = mkdtempSync(path.join(tmpdir(), "fh-same-"));
    expect(projectId(a)).not.toBe(projectId(b));
  });

  it("produces a readable slug", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "My Project-"));
    expect(projectId(dir)).toMatch(/^my-project-.*-[0-9a-f]{8}$/);
  });
});

describe("dataBase", () => {
  it("honors an explicit stateBase override", () => {
    expect(dataBase({ stateBase: "/x/y" })).toBe("/x/y");
  });

  it("honors FH_STATE_DIR", () => {
    expect(dataBase({ env: { FH_STATE_DIR: "/env/dir" } })).toBe("/env/dir");
  });

  it("picks per-OS defaults", () => {
    const home = path.join("home", "u");
    expect(dataBase({ platform: "linux", env: {}, home })).toBe(
      path.join(home, ".local", "share", "founder-helpers"),
    );
    expect(dataBase({ platform: "darwin", env: {}, home })).toBe(
      path.join(home, "Library", "Application Support", "founder-helpers"),
    );
    expect(dataBase({ platform: "win32", env: {}, home })).toBe(
      path.join(home, "AppData", "Local", "founder-helpers"),
    );
    expect(dataBase({ platform: "linux", env: { XDG_DATA_HOME: "/xdg" }, home })).toBe(
      path.join("/xdg", "founder-helpers"),
    );
  });
});

describe("statePaths", () => {
  it("lays out the expected structure under base/projectId", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fh-sp-"));
    const sp = statePaths(dir, { stateBase: "/base" });
    expect(sp.root).toBe(path.join("/base", projectId(dir)));
    expect(sp.queueFile).toBe(path.join(sp.root, "queue.json"));
    expect(sp.logsDir).toBe(path.join(sp.root, "logs"));
  });
});
