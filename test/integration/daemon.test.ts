import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { startDaemon, type DaemonHandle, type DaemonOptions } from "../../src/core/daemon.js";
import { TelegramTransport } from "../../src/transport/telegram.js";
import { addJob, loadQueue } from "../../src/core/queue.js";
import { MockRunner, type MockScenario } from "../../src/runner/mock-runner.js";
import { statePaths } from "../../src/state/paths.js";
import { saveSecrets } from "../../src/state/secrets.js";
import { startMockTelegram, until, type MockTelegram } from "../helpers/mock-telegram.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

interface Env {
  repo: string;
  stateBase: string;
  server: MockTelegram;
  sp: ReturnType<typeof statePaths>;
}

async function makeEnv(): Promise<Env> {
  const repo = mkdtempSync(path.join(tmpdir(), "fh-daemon-"));
  const stateBase = mkdtempSync(path.join(tmpdir(), "fh-dstate-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], { stdio: "ignore" });
  runInit(repo, { stateBase });
  const sp = statePaths(repo, { stateBase });
  saveSecrets(sp, { telegram: { botToken: "TEST", chatId: 42 } });
  const server = await startMockTelegram();
  cleanups.push(() => server.close());
  return { repo, stateBase, server, sp };
}

async function boot(
  env: Env,
  scenarios: MockScenario[],
  extra: Partial<DaemonOptions> = {},
): Promise<DaemonHandle> {
  const transport = new TelegramTransport({
    botToken: "TEST",
    chatId: 42,
    stateFile: env.sp.transportStateFile,
    apiBase: env.server.url,
    pollTimeoutSec: 0,
    errorSleepMs: 50,
    typingIntervalMs: 60,
  });
  const handle = await startDaemon(env.repo, {
    pathsOpts: { stateBase: env.stateBase },
    runner: new MockRunner(scenarios, env.sp.root),
    workerIntervalMs: 50,
    limitRetryMs: 60_000,
    transport,
    ...extra,
  });
  cleanups.push(() => handle.stop());
  return handle;
}

describe("daemon E2E (mock runner + mock telegram)", () => {
  it('full chain: "да 1" -> PM queues issue -> dev+reviewer -> completion carries the verdict', async () => {
    const env = await makeEnv();
    const queueContent = JSON.stringify({
      jobs: [
        {
          id: "job-e2e-7",
          kind: "issue",
          issue: 7,
          base: "main",
          addedAt: new Date().toISOString(),
        },
      ],
    });
    await boot(env, [
      {
        role: "pm",
        writeFiles: [
          { path: "outbox/reply.txt", content: "Принял: ставлю #7 в работу прямо сейчас." },
          // Simulates the PM's `fh queue add --issue 7` CLI call.
          { path: "queue.json", content: queueContent },
        ],
      },
      {
        role: "dev",
        writeFiles: [{ path: "dev/report-issue7.md", content: "# report\nsmoke: done" }],
      },
      {
        role: "reviewer",
        writeFiles: [
          { path: "dev/review-issue7.md", content: "✅ можно мержить\n\nвсё чисто" },
        ],
      },
    ]);

    env.server.pushUpdate("да 1");

    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("Принял")),
      10000,
      "PM reply",
    );
    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("✅ можно мержить")),
      10000,
      "completion with verdict",
    );

    const completion = env.server.sentMessages.find((m) => m.text.includes("✅ можно мержить"));
    expect(completion?.text).toContain("issue #7");
    // Post-conditions caught the truth: mock dev never pushed a branch.
    expect(completion?.text).toContain("not found on origin");
    // Attempted job is removed from the queue.
    expect(loadQueue(env.sp.queueFile).jobs).toEqual([]);
    // Typing indicator was actually used. sendChatAction is fire-and-forget
    // (see setTyping in src/transport/telegram.ts), so its HTTP round trip
    // can still be in flight after the completion message lands — poll
    // instead of asserting synchronously (#15).
    await until(() => env.server.chatActions > 0, 2000, "typing indicator tick");
  });

  it("job stays in the queue until its chain completes (crash-safe), then is removed", async () => {
    const env = await makeEnv();
    await boot(env, [
      {
        role: "dev",
        delayMs: 600,
        writeFiles: [{ path: "dev/report-issue9.md", content: "r" }],
      },
      {
        role: "reviewer",
        writeFiles: [{ path: "dev/review-issue9.md", content: "⚠️ можно с оговорками" }],
      },
    ]);
    addJob(env.sp.queueFile, { kind: "issue", issue: 9, base: "main" });

    // Mid-run: the job must still be in queue.json (a crash here = rerun, not loss).
    await new Promise((r) => setTimeout(r, 300));
    expect(loadQueue(env.sp.queueFile).jobs.length).toBe(1);

    await until(() => loadQueue(env.sp.queueFile).jobs.length === 0, 10000, "job completion");
    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("⚠️ можно с оговорками")),
      5000,
      "completion message",
    );
  });

  it("second daemon instance dies loudly on the lock", async () => {
    const env = await makeEnv();
    await boot(env, []);
    await expect(
      startDaemon(env.repo, { pathsOpts: { stateBase: env.stateBase } }),
    ).rejects.toThrow(/Another daemon appears to be running/);
  });

  it("restart-in-place recovers once a dead holder's lock goes stale, without waiting for it", async () => {
    const env = await makeEnv();

    // Spawn (and let exit) a throwaway process first, so its pid is
    // guaranteed dead before the timing-sensitive part of the test starts.
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);

    // Simulate a previous daemon that never released its lock (e.g. a hard
    // `taskkill`/SIGKILL that skipped graceful cleanup): the lock directory
    // exists and is fresh (mtime "now"), and its heartbeat still names a
    // pid — but that pid is dead.
    const lockfilePath = path.join(env.sp.root, "daemon.lock");
    mkdirSync(lockfilePath);
    const now = new Date();
    utimesSync(lockfilePath, now, now);
    writeFileSync(
      path.join(env.sp.root, "heartbeat.json"),
      JSON.stringify({ pid: dead.pid, at: now.toISOString() }),
      "utf8",
    );

    const logs: string[] = [];
    const logger = {
      debug: () => {},
      warn: () => {},
      error: () => {},
      info: (msg: string) => logs.push(msg),
      file: "",
    };

    // proper-lockfile floors `stale` at 2000ms internally regardless of what
    // we pass, so the retry budget below must clear that real floor.
    const handle = await boot(env, [], {
      lockStaleMs: 2_000,
      lockRetries: { retries: 10, minTimeout: 250, maxTimeout: 400 },
      logger,
    });

    expect(handle.paths.root).toBe(env.sp.root);
    expect(logs.some((l) => l.includes("waiting for the previous daemon's lock to expire"))).toBe(
      true,
    );
  }, 15000);

  it("second daemon dies loudly immediately even with retries configured, while the first is alive", async () => {
    const env = await makeEnv();
    await boot(env, []);
    const start = Date.now();
    await expect(
      startDaemon(env.repo, {
        pathsOpts: { stateBase: env.stateBase },
        lockStaleMs: 300,
        lockRetries: { retries: 5, minTimeout: 50, maxTimeout: 100 },
      }),
    ).rejects.toThrow(/Another daemon appears to be running/);
    // No retry wait: the heartbeat shows the holder alive, so this must fail
    // as fast as the original single-attempt check did.
    expect(Date.now() - start).toBeLessThan(300);
  });

  it("session limit pauses the job with retryAt and notifies once", async () => {
    const env = await makeEnv();
    await boot(env, [
      { role: "dev", stdout: "You've hit your session limit until 7pm." },
    ]);
    addJob(env.sp.queueFile, { kind: "issue", issue: 5, base: "main" });

    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("⏳")),
      10000,
      "limit notification",
    );
    const q = loadQueue(env.sp.queueFile);
    expect(q.jobs.length).toBe(1); // stays queued
    expect(q.jobs[0]?.retryAt).toBeDefined(); // backs off instead of hammering
    // give the worker a few more ticks: no duplicate notifications
    await new Promise((r) => setTimeout(r, 300));
    expect(env.server.sentMessages.filter((m) => m.text.includes("⏳")).length).toBe(1);
  });

  it("reply lane: 3 failed composes -> honest apology, offset advances, next message works", async () => {
    const env = await makeEnv();
    // PM scenario writes NO outbox -> every attempt "fails".
    await boot(env, [{ role: "pm", stdout: "confused" }], { replyMaxAttempts: 3 });

    env.server.pushUpdate("это сообщение потеряется?");
    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("Skipping it")),
      15000,
      "honest apology",
    );
    expect(
      env.server.sentMessages.filter((m) => m.text.includes("Skipping it")).length,
    ).toBe(1);
  });
});
