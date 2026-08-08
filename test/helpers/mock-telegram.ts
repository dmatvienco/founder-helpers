import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Minimal scriptable Telegram Bot API server. No network, no token needed —
 * transport and daemon tests run entirely against this.
 */

interface StoredUpdate {
  update_id: number;
  message: { chat: { id: number | string; first_name?: string }; text: string; date: number };
}

export interface MockTelegram {
  url: string;
  /** Queue an inbound message from the founder. Returns its update_id. */
  pushUpdate(text: string, chatId?: number | string): number;
  sentMessages: { chat_id: unknown; text: string }[];
  chatActions: number;
  photos: { raw: string }[];
  /** While > 0, getUpdates responds 500 and decrements. Set to Infinity for "down". */
  failGetUpdates: number;
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
    chatActions: 0,
    photos: [] as { raw: string }[],
    failGetUpdates: 0,
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = url.pathname.split("/").pop() ?? "";
      const json = (body: unknown, status = 200): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

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
    get sentMessages() {
      return state.sentMessages;
    },
    get chatActions() {
      return state.chatActions;
    },
    get photos() {
      return state.photos;
    },
    get failGetUpdates() {
      return state.failGetUpdates;
    },
    set failGetUpdates(n: number) {
      state.failGetUpdates = n;
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
