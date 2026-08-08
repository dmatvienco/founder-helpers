import { writeFileSync } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { Cron } from "croner";
import { loadConfig } from "../cli/run.js";
import { createLogger, type Logger } from "../state/log.js";
import { statePaths, type PathsOptions } from "../state/paths.js";
import { createProjectTransport } from "../transport/telegram.js";
import type { Transport } from "../transport/transport.js";
import type { Runner } from "../runner/runner.js";
import { addJob } from "./queue.js";
import { ReplyLane } from "./reply.js";
import { Worker } from "./worker.js";

export interface DaemonOptions {
  pathsOpts?: PathsOptions;
  /** Test hooks. */
  transport?: Transport;
  runner?: Runner;
  workerIntervalMs?: number;
  limitRetryMs?: number;
  replyMaxAttempts?: number;
  logger?: Logger;
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
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(sp.root, {
      lockfilePath: path.join(sp.root, "daemon.lock"),
      stale: 60_000,
      update: 10_000,
    });
  } catch {
    throw new Error(
      `Another daemon appears to be running for this project (lock: ${path.join(sp.root, "daemon.lock")}).`,
    );
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

  const heartbeatFile = path.join(sp.root, "heartbeat.json");
  const heartbeat = (): void => {
    try {
      writeFileSync(
        heartbeatFile,
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
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
  logger.info(`daemon started pid=${process.pid} project=${projectRoot}`);

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
