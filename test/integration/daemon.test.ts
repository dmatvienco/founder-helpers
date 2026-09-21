import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { startDaemon, type DaemonHandle, type DaemonOptions } from "../../src/core/daemon.js";
import { TelegramTransport } from "../../src/transport/telegram.js";
import { addJob, loadQueue, saveQueue } from "../../src/core/queue.js";
import {
  loadPmSession,
  loadPmSessionId,
  resetPmSession,
  savePmSessionId,
} from "../../src/core/pm-session.js";
import { MockRunner, type MockScenario } from "../../src/runner/mock-runner.js";
import { statePaths } from "../../src/state/paths.js";
import { saveSecrets } from "../../src/state/secrets.js";
import { packageVersion } from "../../src/util/version-check.js";
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
    imagesDir: env.sp.imagesDir,
    apiBase: env.server.url,
    pollTimeoutSec: 0,
    errorSleepMs: 50,
    typingIntervalMs: 60,
    progressIntervalMs: 30,
  });
  const handle = await startDaemon(env.repo, {
    pathsOpts: { stateBase: env.stateBase },
    runner: new MockRunner(scenarios, env.sp.root),
    workerIntervalMs: 50,
    limitRetryMs: 60_000,
    transport,
    // Never the real npm registry from a test; #39's own tests override this.
    versionFetch: () => Promise.reject(new Error("offline")),
    ...extra,
  });
  cleanups.push(() => handle.stop());
  return handle;
}

/** Session-limit stdout naming a reset `ms` from now, formatted like the CLI's. */
function limitStdout(ms: number): string {
  const at = new Date(Date.now() + ms);
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `You've hit your session limit · resets ${hh}:${mm} (UTC)`;
}

/**
 * Simulates a dev run that genuinely pushed: a real bare "origin" remote with
 * `branch` on it, so the worker's `branchOnOrigin` post-condition check finds
 * it (MockRunner itself never touches git — it only writes files).
 */
function pushBranchToOrigin(repo: string, branch: string): void {
  const bare = mkdtempSync(path.join(tmpdir(), "fh-origin-"));
  execFileSync("git", ["init", "--bare", "-q", bare], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", bare], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.test"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "checkout", "-b", branch], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "push", "origin", branch], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "checkout", "-"], { stdio: "ignore" });
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
        writeFiles: [{ path: "dev/review-issue7.md", content: "✅ можно мержить\n\nвсё чисто" }],
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
    // The PM's reply-mode run opened a live-progress message instead of the
    // old typing indicator (#20) — startProgress's sendMessage is awaited,
    // so it's already recorded by the time the PM reply itself lands.
    expect(env.server.sentMessages.some((m) => m.text.includes("working on it"))).toBe(true);
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

  it("reply-mode progress: opens one message and edits it with tool-use lines, replacing the typing indicator (#20)", async () => {
    const env = await makeEnv();
    await boot(env, [
      {
        role: "pm",
        progressEvents: [
          { text: "reading src/x.ts", delayMs: 40 },
          { text: "running tests", delayMs: 40 },
        ],
        writeFiles: [{ path: "outbox/reply.txt", content: "готово" }],
      },
    ]);

    env.server.pushUpdate("сделай штуку");

    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("готово")),
      10000,
      "reply",
    );
    // One progress message opened via sendMessage (never the reply text itself)...
    expect(env.server.sentMessages.some((m) => m.text.includes("working on it"))).toBe(true);
    // ...then edited in place with coalesced tool-use lines, not one edit per event.
    await until(() => env.server.edits.length > 0, 3000, "progress edit");
    expect(
      env.server.edits.some(
        (e) => e.text.includes("reading src/x.ts") || e.text.includes("running tests"),
      ),
    ).toBe(true);
    expect(env.server.edits.every((e) => !e.text.includes("готово"))).toBe(true);
  });

  it("reply lane resumes the PM's saved session id and persists the new one after each reply (#session)", async () => {
    const env = await makeEnv();
    savePmSessionId(env.sp.pmSessionFile, "sess-old");
    const runner = new MockRunner(
      [
        {
          role: "pm",
          writeFiles: [{ path: "outbox/reply.txt", content: "ответ" }],
          sessionId: "sess-new",
        },
      ],
      env.sp.root,
    );
    await boot(env, [], { runner });

    env.server.pushUpdate("привет");
    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("ответ")),
      10000,
      "reply",
    );

    expect(runner.calls[0]?.resumeSessionId).toBe("sess-old");
    expect(loadPmSessionId(env.sp.pmSessionFile)).toBe("sess-new");
  });

  it("an `fh session reset` mid-run is honored, not immediately undone by the post-run save (#session)", async () => {
    const env = await makeEnv();
    savePmSessionId(env.sp.pmSessionFile, "sess-old");
    const runner = new MockRunner(
      [
        {
          role: "pm",
          delayMs: 80,
          writeFiles: [{ path: "outbox/reply.txt", content: "начинаем с чистого листа" }],
          // The CLI still reports the session it was resumed on — the reset
          // happened as a *side effect* mid-run (the PM's own `fh session
          // reset` Bash call), not as a different reported session id.
          sessionId: "sess-old",
        },
      ],
      env.sp.root,
    );
    await boot(env, [], { runner });

    // Fires mid-run, simulating the PM's own `fh session reset` Bash call.
    setTimeout(() => resetPmSession(env.sp.pmSessionFile), 20);

    env.server.pushUpdate("забудь всё");
    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("начинаем с чистого листа")),
      10000,
      "reply",
    );

    expect(loadPmSessionId(env.sp.pmSessionFile)).toBeUndefined();
  });

  it("sends the full prompt on session start and after an external edit, trimmed otherwise (#trim)", async () => {
    const env = await makeEnv();
    const runner = new MockRunner(
      [
        {
          role: "pm",
          writeFiles: [{ path: "outbox/reply.txt", content: "ответ" }],
          sessionId: "sess-trim",
        },
      ],
      env.sp.root,
    );
    await boot(env, [], { runner });
    const sessionFile = env.sp.pmSessionFile;

    // Turn 1: no session yet — must be full.
    env.server.pushUpdate("привет 1");
    await until(() => loadPmSession(sessionFile) !== undefined, 10000, "turn 1 session saved");
    let session = loadPmSession(sessionFile);
    expect(runner.calls).toHaveLength(1);
    expect(readFileSync(path.join(runner.calls[0]!.runDir, "prompt.md"), "utf8")).toContain(
      "Project profile",
    );

    // Turn 2: same session, nothing on disk changed — must be trimmed.
    env.server.pushUpdate("привет 2");
    await until(
      () => loadPmSession(sessionFile)?.updatedAt !== session?.updatedAt,
      10000,
      "turn 2 session saved",
    );
    session = loadPmSession(sessionFile);
    expect(runner.calls).toHaveLength(2);
    const prompt2 = readFileSync(path.join(runner.calls[1]!.runDir, "prompt.md"), "utf8");
    expect(prompt2).not.toContain("Project profile");
    expect(prompt2).toContain("Run context");

    // An external edit between turns — must force a full resend on turn 3,
    // not just silently keep trusting the resumed session's stale memory.
    utimesSync(
      path.join(env.repo, ".founder-helpers", "profile.md"),
      new Date(),
      new Date(Date.now() + 5000),
    );

    env.server.pushUpdate("привет 3");
    await until(
      () => loadPmSession(sessionFile)?.updatedAt !== session?.updatedAt,
      10000,
      "turn 3 session saved",
    );
    expect(runner.calls).toHaveLength(3);
    expect(readFileSync(path.join(runner.calls[2]!.runDir, "prompt.md"), "utf8")).toContain(
      "Project profile",
    );
  });

  describe("newer version on npm (#39)", () => {
    const installed = packageVersion();
    const newer = `${Number(installed.split(".")[0]) + 1}.0.0`;
    const notice = (env: Env): string[] =>
      env.server.sentMessages.filter((m) => m.text.includes("on npm")).map((m) => m.text);

    function registry(latest: string) {
      return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ latest })));
    }

    it("sends the one-liner to Telegram, once per process", async () => {
      const env = await makeEnv();
      const versionFetch = registry(newer);
      await boot(env, [], { versionFetch });

      await until(() => notice(env).length > 0, 10000, "version notice");
      expect(notice(env)).toEqual([
        `founder-helpers ${installed} installed, ${newer} on npm — npm update -g founder-helpers + restart`,
      ]);
      // Worker and transport keep ticking; the check must not come back.
      await new Promise((r) => setTimeout(r, 300));
      expect(notice(env)).toHaveLength(1);
      expect(versionFetch).toHaveBeenCalledTimes(1);
    });

    it("does not delay startup: boot returns while the registry is still silent", async () => {
      const env = await makeEnv();
      let answer: (res: Response) => void = () => {};
      const versionFetch = vi.fn<typeof fetch>(
        () => new Promise<Response>((resolve) => (answer = resolve)),
      );
      const started = Date.now();
      await boot(env, [], { versionFetch });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(notice(env)).toEqual([]);

      // The chat lane is live while the check hangs.
      env.server.pushUpdate("привет");
      await until(() => env.server.sentMessages.length > 0, 10000, "daemon keeps working");

      // Once the registry finally answers, the notice still goes out.
      answer(new Response(JSON.stringify({ latest: newer })));
      await until(() => notice(env).length === 1, 10000, "late version notice");
    });

    it("stays silent when npm has the installed version", async () => {
      const env = await makeEnv();
      const versionFetch = registry(installed);
      await boot(env, [], { versionFetch });
      await until(() => versionFetch.mock.calls.length > 0, 10000, "registry asked");
      await new Promise((r) => setTimeout(r, 300));
      expect(notice(env)).toEqual([]);
    });

    it.each([
      ["offline", () => Promise.reject(new TypeError("fetch failed"))],
      ["a 503", async () => new Response("down", { status: 503 })],
      ["garbage", async () => new Response("<html>", { status: 200 })],
    ])("startup is unaffected and nothing is sent when the registry is %s", async (_n, respond) => {
      const env = await makeEnv();
      const versionFetch = vi.fn<typeof fetch>(respond);
      const logs: { level: string; msg: string }[] = [];
      const at = (level: string) => (msg: string) => logs.push({ level, msg });
      const logger = {
        debug: at("debug"),
        info: at("info"),
        warn: at("warn"),
        error: at("error"),
        file: "",
      };
      await boot(env, [], { versionFetch, logger });
      await until(() => versionFetch.mock.calls.length > 0, 10000, "registry asked");
      await new Promise((r) => setTimeout(r, 200));

      expect(notice(env)).toEqual([]);
      // Nothing louder than debug: no warn/error line mentions the check.
      expect(
        logs.filter((l) => (l.level === "warn" || l.level === "error") && /version/i.test(l.msg)),
      ).toEqual([]);
      // ...and the daemon is fully alive.
      env.server.pushUpdate("привет");
      await until(() => env.server.sentMessages.length > 0, 10000, "daemon still answers");
    });

    it("a failing Telegram send is swallowed at debug level", async () => {
      const env = await makeEnv();
      const logs: { level: string; msg: string }[] = [];
      const at = (level: string) => (msg: string) => logs.push({ level, msg });
      const logger = {
        debug: at("debug"),
        info: at("info"),
        warn: at("warn"),
        error: at("error"),
        file: "",
      };
      const transport = {
        start: () => {},
        stop: async () => {},
        send: vi.fn(async () => {
          throw new Error("telegram down");
        }),
        sendPhoto: async () => {},
        setTyping: () => {},
        startProgress: async () => {},
        updateProgress: () => {},
        endProgress: () => {},
      };
      await boot(env, [], { versionFetch: registry(newer), logger, transport });
      await until(() => transport.send.mock.calls.length > 0, 10000, "send attempted");
      await until(
        () => logs.some((l) => l.level === "debug" && l.msg.includes("telegram down")),
        5000,
        "debug line",
      );
      expect(logs.filter((l) => l.level === "warn" || l.level === "error")).toEqual([]);
    });

    it("caches the registry's answer in the state dir", async () => {
      const env = await makeEnv();
      await boot(env, [], { versionFetch: registry(newer) });
      await until(() => notice(env).length > 0, 10000, "version notice");
      expect(JSON.parse(readFileSync(env.sp.versionCheckFile, "utf8"))).toMatchObject({
        latest: newer,
      });
    });

    it("a daemon stopped before the registry answers sends nothing", async () => {
      const env = await makeEnv();
      let answer: (res: Response) => void = () => {};
      const versionFetch = vi.fn<typeof fetch>(
        () => new Promise<Response>((resolve) => (answer = resolve)),
      );
      const handle = await boot(env, [], { versionFetch });
      await handle.stop();
      answer(new Response(JSON.stringify({ latest: newer })));
      await new Promise((r) => setTimeout(r, 200));
      expect(notice(env)).toEqual([]);
    });
  });

  it("records the version it started with in the heartbeat (#41)", async () => {
    const env = await makeEnv();
    await boot(env, []);
    const hb = JSON.parse(readFileSync(path.join(env.sp.root, "heartbeat.json"), "utf8"));
    expect(hb).toMatchObject({ pid: process.pid, version: packageVersion() });
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
    await boot(env, [{ role: "dev", stdout: "You've hit your session limit until 7pm." }]);
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

  it("session limit with a reset time waits for the reset, not the blind fallback (#30)", async () => {
    const env = await makeEnv();
    // A 100ms fallback: if the reset were ignored, the job would retry ~10x/s.
    await boot(env, [{ role: "dev", stdout: limitStdout(3 * 60 * 60_000) }], { limitRetryMs: 100 });
    addJob(env.sp.queueFile, { kind: "issue", issue: 5, base: "main" });

    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("⏳")),
      10000,
      "limit notification",
    );
    const job = loadQueue(env.sp.queueFile).jobs[0];
    expect(Date.parse(job?.retryAt ?? "") - Date.now()).toBeGreaterThan(2.5 * 60 * 60_000);
    // The founder is told WHEN, instead of "retries automatically" alone.
    expect(env.server.sentMessages.find((m) => m.text.includes("⏳"))?.text).toContain("resets");
  });

  it("reply lane: a session limit with a reset time pauses once and never raises a loop alert (#30)", async () => {
    const env = await makeEnv();
    const runner = new MockRunner(
      [{ role: "pm", stdout: limitStdout(3 * 60 * 60_000) }],
      env.sp.root,
    );
    await boot(env, [], { runner, limitRetryMs: 100, replyMaxAttempts: 3 });

    // "⏳ working on it…" is the progress message — match the notice itself.
    const notices = (): string[] =>
      env.server.sentMessages.filter((m) => m.text.includes("session limit")).map((m) => m.text);
    env.server.pushUpdate("привет");
    await until(() => notices().length > 0, 10000, "limit notice");
    expect(notices()[0]).toContain("resets");

    const calls = runner.calls.length;
    expect(calls).toBe(1);
    await new Promise((r) => setTimeout(r, 600)); // 6x the fallback: nothing may retry
    expect(runner.calls.length).toBe(calls);
    // The old path burned this window on retries that also tripped the
    // transport's "failed 4x in a row" alarm — a false alarm for a wait.
    expect(env.server.sentMessages.filter((m) => m.text.includes("in a row"))).toEqual([]);
    expect(notices().length).toBe(1); // one notice, not one per retry
  });

  it("reply lane: a limit hit AFTER the PM already wrote its answer delivers the answer instead of pausing (#34)", async () => {
    const env = await makeEnv();
    const runner = new MockRunner(
      [
        {
          role: "pm",
          writeFiles: [{ path: "outbox/reply.txt", content: "уже ответила" }],
          stdout: limitStdout(3 * 60 * 60_000),
        },
      ],
      env.sp.root,
    );
    await boot(env, [], { runner, limitRetryMs: 100, replyMaxAttempts: 3 });

    env.server.pushUpdate("привет");
    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("уже ответила")),
      10000,
      "answer delivered despite the limit hit",
    );

    // No "session limit" notice, no redelivery: the answer already existed.
    expect(env.server.sentMessages.some((m) => m.text.includes("session limit"))).toBe(false);
    expect(runner.calls.length).toBe(1);
    await new Promise((r) => setTimeout(r, 300)); // a redelivery would show up as a second call
    expect(runner.calls.length).toBe(1);
  });

  it("auth-expired session pauses the job with retryAt and notifies once with the fix, then drains once it flips back to ok (#21)", async () => {
    const env = await makeEnv();
    const scenarios: MockScenario[] = [{ role: "dev", authFailed: true }];
    await boot(env, scenarios, { limitRetryMs: 200 });
    addJob(env.sp.queueFile, { kind: "issue", issue: 6, base: "main" });

    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("/login")),
      10000,
      "auth notification",
    );
    const q = loadQueue(env.sp.queueFile);
    expect(q.jobs.length).toBe(1); // stays queued, never dropped
    expect(q.jobs[0]?.retryAt).toBeDefined(); // backs off instead of hammering

    // give the worker a few more ticks: no duplicate notifications
    await new Promise((r) => setTimeout(r, 300));
    expect(env.server.sentMessages.filter((m) => m.text.includes("/login")).length).toBe(1);

    // The founder ran `claude /login` — the next attempt succeeds on its own.
    scenarios.length = 0;
    scenarios.push(
      { role: "dev", writeFiles: [{ path: "dev/report-issue6.md", content: "# report" }] },
      { role: "reviewer", writeFiles: [{ path: "dev/review-issue6.md", content: "✅ ок" }] },
    );

    await until(
      () => loadQueue(env.sp.queueFile).jobs.length === 0,
      10000,
      "queue drains without human action",
    );
  });

  it("digest: auth-expired role run keeps the digest job queued instead of dropping it silently (#21)", async () => {
    const env = await makeEnv();
    await boot(env, [{ role: "pm", authFailed: true }], { limitRetryMs: 60_000 });
    addJob(env.sp.queueFile, { kind: "digest" });

    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("/login")),
      10000,
      "digest auth notification",
    );
    const q = loadQueue(env.sp.queueFile);
    expect(q.jobs.length).toBe(1); // still queued — the old bug dropped it here
    expect(q.jobs[0]?.retryAt).toBeDefined();
  });

  it("reply lane: auth-expired session sends one progress line and one /login notice, never burns the 3-strike ladder (#21)", async () => {
    const env = await makeEnv();
    await boot(env, [{ role: "pm", authFailed: true }], {
      replyMaxAttempts: 3,
      limitRetryMs: 5 * 60_000,
    });

    env.server.pushUpdate("привет");
    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("/login")),
      10000,
      "auth notice",
    );
    expect(env.server.sentMessages.filter((m) => m.text.includes("working on it")).length).toBe(1);
    expect(env.server.sentMessages.some((m) => m.text.includes("Skipping it"))).toBe(false);
  });

  it("digest job resets authNotified on a successful run, so a later incident notifies again (#23)", async () => {
    const env = await makeEnv();
    const scenarios: MockScenario[] = [{ role: "pm", authFailed: true }];
    await boot(env, scenarios, { limitRetryMs: 200 });
    addJob(env.sp.queueFile, { kind: "digest" });

    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("/login")),
      10000,
      "first auth notification",
    );

    // The founder ran `claude /login` — the digest succeeds and drains on its own.
    scenarios.length = 0;
    scenarios.push({ role: "pm" });
    await until(
      () => loadQueue(env.sp.queueFile).jobs.length === 0,
      10000,
      "digest drains after recovery",
    );

    // A fresh incident afterward must notify again — before the fix,
    // authNotified stayed true forever because processDigest never reset it.
    scenarios.length = 0;
    scenarios.push({ role: "pm", authFailed: true });
    addJob(env.sp.queueFile, { kind: "digest" });
    await until(
      () => env.server.sentMessages.filter((m) => m.text.includes("/login")).length === 2,
      10000,
      "second auth notification after reset",
    );
  });

  it("digest: a job added on an earlier day is dropped without a runner call, today's still runs (#37)", async () => {
    const env = await makeEnv();
    const runner = new MockRunner([{ role: "pm" }], env.sp.root);
    const logs: string[] = [];
    const record = (msg: string): void => {
      logs.push(msg);
    };
    const logger = { debug: record, info: record, warn: record, error: record, file: "" };
    await boot(env, [], { runner, logger });

    // Local noon keeps the fixture clear of DST shifts; FIFO puts the stale one first.
    const now = new Date();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
    saveQueue(env.sp.queueFile, {
      jobs: [
        { id: "job-stale", kind: "digest", addedAt: yesterday.toISOString() },
        { id: "job-today", kind: "digest", addedAt: now.toISOString() },
      ],
    });

    await until(
      () => loadQueue(env.sp.queueFile).jobs.length === 0,
      10000,
      "both digest jobs leave the queue",
    );
    // Exactly one digest ran — the stale job never reached the runner.
    expect(runner.calls.map((c) => c.role)).toEqual(["pm"]);
    const day = `${String(yesterday.getDate()).padStart(2, "0")}.${String(yesterday.getMonth() + 1).padStart(2, "0")}`;
    expect(logs).toContain(`worker: skipped stale digest for ${day}`);
    expect(logs.filter((l) => l.includes("skipped stale digest"))).toHaveLength(1);
  });

  it("digest: a same-day job whose retryAt came from a pause still runs (#37)", async () => {
    const env = await makeEnv();
    const runner = new MockRunner([{ role: "pm" }], env.sp.root);
    await boot(env, [], { runner });

    // Paused early today, retry due now: the exact limit/auth-pause shape.
    const now = new Date();
    const earlierToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    saveQueue(env.sp.queueFile, {
      jobs: [
        {
          id: "job-paused",
          kind: "digest",
          addedAt: earlierToday.toISOString(),
          retryAt: new Date(Date.now() - 1000).toISOString(),
        },
      ],
    });

    await until(() => loadQueue(env.sp.queueFile).jobs.length === 0, 10000, "paused digest drains");
    expect(runner.calls.map((c) => c.role)).toEqual(["pm"]);
  });

  it("role job resets limitNotified on a successful run, so a later incident notifies again (#23)", async () => {
    const env = await makeEnv();
    const scenarios: MockScenario[] = [
      { role: "dev", stdout: "You've hit your session limit until 7pm." },
    ];
    await boot(env, scenarios, { limitRetryMs: 200 });
    addJob(env.sp.queueFile, { kind: "role", role: "dev" });

    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("⏳")),
      10000,
      "first limit notification",
    );

    // The limit window passes — the role run succeeds and drains on its own.
    scenarios.length = 0;
    scenarios.push({ role: "dev" });
    await until(
      () => loadQueue(env.sp.queueFile).jobs.length === 0,
      10000,
      "role job drains after recovery",
    );

    // A fresh incident afterward must notify again — before the fix,
    // limitNotified stayed true forever because processRole never reset it.
    scenarios.length = 0;
    scenarios.push({ role: "dev", stdout: "You've hit your session limit until 7pm." });
    addJob(env.sp.queueFile, { kind: "role", role: "dev" });
    await until(
      () => env.server.sentMessages.filter((m) => m.text.includes("⏳")).length === 2,
      10000,
      "second limit notification after reset",
    );
  });

  it("dev ok, reviewer hits the session limit -> the retry after the pause resumes at review only, never redoes dev (#34)", async () => {
    const env = await makeEnv();
    // Both dev post-conditions must genuinely hold for the stage stamp to
    // fire (#36) — the report is mocked below, the branch push is real.
    pushBranchToOrigin(env.repo, "team/issue-11");
    const scenarios: MockScenario[] = [
      { role: "dev", writeFiles: [{ path: "dev/report-issue11.md", content: "# report" }] },
      { role: "reviewer", stdout: "You've hit your session limit until 7pm." },
    ];
    const runner = new MockRunner(scenarios, env.sp.root);
    await boot(env, scenarios, { limitRetryMs: 100, runner });
    addJob(env.sp.queueFile, { kind: "issue", issue: 11, base: "main" });

    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("⏳")),
      10000,
      "limit notification",
    );
    // Persisted so a crash between here and the retry still resumes correctly.
    expect(loadQueue(env.sp.queueFile).jobs[0]?.stage).toBe("review");
    expect(runner.calls.filter((c) => c.role === "dev")).toHaveLength(1);

    // The limit lifts — reviewer succeeds on retry.
    scenarios.length = 0;
    scenarios.push({
      role: "reviewer",
      writeFiles: [{ path: "dev/review-issue11.md", content: "✅ ок" }],
    });

    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("✅ ок")),
      10000,
      "completion after the reviewer retry",
    );
    expect(loadQueue(env.sp.queueFile).jobs).toEqual([]);
    // Only ONE dev run ever happened — the retry skipped straight to review.
    expect(runner.calls.filter((c) => c.role === "dev")).toHaveLength(1);
    expect(runner.calls.filter((c) => c.role === "reviewer")).toHaveLength(2);
    const completion = env.server.sentMessages.find((m) => m.text.includes("✅ ок"));
    expect(completion?.text).toContain("dev resumed");
  });

  it("dev ends in error (no branch, no report), reviewer hits the session limit -> the retry after the pause reruns dev, not just review (#36)", async () => {
    const env = await makeEnv();
    const scenarios: MockScenario[] = [
      // No "dev" scenario at all -> MockRunner reports "error" and writes
      // nothing, exactly like a dev step that never finished.
      { role: "reviewer", stdout: "You've hit your session limit until 7pm." },
    ];
    const runner = new MockRunner(scenarios, env.sp.root);
    await boot(env, scenarios, { limitRetryMs: 100, runner });
    addJob(env.sp.queueFile, { kind: "issue", issue: 12, base: "main" });

    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("⏳")),
      10000,
      "limit notification",
    );
    // Dev never really finished — the job must stay unstaged so the retry
    // reruns dev instead of jumping straight to reviewing a branch/report
    // that don't exist.
    expect(loadQueue(env.sp.queueFile).jobs[0]?.stage).not.toBe("review");
    expect(runner.calls.filter((c) => c.role === "dev")).toHaveLength(1);

    // The limit lifts — this time dev genuinely finishes, then review too.
    scenarios.length = 0;
    scenarios.push(
      { role: "dev", writeFiles: [{ path: "dev/report-issue12.md", content: "# report" }] },
      { role: "reviewer", writeFiles: [{ path: "dev/review-issue12.md", content: "✅ ок" }] },
    );

    await until(
      () => env.server.sentMessages.some((m) => m.text.includes("✅ ок")),
      10000,
      "completion after the retry reran dev",
    );
    expect(loadQueue(env.sp.queueFile).jobs).toEqual([]);
    // Dev ran a SECOND time on the retry — the earlier error must not have
    // stamped the job "review" the way #34's fix does for a real success.
    expect(runner.calls.filter((c) => c.role === "dev")).toHaveLength(2);
    expect(runner.calls.filter((c) => c.role === "reviewer")).toHaveLength(2);
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
    expect(env.server.sentMessages.filter((m) => m.text.includes("Skipping it")).length).toBe(1);
  });
});
