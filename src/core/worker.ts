import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runRole, type RunRoleOptions } from "../cli/run.js";
import type { Logger } from "../state/log.js";
import type { StatePaths, PathsOptions } from "../state/paths.js";
import type { ProjectConfig, QueueJob } from "../state/schema.js";
import { flushOutbox } from "../transport/outbox.js";
import type { Transport } from "../transport/transport.js";
import type { Runner } from "../runner/runner.js";
import { loadQueue, nextEligibleJob, removeJob, setRetry } from "./queue.js";
import { runDigest } from "./digest.js";

export interface WorkerOptions {
  projectRoot: string;
  config: ProjectConfig;
  paths: StatePaths;
  pathsOpts: PathsOptions;
  transport: Transport;
  logger: Logger;
  /** Test hook: injected runner for all role runs. */
  runner?: Runner;
  /** Poll interval for the queue. */
  intervalMs?: number;
  /** How long a session-limit pause lasts before retrying the job. */
  limitRetryMs?: number;
}

/**
 * The work lane: serialized dev→reviewer chains and digest jobs. Post-run
 * conditions are verified in CODE (branch pushed? report exists? verdict
 * parseable?) — honest failure lines replace log forensics.
 */
export class Worker {
  /** Human-readable label of the job being processed, for the reply lane. */
  busyLabel: string | undefined;

  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> = Promise.resolve();
  private stopped = false;
  private limitNotified = false;
  private authNotified = false;

  constructor(private o: WorkerOptions) {}

  start(): void {
    this.stopped = false;
    const interval = this.o.intervalMs ?? 2000;
    this.timer = setInterval(() => {
      // Never overlap ticks: the lane is strictly serialized.
      this.ticking = this.ticking
        .then(async () => {
          await this.tick();
        })
        .catch(() => {});
    }, interval);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.ticking; // let an in-flight job finish gracefully
  }

  private roleOpts(extra: Partial<RunRoleOptions>): RunRoleOptions {
    return {
      paths: this.o.pathsOpts,
      ...(this.o.runner ? { runner: this.o.runner } : {}),
      ...extra,
    };
  }

  async tick(): Promise<boolean> {
    if (this.stopped) return false;
    const job = nextEligibleJob(this.o.paths.queueFile);
    if (!job) return false;
    try {
      if (job.kind === "issue") await this.processIssue(job);
      else if (job.kind === "digest") await this.processDigest(job);
      else await this.processRole(job);
    } catch (err) {
      // A job must never take the lane down; report and drop it honestly.
      const msg = err instanceof Error ? err.message : String(err);
      this.o.logger.error(`worker: job ${job.id} crashed: ${msg}`);
      removeJob(this.o.paths.queueFile, job.id);
      await this.trySend(`⚠️ Job ${describeJob(job)} crashed in the runner: ${msg.slice(0, 300)}`);
    } finally {
      this.busyLabel = undefined;
    }
    return true;
  }

  private async processIssue(job: QueueJob): Promise<void> {
    const issue = job.issue;
    if (issue === undefined) {
      removeJob(this.o.paths.queueFile, job.id);
      return;
    }
    const base = job.base ?? this.o.config.integrationBranch;
    const lines: string[] = [];

    this.busyLabel = `issue #${issue} (dev)`;
    this.o.logger.info(`worker: dev start issue #${issue} base=${base}`);
    const dev = await runRole(this.o.projectRoot, "dev", this.roleOpts({ issue, base }));
    this.o.logger.info(`worker: dev done issue #${issue} status=${dev.record.status}`);

    if (dev.record.status === "auth") {
      this.pauseForAuth(job);
      return;
    }
    if (dev.record.status === "limit") {
      this.pauseForLimit(job);
      return;
    }
    if (dev.record.status !== "ok") {
      lines.push(`⚠️ dev run ended with status "${dev.record.status}" — see ${dev.outputLog}`);
    }

    // Post-conditions in code, not forensics.
    const branch = `${this.o.config.branchPrefix}issue-${issue}`;
    if (!this.branchOnOrigin(branch)) {
      lines.push(`⚠️ branch ${branch} not found on origin — dev may not have pushed`);
    }
    const report = path.join(this.o.paths.devDir, `report-issue${issue}.md`);
    if (!existsSync(report)) {
      lines.push(`⚠️ dev report missing (${report})`);
    }

    this.busyLabel = `issue #${issue} (review)`;
    this.o.logger.info(`worker: reviewer start issue #${issue}`);
    const review = await runRole(this.o.projectRoot, "reviewer", this.roleOpts({ issue, base }));
    this.o.logger.info(`worker: reviewer done issue #${issue} status=${review.record.status}`);
    if (review.record.status === "auth") {
      this.pauseForAuth(job);
      return;
    }
    if (review.record.status === "limit") {
      this.pauseForLimit(job);
      return;
    }

    const verdictFile = path.join(this.o.paths.devDir, `review-issue${issue}.md`);
    let verdictLine = "";
    if (existsSync(verdictFile)) {
      verdictLine = (readFileSync(verdictFile, "utf8").split("\n")[0] ?? "").trim();
      if (!/^[✅⚠️❌]/u.test(verdictLine)) {
        lines.push(`⚠️ verdict file has no parseable first line (${verdictFile})`);
      }
    } else {
      lines.push(`⚠️ review verdict missing (${verdictFile})`);
    }

    removeJob(this.o.paths.queueFile, job.id);
    this.limitNotified = false;
    this.authNotified = false;

    const head = `🔧 issue #${issue}: dev ${dev.record.status}, review ${review.record.status}.`;
    const body = [head, verdictLine, ...lines].filter(Boolean).join("\n");
    await this.trySend(body);
    // Anything the roles put in the outbox (reports, screenshots) rides along.
    await flushOutbox(this.o.transport, this.o.paths.outboxDir, this.o.logger).catch((e) => {
      this.o.logger.warn(`worker: outbox flush failed: ${e}`);
    });
  }

  private async processDigest(job: QueueJob): Promise<void> {
    this.busyLabel = "digest";
    const result = await runDigest({
      projectRoot: this.o.projectRoot,
      config: this.o.config,
      paths: this.o.paths,
      pathsOpts: this.o.pathsOpts,
      transport: this.o.transport,
      logger: this.o.logger,
      ...(this.o.runner ? { runner: this.o.runner } : {}),
    });
    if (result.status === "auth") {
      this.pauseForAuth(job);
      return;
    }
    if (result.status === "limit") {
      this.pauseForLimit(job);
      return;
    }
    removeJob(this.o.paths.queueFile, job.id);
    this.limitNotified = false;
    this.authNotified = false;
  }

  private async processRole(job: QueueJob): Promise<void> {
    const role = job.role;
    if (!role) {
      removeJob(this.o.paths.queueFile, job.id);
      return;
    }
    this.busyLabel = `role ${role}`;
    const res = await runRole(this.o.projectRoot, role, this.roleOpts({}));
    if (res.record.status === "auth") {
      this.pauseForAuth(job);
      return;
    }
    if (res.record.status === "limit") {
      this.pauseForLimit(job);
      return;
    }
    removeJob(this.o.paths.queueFile, job.id);
    this.limitNotified = false;
    this.authNotified = false;
    await flushOutbox(this.o.transport, this.o.paths.outboxDir, this.o.logger).catch((e) => {
      this.o.logger.warn(`worker: outbox flush failed: ${e}`);
    });
  }

  /** Claude session limit: keep the job, back off, tell the founder once. */
  private pauseForLimit(job: QueueJob): void {
    const retryMs = this.o.limitRetryMs ?? 15 * 60_000;
    const retryAt = new Date(Date.now() + retryMs).toISOString();
    setRetry(this.o.paths.queueFile, job.id, retryAt);
    this.o.logger.warn(`worker: session limit, job ${job.id} retries at ${retryAt}`);
    if (!this.limitNotified) {
      this.limitNotified = true;
      void this.trySend(
        `⏳ Claude session limit reached — ${describeJob(job)} stays queued and retries automatically.`,
      );
    }
  }

  /** Expired/unrefreshable OAuth session (#21): keep the job, back off, tell the founder once with the fix. */
  private pauseForAuth(job: QueueJob): void {
    const retryMs = this.o.limitRetryMs ?? 15 * 60_000;
    const retryAt = new Date(Date.now() + retryMs).toISOString();
    setRetry(this.o.paths.queueFile, job.id, retryAt);
    this.o.logger.warn(`worker: auth expired, job ${job.id} retries at ${retryAt}`);
    if (!this.authNotified) {
      this.authNotified = true;
      void this.trySend(
        `🔒 Claude CLI session expired — run \`claude /login\` (or \`claude login\`) on the machine, ` +
          `everything resumes automatically. ${describeJob(job)} stays queued.`,
      );
    }
  }

  private branchOnOrigin(branch: string): boolean {
    try {
      const out = execFileSync(
        "git",
        ["-C", this.o.projectRoot, "ls-remote", "--heads", "origin", branch],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async trySend(text: string): Promise<void> {
    try {
      await this.o.transport.send(text);
    } catch (err) {
      this.o.logger.error(`worker: completion message failed: ${err}`);
    }
  }
}

export function describeJob(job: QueueJob): string {
  if (job.kind === "issue") return `issue #${job.issue}`;
  if (job.kind === "digest") return "the digest run";
  return `role "${job.role}"`;
}
