import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addJob, loadQueue, setStage } from "../../src/core/queue.js";

function tmpFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fh-queue-"));
  return path.join(dir, "queue.json");
}

describe("queue", () => {
  it("a queue.json written before #34 (no stage field) still loads", () => {
    const file = tmpFile();
    writeFileSync(
      file,
      JSON.stringify({
        jobs: [{ id: "job-1", kind: "issue", issue: 7, addedAt: new Date().toISOString() }],
      }),
      "utf8",
    );
    expect(loadQueue(file).jobs).toEqual([
      { id: "job-1", kind: "issue", issue: 7, addedAt: expect.any(String) },
    ]);
  });

  it("setStage persists a job's stage, leaving other jobs untouched", () => {
    const file = tmpFile();
    const a = addJob(file, { kind: "issue", issue: 7, base: "main" });
    const b = addJob(file, { kind: "issue", issue: 8, base: "main" });

    setStage(file, a.id, "review");

    const jobs = loadQueue(file).jobs;
    expect(jobs.find((j) => j.id === a.id)?.stage).toBe("review");
    expect(jobs.find((j) => j.id === b.id)?.stage).toBeUndefined();
  });

  it("setStage on an unknown id is a safe no-op", () => {
    const file = tmpFile();
    addJob(file, { kind: "issue", issue: 7, base: "main" });
    expect(() => setStage(file, "does-not-exist", "review")).not.toThrow();
  });
});
