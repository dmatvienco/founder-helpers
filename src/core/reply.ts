import { runRole, type RunRoleOptions } from "../cli/run.js";
import type { Logger } from "../state/log.js";
import type { PathsOptions, StatePaths } from "../state/paths.js";
import { existsSync } from "node:fs";
import { writeJsonAtomic } from "../state/atomic.js";
import { z } from "zod";
import type { ProgressEvent, Runner } from "../runner/runner.js";
import { flushOutbox } from "../transport/outbox.js";
import type { InboundMessage, Transport } from "../transport/transport.js";
import type { Worker } from "./worker.js";
import {
  loadPmSession,
  mtimesUnchanged,
  savePmSessionId,
  watchedFileMtimes,
} from "./pm-session.js";
import { profileFile, roleOverlayFile, roleTemplateFile } from "../prompt/assemble.js";
import { ledgerFile } from "../permissions/ledger.js";
import path from "node:path";

const PM_ROLE = "pm";

/** Files the PM's role prompt embeds — watched so a resumed turn can skip re-sending them when unchanged. */
function watchedPromptFiles(projectRoot: string): Record<string, string> {
  return {
    template: roleTemplateFile(PM_ROLE),
    overlay: roleOverlayFile(projectRoot, PM_ROLE),
    profile: profileFile(projectRoot),
    grants: ledgerFile(projectRoot),
    config: path.join(projectRoot, ".founder-helpers", "config.json"),
  };
}

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

      const session = loadPmSession(this.o.paths.pmSessionFile);
      const resumeSessionId = session?.sessionId;
      const watchedFiles = watchedPromptFiles(this.o.projectRoot);
      const beforeMtimes = watchedFileMtimes(watchedFiles);
      // Only skip the full role/profile/overlay/grants block when BOTH a
      // session is actually being resumed (a fresh session has no prior turn
      // to fall back on) AND nothing watched changed since the last turn —
      // an external edit (founder editing profile.md, a grant recorded or
      // revoked outside this conversation, ...) forces a full resend so the
      // resumed session never silently runs on stale instructions.
      const trimmed =
        Boolean(resumeSessionId) && mtimesUnchanged(beforeMtimes, session?.watchedMtimes);
      // The PM can call `fh session reset` mid-run (founder asked to start
      // fresh) — track this so a post-run save below doesn't immediately
      // undo it by re-writing the very session id that was just cleared.
      const hadSessionBefore = existsSync(this.o.paths.pmSessionFile);
      const opts: RunRoleOptions = {
        mode: "reply",
        inboundMessage: msg.text,
        imagePath: msg.imagePath,
        activeWorkJob: this.o.worker.busyLabel,
        paths: this.o.pathsOpts,
        onProgress: (event: ProgressEvent) => this.o.transport.updateProgress(event.text),
        ...(this.o.runner ? { runner: this.o.runner } : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(trimmed ? { trimmed } : {}),
      };
      const res = await runRole(this.o.projectRoot, "pm", opts);
      // Persist whatever session this run ended up on (new or resumed) so the
      // founder's NEXT message continues the same conversation — regardless
      // of outcome status, since even a paused run keeps its context. Unless
      // the PM (or the digest cron) reset it mid-run, in which case honor
      // that reset instead of silently reinstating the cleared id. mtimes are
      // recorded fresh (post-run), so an edit the PM itself just made this
      // turn is already reflected for the next comparison.
      const resetMidRun = hadSessionBefore && !existsSync(this.o.paths.pmSessionFile);
      if (res.sessionId && !resetMidRun) {
        savePmSessionId(this.o.paths.pmSessionFile, res.sessionId, watchedFileMtimes(watchedFiles));
      }

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
