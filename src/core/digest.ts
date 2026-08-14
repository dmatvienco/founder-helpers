import { exec } from "node:child_process";
import { promisify } from "node:util";
import { runRole } from "../cli/run.js";
import type { Logger } from "../state/log.js";
import type { PathsOptions, StatePaths } from "../state/paths.js";
import type { ProjectConfig } from "../state/schema.js";
import { flushOutbox } from "../transport/outbox.js";
import type { Transport } from "../transport/transport.js";
import type { Runner } from "../runner/runner.js";

const execAsync = promisify(exec);

export interface DigestOptions {
  projectRoot: string;
  config: ProjectConfig;
  paths: StatePaths;
  pathsOpts: PathsOptions;
  transport: Transport;
  logger: Logger;
  runner?: Runner;
}

/**
 * The scheduled digest: for each configured pipeline step, run the project's
 * prepare scripts (stats collection etc. — project-owned commands), then the
 * role itself; finally flush whatever landed in the outbox. This is how
 * project-specific data gathering stays out of the generic core.
 */
export async function runDigest(o: DigestOptions): Promise<void> {
  for (const step of o.config.digest.pipeline) {
    for (const cmd of step.prepare) {
      o.logger.info(`digest: prepare "${cmd}"`);
      try {
        const { stdout, stderr } = await execAsync(cmd, {
          cwd: o.projectRoot,
          timeout: 10 * 60_000,
          windowsHide: true,
          // Lets a prepare script find its output home without recomputing
          // the per-OS/per-project path itself.
          env: { ...process.env, FH_STATE_ROOT: o.paths.root },
        });
        if (stdout.trim()) o.logger.info(`digest prepare out: ${stdout.trim().slice(0, 2000)}`);
        if (stderr.trim()) o.logger.warn(`digest prepare err: ${stderr.trim().slice(0, 2000)}`);
      } catch (err) {
        // A broken stats script must not cancel the digest — the role reports
        // missing data honestly instead.
        o.logger.error(`digest: prepare failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    o.logger.info(`digest: running role ${step.role}${step.mode ? ` (${step.mode})` : ""}`);
    const res = await runRole(o.projectRoot, step.role, {
      mode: step.mode,
      paths: o.pathsOpts,
      ...(o.runner ? { runner: o.runner } : {}),
    });
    o.logger.info(`digest: role ${step.role} status=${res.record.status}`);
  }
  const sent = await flushOutbox(o.transport, o.paths.outboxDir, o.logger);
  o.logger.info(`digest: flushed ${sent} outbox item(s)`);
}
