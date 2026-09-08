/**
 * Channel abstraction. Telegram ships first; Slack/Discord/etc. implement the
 * same interface later. Everything above this interface (daemon, reply lane,
 * outbox) must stay channel-agnostic.
 */

/**
 * "Not processed, try again later" — a deliberate redelivery request from the
 * message handler for a wait-only condition (Claude session limit, expired
 * CLI login), as opposed to something actually breaking.
 *
 * The offset stays put like after any other rejection, so the message is
 * still guaranteed not to be lost; what changes is the diagnosis. A transport
 * must not count this toward its identical-error streak, alert the founder
 * about it, or recycle its connection pool over it — the founder has already
 * been told, in words that fit the situation (#30).
 */
export class RedeliverLater extends Error {
  /** Survives module duplication (test bundling, ESM/CJS) where instanceof does not. */
  readonly redeliverLater = true;

  constructor(message: string) {
    super(message);
    this.name = "RedeliverLater";
  }
}

export function isRedeliverLater(err: unknown): boolean {
  if (err instanceof RedeliverLater) return true;
  // The flag's VALUE, not its presence: `{ redeliverLater: false }` says
  // "this is NOT a redelivery" and must keep counting as a real failure.
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { redeliverLater?: unknown }).redeliverLater === true
  );
}

export interface InboundMessage {
  /** Monotic channel-side id used for offset bookkeeping. */
  updateId: number;
  chatId: string | number;
  text: string;
  /** Unix seconds, as reported by the channel. */
  date: number;
  /** Local path to a downloaded photo attached to this message, if any (#24). */
  imagePath?: string | undefined;
}

export interface Transport {
  /**
   * Begin receiving. Messages are delivered ONE AT A TIME; the next message is
   * not delivered (and the offset not advanced) until the handler resolves.
   * A rejected handler means "not processed": the same message is redelivered.
   */
  start(onMessage: (msg: InboundMessage) => Promise<void>): void;
  stop(): Promise<void>;
  /** Send founder-facing text (chunked by the implementation as needed). */
  send(text: string): Promise<void>;
  sendPhoto(filePath: string, caption?: string): Promise<void>;
  /** Keep a "typing…" indicator alive while composing (best effort). */
  setTyping(on: boolean): void;
  /**
   * Live progress for a long headless run: `startProgress` opens one
   * message, `updateProgress` feeds it the latest short action line
   * (throttled/coalesced into edits by the implementation — never one edit
   * per event), `endProgress` stops editing. Best-effort like setTyping: a
   * missed edit is harmless, callers never await updateProgress/endProgress.
   */
  startProgress(initialText: string): Promise<void>;
  updateProgress(text: string): void;
  endProgress(): void;
}
