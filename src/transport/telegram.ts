import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic } from "../state/atomic.js";
import type { Logger } from "../state/log.js";
import { statePaths, type PathsOptions } from "../state/paths.js";
import { TransportStateSchema } from "../state/schema.js";
import { requireTelegram } from "../state/secrets.js";
import type { InboundMessage, Transport } from "./transport.js";

const CHUNK = 3900; // Telegram hard limit is 4096; leave headroom like the predecessor
const CAPTION_LIMIT = 1024;

export interface TelegramOptions {
  botToken: string;
  chatId: string | number;
  /** transport-state.json — owned by THIS code. A model never writes it. */
  stateFile: string;
  /** Directory downloaded photos are saved to (created on demand). */
  imagesDir: string;
  apiBase?: string;
  pollTimeoutSec?: number;
  typingIntervalMs?: number;
  progressIntervalMs?: number;
  errorSleepMs?: number;
  /** Identical consecutive loop errors before alerting the founder. */
  alertStreak?: number;
  logger?: Pick<Logger, "info" | "warn" | "error">;
}

export class TelegramTransport implements Transport {
  private stopped = true;
  private loopDone: Promise<void> = Promise.resolve();
  private typingTimer: NodeJS.Timeout | undefined;
  private progressTimer: NodeJS.Timeout | undefined;
  private progressMessageId: number | undefined;
  private progressLatest = "";
  private progressSent = "";
  private inFlight: AbortController | undefined;
  private lastUpdateId = 0;

  constructor(private o: TelegramOptions) {}

  private api(method: string): string {
    const base = this.o.apiBase ?? "https://api.telegram.org";
    return `${base}/bot${this.o.botToken}/${method}`;
  }

  private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(this.api(method), {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok: boolean; description?: string; result?: unknown };
    if (!data.ok) throw new Error(`telegram ${method} failed: ${data.description ?? res.status}`);
    return data.result;
  }

  start(onMessage: (msg: InboundMessage) => Promise<void>): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.lastUpdateId = readJson(this.o.stateFile, TransportStateSchema, {
      lastUpdateId: 0,
    }).lastUpdateId;
    this.loopDone = this.loop(onMessage);
  }

  private async loop(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    const pollTimeout = this.o.pollTimeoutSec ?? 50;
    const errorSleep = this.o.errorSleepMs ?? 15_000;
    const alertStreak = this.o.alertStreak ?? 4;
    let lastErr = "";
    let streak = 0;

    while (!this.stopped) {
      try {
        this.inFlight = new AbortController();
        const guard = setTimeout(() => this.inFlight?.abort(), (pollTimeout + 25) * 1000);
        const res = await fetch(
          this.api(`getUpdates?offset=${this.lastUpdateId + 1}&timeout=${pollTimeout}`),
          { signal: this.inFlight.signal },
        );
        clearTimeout(guard);
        const data = (await res.json()) as {
          ok: boolean;
          description?: string;
          result?: {
            update_id: number;
            message?: {
              chat?: { id: number | string };
              text?: string;
              caption?: string;
              photo?: { file_id: string; width: number; height: number }[];
              date?: number;
            };
          }[];
        };
        if (!data.ok) throw new Error(`getUpdates failed: ${data.description ?? res.status}`);

        for (const u of data.result ?? []) {
          if (this.stopped) break;
          const msg = u.message;
          if (msg?.chat && String(msg.chat.id) === String(this.o.chatId)) {
            // A caption carries the text of a photo/video message; treat it
            // the same as message.text (#10).
            const text = typeof msg.text === "string" ? msg.text : msg.caption;
            // Telegram lists variants smallest-first; the last entry is the
            // highest resolution (#24).
            const photo = msg.photo?.length ? msg.photo[msg.photo.length - 1] : undefined;
            if (photo) {
              let imagePath: string | undefined;
              try {
                imagePath = await this.downloadPhoto(photo.file_id, u.update_id);
              } catch (err) {
                const m = err instanceof Error ? err.message : String(err);
                this.o.logger?.warn(`photo download failed for update ${u.update_id}: ${m}`);
              }
              // A bare photo still gets a `text` (empty string) so the
              // not-lost/redelivery guarantee below is unaffected even when
              // the download itself failed and only the caption survives.
              await onMessage({
                updateId: u.update_id,
                chatId: msg.chat.id,
                text: text ?? "",
                date: msg.date ?? 0,
                ...(imagePath ? { imagePath } : {}),
              });
            } else if (typeof text === "string") {
              // Sequential by design; a rejection means "not processed" and the
              // offset stays put, so the message is redelivered — never lost.
              await onMessage({
                updateId: u.update_id,
                chatId: msg.chat.id,
                text,
                date: msg.date ?? 0,
              });
            } else {
              // Bare sticker/voice etc: nothing we can read. Tell the
              // founder instead of silently dropping it (#10) — a rejection
              // here also keeps the offset put, so the notice is redelivered
              // on failure like any other handled message.
              await this.send("I can only read text so far.");
            }
          }
          this.lastUpdateId = u.update_id;
          writeJsonAtomic(
            this.o.stateFile,
            { lastUpdateId: this.lastUpdateId },
            TransportStateSchema,
          );
        }
        lastErr = "";
        streak = 0;
      } catch (err) {
        if (this.stopped) break;
        const msg = err instanceof Error ? err.message : String(err);
        streak = msg === lastErr ? streak + 1 : 1;
        lastErr = msg;
        this.o.logger?.warn(`transport loop error (${streak}x): ${msg}`);
        // A stuck loop must tell the founder instead of dying silently
        // (predecessor lesson: 19 silent hours). Alert once at the streak
        // threshold, then roughly hourly while it persists.
        if (streak === alertStreak || (streak > alertStreak && streak % 240 === 0)) {
          try {
            await this.send(
              `⚠️ founder-helpers: the message loop has failed ${streak}x in a row with the same error ` +
                `(${msg.slice(0, 200)}). Incoming messages are queued, not lost — but I need attention.`,
            );
          } catch {
            // if even sendMessage is down there is nothing more we can do
          }
        }
        await this.sleep(errorSleep);
      }
    }
  }

  private async sleep(ms: number): Promise<void> {
    const step = 250;
    const until = Date.now() + ms;
    while (!this.stopped && Date.now() < until) {
      await new Promise((r) => setTimeout(r, Math.min(step, until - Date.now())));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.setTyping(false);
    this.endProgress();
    this.inFlight?.abort();
    await this.loopDone;
  }

  /** getFile + download the raw bytes, saved as `<updateId><ext>` under imagesDir. */
  private async downloadPhoto(fileId: string, updateId: number): Promise<string> {
    const info = (await this.call("getFile", { file_id: fileId })) as { file_path?: string };
    const filePath = info.file_path;
    if (!filePath) throw new Error("getFile returned no file_path");
    const base = this.o.apiBase ?? "https://api.telegram.org";
    const res = await fetch(`${base}/file/bot${this.o.botToken}/${filePath}`);
    if (!res.ok) throw new Error(`file download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(this.o.imagesDir, { recursive: true });
    const dest = path.join(this.o.imagesDir, `${updateId}${path.extname(filePath) || ".jpg"}`);
    writeFileSync(dest, buf);
    return dest;
  }

  async send(text: string): Promise<void> {
    let t = text.trim();
    if (!t) return;
    while (t.length > 0) {
      const chunk = t.slice(0, CHUNK);
      t = t.slice(chunk.length);
      await this.call("sendMessage", { chat_id: this.o.chatId, text: chunk });
    }
  }

  async sendPhoto(filePath: string, caption?: string): Promise<void> {
    const buf = readFileSync(filePath);
    const fd = new FormData();
    fd.append("chat_id", String(this.o.chatId));
    const shortCaption = caption && caption.length <= CAPTION_LIMIT ? caption : undefined;
    if (shortCaption) fd.append("caption", shortCaption);
    fd.append("photo", new Blob([new Uint8Array(buf)]), path.basename(filePath));
    const res = await fetch(this.api("sendPhoto"), { method: "POST", body: fd });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (!data.ok) throw new Error(`telegram sendPhoto failed: ${data.description ?? res.status}`);
    if (caption && !shortCaption) {
      await this.send(caption); // over the caption limit -> separate message
    }
  }

  setTyping(on: boolean): void {
    if (!on) {
      if (this.typingTimer) clearInterval(this.typingTimer);
      this.typingTimer = undefined;
      return;
    }
    if (this.typingTimer) return;
    const tick = (): void => {
      void this.call("sendChatAction", { chat_id: this.o.chatId, action: "typing" }).catch(
        () => {},
      );
    };
    tick();
    this.typingTimer = setInterval(tick, this.o.typingIntervalMs ?? 4000);
  }

  async startProgress(initialText: string): Promise<void> {
    this.endProgress();
    this.progressLatest = initialText;
    try {
      const result = (await this.call("sendMessage", {
        chat_id: this.o.chatId,
        text: initialText,
      })) as { message_id: number };
      this.progressMessageId = result.message_id;
      this.progressSent = initialText;
    } catch {
      return; // best-effort: no message id means updateProgress has nothing to edit
    }
    const tick = (): void => {
      if (this.progressMessageId === undefined || this.progressLatest === this.progressSent) return;
      const text = this.progressLatest;
      this.progressSent = text;
      void this.call("editMessageText", {
        chat_id: this.o.chatId,
        message_id: this.progressMessageId,
        text,
      }).catch(() => {});
    };
    this.progressTimer = setInterval(tick, this.o.progressIntervalMs ?? 2500);
  }

  updateProgress(text: string): void {
    this.progressLatest = text;
  }

  endProgress(): void {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = undefined;
    this.progressMessageId = undefined;
    this.progressLatest = "";
    this.progressSent = "";
  }
}

/** Build a transport for the current project from stored secrets. */
export function createProjectTransport(
  projectRoot: string,
  opts: PathsOptions = {},
  extra: Partial<TelegramOptions> = {},
): TelegramTransport {
  const sp = statePaths(projectRoot, opts);
  const { botToken, chatId } = requireTelegram(sp);
  const apiBase = extra.apiBase ?? process.env["FH_TELEGRAM_API"];
  return new TelegramTransport({
    botToken,
    chatId,
    stateFile: sp.transportStateFile,
    imagesDir: sp.imagesDir,
    ...(apiBase ? { apiBase } : {}),
    ...extra,
  });
}
