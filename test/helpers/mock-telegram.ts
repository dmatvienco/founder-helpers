import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Minimal scriptable Telegram Bot API server. No network, no token needed —
 * transport and daemon tests run entirely against this.
 */

interface PhotoVariant {
  file_id: string;
  width: number;
  height: number;
}

interface StoredUpdate {
  update_id: number;
  message: {
    chat: { id: number | string; first_name?: string };
    text?: string;
    caption?: string;
    photo?: PhotoVariant[];
    date: number;
  };
}

/** Smallest-first, like real Telegram; the largest is the last entry. */
function photoVariants(id: number): PhotoVariant[] {
  return [
    { file_id: `photo-${id}-small`, width: 90, height: 90 },
    { file_id: `photo-${id}-medium`, width: 320, height: 320 },
    { file_id: `photo-${id}-large`, width: 1280, height: 1280 },
  ];
}

export interface MockTelegram {
  url: string;
  /** Queue an inbound message from the founder. Returns its update_id. */
  pushUpdate(text: string, chatId?: number | string): number;
  /** Queue an inbound photo with a caption (message.photo + message.caption). Returns its update_id. */
  pushCaptionedPhoto(caption: string, chatId?: number | string): number;
  /** Queue an inbound photo with no caption (message.photo only). Returns its update_id. */
  pushBarePhoto(chatId?: number | string): number;
  /** Queue an inbound sticker/voice/etc: no text, no caption, no photo. Returns its update_id. */
  pushNonTextUpdate(chatId?: number | string): number;
  sentMessages: { chat_id: unknown; text: string }[];
  /** editMessageText calls — progress-message edits, recorded separately from sends. */
  edits: { chat_id: unknown; message_id: unknown; text: string }[];
  chatActions: number;
  photos: { raw: string }[];
  /** file_ids passed to getFile, in call order — lets tests confirm the highest-res variant was picked. */
  getFileCalls: string[];
  /** While > 0, getUpdates responds 500 and decrements. Set to Infinity for "down". */
  failGetUpdates: number;
  /** While > 0, getFile responds 500 and decrements — simulates a download failure. */
  failFileDownload: number;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startMockTelegram(defaultChatId: number | string = 42): Promise<MockTelegram> {
  let nextUpdateId = 1;
  const updates: StoredUpdate[] = [];
  const state = {
    sentMessages: [] as { chat_id: unknown; text: string }[],
    edits: [] as { chat_id: unknown; message_id: unknown; text: string }[],
    chatActions: 0,
    photos: [] as { raw: string }[],
    getFileCalls: [] as string[],
    failGetUpdates: 0,
    failFileDownload: 0,
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const json = (body: unknown, status = 200): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      // File download: /file/bot<token>/<file_path>, separate from the
      // /bot<token>/<method> RPC namespace.
      if (url.pathname.startsWith("/file/bot")) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // fake PNG-ish bytes
        return;
      }

      const method = url.pathname.split("/").pop() ?? "";

      if (method === "getMe") {
        json({ ok: true, result: { id: 1, is_bot: true, username: "mockbot" } });
        return;
      }
      if (method === "getUpdates") {
        if (state.failGetUpdates > 0) {
          state.failGetUpdates--;
          json({ ok: false, description: "mock outage" }, 500);
          return;
        }
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const pending = updates.filter((u) => u.update_id >= offset);
        // Simulate a short long-poll so loops don't spin hot.
        if (pending.length === 0) await new Promise((r) => setTimeout(r, 40));
        json({ ok: true, result: updates.filter((u) => u.update_id >= offset) });
        return;
      }
      if (method === "sendMessage") {
        const body = JSON.parse(await readBody(req)) as { chat_id: unknown; text: string };
        state.sentMessages.push(body);
        json({ ok: true, result: { message_id: state.sentMessages.length } });
        return;
      }
      if (method === "editMessageText") {
        const body = JSON.parse(await readBody(req)) as {
          chat_id: unknown;
          message_id: unknown;
          text: string;
        };
        state.edits.push(body);
        json({ ok: true, result: { message_id: body.message_id } });
        return;
      }
      if (method === "sendChatAction") {
        await readBody(req);
        state.chatActions++;
        json({ ok: true, result: true });
        return;
      }
      if (method === "sendPhoto") {
        state.photos.push({ raw: await readBody(req) });
        json({ ok: true, result: { message_id: 1000 + state.photos.length } });
        return;
      }
      if (method === "getFile") {
        const body = JSON.parse(await readBody(req)) as { file_id: string };
        state.getFileCalls.push(body.file_id);
        if (state.failFileDownload > 0) {
          state.failFileDownload--;
          json({ ok: false, description: "mock file failure" }, 500);
          return;
        }
        json({
          ok: true,
          result: { file_id: body.file_id, file_path: `photos/${body.file_id}.jpg` },
        });
        return;
      }
      json({ ok: false, description: `mock: unknown method ${method}` }, 404);
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    pushUpdate(text: string, chatId = defaultChatId): number {
      const id = nextUpdateId++;
      updates.push({
        update_id: id,
        message: { chat: { id: chatId, first_name: "Denis" }, text, date: Math.floor(Date.now() / 1000) },
      });
      return id;
    },
    pushCaptionedPhoto(caption: string, chatId = defaultChatId): number {
      const id = nextUpdateId++;
      updates.push({
        update_id: id,
        message: {
          chat: { id: chatId, first_name: "Denis" },
          caption,
          photo: photoVariants(id),
          date: Math.floor(Date.now() / 1000),
        },
      });
      return id;
    },
    pushBarePhoto(chatId = defaultChatId): number {
      const id = nextUpdateId++;
      updates.push({
        update_id: id,
        message: {
          chat: { id: chatId, first_name: "Denis" },
          photo: photoVariants(id),
          date: Math.floor(Date.now() / 1000),
        },
      });
      return id;
    },
    pushNonTextUpdate(chatId = defaultChatId): number {
      const id = nextUpdateId++;
      updates.push({
        update_id: id,
        message: { chat: { id: chatId, first_name: "Denis" }, date: Math.floor(Date.now() / 1000) },
      });
      return id;
    },
    get sentMessages() {
      return state.sentMessages;
    },
    get edits() {
      return state.edits;
    },
    get chatActions() {
      return state.chatActions;
    },
    get photos() {
      return state.photos;
    },
    get getFileCalls() {
      return state.getFileCalls;
    },
    get failGetUpdates() {
      return state.failGetUpdates;
    },
    set failGetUpdates(n: number) {
      state.failGetUpdates = n;
    },
    get failFileDownload() {
      return state.failFileDownload;
    },
    set failFileDownload(n: number) {
      state.failFileDownload = n;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** Poll until a condition holds or fail the test. */
export async function until(cond: () => boolean, ms = 5000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}
