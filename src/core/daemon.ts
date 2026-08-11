import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { Cron } from "croner";
import { loadConfig } from "../cli/run.js";
import { createLogger, type Logger } from "../state/log.js";
import { statePaths, type PathsOptions } from "../state/paths.js";
import { createProjectTransport } from "../transport/telegram.js";
import type { Transport } from "../transport/transport.js";
import type { Runner } from "../runner/runner.js";
import { headCommit } from "../util/git.js";
import { isAlive } from "../util/tree-kill.js";
import { addJob } from "./queue.js";
import { ReplyLane } from "./reply.js";
import { Worker } from "./worker.js";

// A restart-in-place (e.g. right after `npm update -g`, or a hard-killed
// daemon on Windows where `schtasks /End` skips graceful lock release) lands
// inside the lock's own staleness window. Only wait it out when the previous
// holder is actually gone — a live holder must still fail fast.
const LOCK_STALE_MS = 60_000;
const HEARTBEAT_FRESH_SEC = 90;

/** true when the heartbeat file names a pid that is alive and reporting recently. */
function isPreviousHolderAlive(sp: ReturnType<typeof statePaths>): boolean {
  const hbFile = path.join(sp.root, "heartbeat.json");
  if (!existsSync(hbFile)) return false;
  try {
    const hb = JSON.parse(readFileSync(hbFile, "utf8")) as { pid: number; at: string };
    const ageSec = (Date.now() - new Date(hb.at).getTime()) / 1000;
    return isAlive(hb.pid) && ageSec < HEARTBEAT_FRESH_SEC;
  } catch {
    return false;
  }
}

export interface DaemonOptions {
  pathsOpts?: PathsOptions;
  /** Test hooks. */
  transport?: Transport;
  runner?: Runner;
  workerIntervalMs?: number;
  limitRetryMs?: number;
  replyMaxAttempts?: number;
  logger?: Logger;
  lockStaleMs?: number;
  lockRetries?: { retries: number; minTimeout: number; maxTimeout: number };
}

export interface DaemonHandle {
  stop(): Promise<void>;
  paths: ReturnType<typeof statePaths>;
}

/**
 * One daemon per project: chat lane (always responsive) + work lane
 * (serialized) + cron digest + heartbeat. Exported as a function so tests
 * run it in-process; `fh daemon` is a thin CLI wrapper.
 */
export async function startDaemon(
  projectRoot: string,
  opts: DaemonOptions = {},
): Promise<DaemonHandle> {
  const pathsOpts = opts.pathsOpts ?? {};
  const sp = statePaths(projectRoot, pathsOpts);
  const config = loadConfig(projectRoot);
  const logger = opts.logger ?? createLogger(path.join(sp.logsDir, "daemon.log"));

  // Single instance per project — a second daemon must die loudly, not split
  // the getUpdates offset between two pollers.
  const lockfilePath = path.join(sp.root, "daemon.lock");
  const lockStaleMs = opts.lockStaleMs ?? LOCK_STALE_MS;
  const lockOpts = { lockfilePath, stale: lockStaleMs, update: Math.max(lockStaleMs / 6, 1_000) };
  const lockRetries = opts.lockRetries ?? { retries: 10, minTimeout: 3_000, maxTimeout: 10_000 };
  const lockError = (): Error =>
    new Error(`Another daemon appears to be running for this project (lock: ${lockfilePath}).`);
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(sp.root, lockOpts);
  } catch {
    if (isPreviousHolderAlive(sp)) {
      throw lockError();
    }
    // The previous holder is gone (or never reported in) but its lock hasn't
    // aged past `stale` yet — wait it out instead of dying immediately.
    logger.info("waiting for the previous daemon's lock to expire...");
    try {
      release = await lockfile.lock(sp.root, { ...lockOpts, retries: lockRetries });
    } catch {
      throw lockError();
    }
  }

  const transport = opts.transport ?? createProjectTransport(projectRoot, pathsOpts, { logger });

  const worker = new Worker({
    projectRoot,
    config,
    paths: sp,
    pathsOpts,
    transport,
    logger,
    ...(opts.runner ? { runner: opts.runner } : {}),
    ...(opts.workerIntervalMs !== undefined ? { intervalMs: opts.workerIntervalMs } : {}),
    ...(opts.limitRetryMs !== undefined ? { limitRetryMs: opts.limitRetryMs } : {}),
  });

  const replyLane = new ReplyLane({
    projectRoot,
    paths: sp,
    pathsOpts,
    transport,
    logger,
    worker,
    ...(opts.runner ? { runner: opts.runner } : {}),
    ...(opts.limitRetryMs !== undefined ? { limitRetryMs: opts.limitRetryMs } : {}),
    ...(opts.replyMaxAttempts !== undefined ? { maxAttempts: opts.replyMaxAttempts } : {}),
  });

  let cron: Cron | undefined;
  if (config.digest.enabled) {
    cron = new Cron(config.digest.cron, () => {
      logger.info("cron: enqueueing digest");
      addJob(sp.queueFile, { kind: "digest" });
    });
    logger.info(`cron: digest scheduled (${config.digest.cron})`);
  }

  // Captured once: the daemon's in-process module graph never hot-reloads,
  // so this stays the commit it was started from until the process restarts.
  const startCommit = headCommit(projectRoot);

  const heartbeatFile = path.join(sp.root, "heartbeat.json");
  const heartbeat = (): void => {
    try {
      writeFileSync(
        heartbeatFile,
        JSON.stringify({ pid: process.pid, at: new Date().toISOString(), commit: startCommit }),
        "utf8",
      );
    } catch {
      // never fatal
    }
  };
  heartbeat();
  const heartbeatTimer = setInterval(heartbeat, 30_000);

  worker.start();
  transport.start(replyLane.handler);
  logger.info(
    `daemon started pid=${process.pid} project=${projectRoot} commit=${startCommit ?? "unknown"}`,
  );

  if (config.runner.permissionMode === "bypass") {
    logger.warn(
      "runner.permissionMode is 'bypass' — headless runs skip ALL permission checks. " +
        "This should be a deliberate, recorded decision (see the permissions ledger).",
    );
  }

  return {
    paths: sp,
    async stop(): Promise<void> {
      logger.info("daemon stopping...");
      cron?.stop();
      clearInterval(heartbeatTimer);
      replyLane.stop();
      await transport.stop();
      await worker.stop();
      await release().catch(() => {});
      logger.info("daemon stopped");
    },
  };
}
