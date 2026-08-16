import { runRole, type RunRoleOptions } from "../cli/run.js";
import type { Logger } from "../state/log.js";
import type { PathsOptions, StatePaths } from "../state/paths.js";
import { writeJsonAtomic } from "../state/atomic.js";
import { z } from "zod";
import type { ProgressEvent, Runner } from "../runner/runner.js";
import { flushOutbox } from "../transport/outbox.js";
import type { InboundMessage, Transport } from "../transport/transport.js";
import type { Worker } from "./worker.js";
import path from "node:path";

const InboxSchema = z.object({
  updateId: z.number(),
  text: z.string(),
  date: z.number(),
  receivedAt: z.string(),
});

export interface ReplyLaneOptions {
  projectRoot: string;
  paths: StatePaths;
  pathsOpts: PathsOptions;
  transport: Transport;
  logger: Logger;
  worker: Pick<Worker, "busyLabel">;
  runner?: Runner;
  /** How long to wait before retrying after a session limit. */
  limitRetryMs?: number;
  maxAttempts?: number;
}

/**
 * The chat lane: live progress instead of a static typing indicator (#20),
 * honest 3-strike failure ladder (never silently swallow a founder
 * message), session-limit wait-and-retry without losing the message.
 * Throwing from the handler = transport redelivers.
 */
export class ReplyLane {
  private attempts = new Map<number, number>();
  private limitNotified = false;
  private authNotified = false;
  private pauseUntil = 0;
  private stopped = false;

  constructor(private o: ReplyLaneOptions) {}

  stop(): void {
    this.stopped = true;
  }

  handler = async (msg: InboundMessage): Promise<void> => {
    // Respect an active session-limit/auth pause instead of hammering the CLI.
    while (!this.stopped && Date.now() < this.pauseUntil) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (this.stopped) throw new Error("reply lane stopped");

    const attempt = (this.attempts.get(msg.updateId) ?? 0) + 1;
    this.attempts.set(msg.updateId, attempt);
    this.o.logger.info(`reply: update ${msg.updateId} attempt ${attempt}`);

    await this.o.transport.startProgress("⏳ working on it…");
    try {
      // For the PM's own records; the message itself is injected into the prompt.
      writeJsonAtomic(
        path.join(this.o.paths.pmDir, "inbox-latest.json"),
        {
          updateId: msg.updateId,
          text: msg.text,
          date: msg.date,
          receivedAt: new Date().toISOString(),
        },
        InboxSchema,
      );

      const opts: RunRoleOptions = {
        mode: "reply",
        inboundMessage: msg.text,
        activeWorkJob: this.o.worker.busyLabel,
        paths: this.o.pathsOpts,
        onProgress: (event: ProgressEvent) => this.o.transport.updateProgress(event.text),
        ...(this.o.runner ? { runner: this.o.runner } : {}),
      };
      const res = await runRole(this.o.projectRoot, "pm", opts);

      if (res.record.status === "auth") {
        const wait = this.o.limitRetryMs ?? 15 * 60_000;
        this.pauseUntil = Date.now() + wait;
        if (!this.authNotified) {
          this.authNotified = true;
          await this.o.transport.send(
            "🔒 Claude CLI session expired — run `claude /login` (or `claude login`) on the machine, " +
              "everything resumes automatically. Your message is queued.",
          );
        }
        throw new Error("auth expired"); // redeliver after the pause
      }

      if (res.record.status === "limit") {
        const wait = this.o.limitRetryMs ?? 15 * 60_000;
        this.pauseUntil = Date.now() + wait;
        if (!this.limitNotified) {
          this.limitNotified = true;
          await this.o.transport.send(
            "⏳ Claude session limit reached — your message is queued, I'll answer as soon as it lifts.",
          );
        }
        throw new Error("session limit"); // redeliver after the pause
      }

      const sent = await flushOutbox(this.o.transport, this.o.paths.outboxDir, this.o.logger);
      if (sent === 0) {
        const max = this.o.maxAttempts ?? 3;
        this.o.logger.warn(`reply: no outbox produced (attempt ${attempt}/${max})`);
        if (attempt >= max) {
          // Skip honestly rather than loop forever — the founder decides.
          this.attempts.delete(msg.updateId);
          await this.o.transport.send(
            `⚠️ I failed to process your last message ${max} times (the pipeline is misbehaving — ` +
              `details in the daemon log). Skipping it so I don't loop; please resend when convenient.`,
          );
          return; // offset advances
        }
        throw new Error("no reply produced");
      }

      // Success: clean bookkeeping.
      this.attempts.delete(msg.updateId);
      this.limitNotified = false;
      this.authNotified = false;
    } finally {
      this.o.transport.endProgress();
    }
  };
}
