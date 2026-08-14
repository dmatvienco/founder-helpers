/**
 * Channel abstraction. Telegram ships first; Slack/Discord/etc. implement the
 * same interface later. Everything above this interface (daemon, reply lane,
 * outbox) must stay channel-agnostic.
 */

export interface InboundMessage {
  /** Monotic channel-side id used for offset bookkeeping. */
  updateId: number;
  chatId: string | number;
  text: string;
  /** Unix seconds, as reported by the channel. */
  date: number;
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
