import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJson, writeJsonAtomic } from "../../src/state/atomic.js";
import { TransportStateSchema } from "../../src/state/schema.js";
import { TelegramTransport } from "../../src/transport/telegram.js";
import type { InboundMessage } from "../../src/transport/transport.js";
import { startMockTelegram, until, type MockTelegram } from "../helpers/mock-telegram.js";
import { pairTelegram } from "../../src/cli/pair.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function makeTransport(server: MockTelegram, stateFile: string, extra = {}): TelegramTransport {
  const t = new TelegramTransport({
    botToken: "TEST",
    chatId: 42,
    stateFile,
    imagesDir: tmpImagesDir(),
    apiBase: server.url,
    pollTimeoutSec: 0,
    errorSleepMs: 50,
    typingIntervalMs: 40,
    alertStreak: 4,
    ...extra,
  });
  cleanups.push(() => t.stop());
  return t;
}

function tmpStateFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "fh-tg-")), "transport-state.json");
}

function tmpImagesDir(): string {
  return mkdtempSync(path.join(tmpdir(), "fh-tg-images-"));
}

describe("TelegramTransport", () => {
  it("delivers messages sequentially and persists the offset (code-owned)", async () => {
    const server = await startMockTelegram();
    cleanups.push(() => server.close());
    const stateFile = tmpStateFile();
    const seen: string[] = [];

    const t = makeTransport(server, stateFile);
    t.start(async (m: InboundMessage) => {
      seen.push(m.text);
    });
    server.pushUpdate("привет");
    const secondId = server.pushUpdate("как дела?");

    await until(() => seen.length === 2, 5000, "both messages");
    expect(seen).toEqual(["привет", "как дела?"]);
    await t.stop();
    expect(readJson(stateFile, TransportStateSchema).lastUpdateId).toBe(secondId);
  });

  it("delivers a captioned photo using the caption as text (#10)", async () => {
    const server = await startMockTelegram();
    cleanups.push(() => server.close());
    const stateFile = tmpStateFile();
    const seen: string[] = [];
    const t = makeTransport(server, stateFile);
    t.start(async (m: InboundMessage) => {
      seen.push(m.text);
    });
    const captionId = server.pushCaptionedPhoto("посмотри на это");
    await until(() => seen.length === 1, 5000, "captioned photo");
    expect(seen).toEqual(["посмотри на это"]);
    await t.stop();
    expect(readJson(stateFile, TransportStateSchema).lastUpdateId).toBe(captionId);
  });

  it("delivers a photo with its caption and downloads the highest-resolution variant (#24)", async () => {
    const server = await startMockTelegram();
    cleanups.push(() => server.close());
    const stateFile = tmpStateFile();
    const seen: InboundMessage[] = [];
    const t = makeTransport(server, stateFile);
    t.start(async (m: InboundMessage) => {
      seen.push(m);
    });
    const photoId = server.pushCaptionedPhoto("Вот что я вижу");
    await until(() => seen.length === 1, 5000, "photo delivered");
    await t.stop();

    expect(seen[0]?.text).toBe("Вот что я вижу");
    const imagePath = seen[0]?.imagePath;
    expect(imagePath).toBeTruthy();
    expect(existsSync(imagePath ?? "")).toBe(true);
    expect(readFileSync(imagePath ?? "")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(server.getFileCalls).toEqual([`photo-${photoId}-large`]); // last variant = highest res
    expect(readJson(stateFile, TransportStateSchema).lastUpdateId).toBe(photoId);
  });

  it("delivers a bare photo (no caption) with empty text and the downloaded image (#24)", async () => {
    const server = await startMockTelegram();
    cleanups.push(() => server.close());
    const stateFile = tmpStateFile();
    const seen: InboundMessage[] = [];
    const t = makeTransport(server, stateFile);
    t.start(async (m: InboundMessage) => {
      seen.push(m);
    });
    const photoId = server.pushBarePhoto();
    await until(() => seen.length === 1, 5000, "bare photo delivered");
    await t.stop();

    expect(seen[0]?.text).toBe("");
    expect(seen[0]?.imagePath).toBeTruthy();
    expect(readJson(stateFile, TransportStateSchema).lastUpdateId).toBe(photoId);
  });

  it("degrades to caption-only delivery on a download failure, with a logged warning (#24)", async () => {
    const server = await startMockTelegram();
    cleanups.push(() => server.close());
    const stateFile = tmpStateFile();
    const seen: InboundMessage[] = [];
    const warnings: string[] = [];
    server.failFileDownload = 1; // mock 5xx on the next getFile call
    const t = makeTransport(server, stateFile, {
      logger: { info: () => {}, warn: (m: string) => warnings.push(m), error: () => {} },
    });
    t.start(async (m: InboundMessage) => {
      seen.push(m);
    });
    const photoId = server.pushCaptionedPhoto("не грузится");
    await until(() => seen.length === 1, 5000, "message delivered despite download failure");
    await t.stop();

    expect(seen[0]?.text).toBe("не грузится"); // caption survives
    expect(seen[0]?.imagePath).toBeUndefined(); // download failed, not lost
    expect(warnings.some((w) => w.includes(String(photoId)))).toBe(true);
    expect(readJson(stateFile, TransportStateSchema).lastUpdateId).toBe(photoId); // still advances
  });

  it("sends a one-time notice for a bare update with no text and no caption, and does not call the handler (#10)", async () => {
    const server = await startMockTelegram();
    cleanups.push(() => server.close());
    const stateFile = tmpStateFile();
    const seen: string[] = [];
    const t = makeTransport(server, stateFile);
    t.start(async (m: InboundMessage) => {
      seen.push(m.text);
    });
    const stickerId = server.pushNonTextUpdate();
    await until(
      () => server.sentMessages.some((m) => m.text.includes("I can only read text so far")),
      5000,
      "notice sent",
    );
    await t.stop();
    expect(seen).toEqual([]);
    expect(
      server.sentMessages.filter((m) => m.text.includes("I can only read text so far")).length,
    ).toBe(1);
    expect(readJson(stateFile, TransportStateSchema).lastUpdateId).toBe(stickerId);
  });

  it("ignores messages from a foreign chat but still advances past them", async () => {
    const server = await startMockTelegram();
    cleanups.push(() => server.close());
    const stateFile = tmpStateFile();
    const seen: string[] = [];
    const t = makeTransport(server, stateFile);
    t.start(async (m) => {
      seen.push(m.text);
    });
    server.pushUpdate("spam", 999); // wrong chat
    const mineId = server.pushUpdate("mine");
    await until(() => seen.length === 1, 5000, "own message");
    expect(seen).toEqual(["mine"]);
    await t.stop();
    expect(readJson(stateFile, TransportStateSchema).lastUpdateId).toBe(mineId);
  });

  it("redelivers a message whose handler failed — nothing is lost", async () => {
    const server = await startMockTelegram();
    cleanups.push(() => server.close());
    const stateFile = tmpStateFile();
    let attempts = 0;
    const t = makeTransport(server, stateFile);
    t.start(async () => {
      attempts++;
      if (attempts === 1) throw new Error("compose failed");
    });
    server.pushUpdate("важное сообщение");
    await until(() => attempts >= 2, 5000, "redelivery");
    await t.stop();
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(readJson(stateFile, TransportStateSchema).lastUpdateId).toBeGreaterThan(0);
  });

  it("a fresh transport resumes from the persisted offset (no duplicates)", async () => {
    const server = await startMockTelegram();
    cleanups.push(() => server.close());
    const stateFile = tmpStateFile();
    const first: string[] = [];
    const t1 = makeTransport(server, stateFile);
    t1.start(async (m) => {
      first.push(m.text);
    });
    server.pushUpdate("one");
    await until(() => first.length === 1, 5000, "first delivery");
    await t1.stop();

    const second: string[] = [];
    const t2 = makeTransport(server, stateFile);
    t2.start(async (m) => {
      second.push(m.text);
    });
    server.pushUpdate("two");
    await until(() => second.length === 1, 5000, "second delivery");
    await t2.stop();
    expect(second).toEqual(["two"]); // "one" was NOT redelivered
  });

  it("chunks long outbound messages at 3900 chars", async () => {
    const server = await startMockTelegram();
    cleanups.push(() => server.close());
    const t = makeTransport(server, tmpStateFile());
    await t.send("x".repeat(8000));
    expect(server.sentMessages.length).toBe(3);
    expect(server.sentMessages.every((m) => m.text.length <= 3900)).toBe(true);
    expect(server.sentMessages.map((m) => m.text).join("")).toBe("x".repeat(8000));
  });

  it("typing keepalive ticks while composing and stops cleanly", async () => {
    const server = await startMockTelegram();
    cleanups.push(() => server.close());
    const t = makeTransport(server, tmpStateFile());
    t.setTyping(true);
    await until(() => server.chatActions >= 3, 5000, "typing ticks");
    t.setTyping(false);
    const after = server.chatActions;
    await new Promise((r) => setTimeout(r, 150));
    expect(server.chatActions).toBe(after);
  });

  it("sends photos; an over-limit caption becomes a separate message", async () => {
    const server = await startMockTelegram();
    cleanups.push(() => server.close());
    const t = makeTransport(server, tmpStateFile());
    const img = path.join(mkdtempSync(path.join(tmpdir(), "fh-img-")), "shot.png");
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await t.sendPhoto(img, "короткая подпись");
    expect(server.photos.length).toBe(1);
    expect(server.photos[0]?.raw).toContain("shot.png");
    expect(server.photos[0]?.raw).toContain("короткая подпись");

    await t.sendPhoto(img, "y".repeat(2000));
    expect(server.photos.length).toBe(2);
    expect(server.sentMessages.some((m) => m.text.startsWith("yyy"))).toBe(true);
  });

  it("alerts the founder after N identical loop errors, once — not every iteration", async () => {
    const server = await startMockTelegram();
    cleanups.push(() => server.close());
    const t = makeTransport(server, tmpStateFile());
    server.failGetUpdates = Number.POSITIVE_INFINITY;
    t.start(async () => {});
    await until(
      () => server.sentMessages.some((m) => m.text.includes("failed 4x")),
      15000,
      "streak alert",
    );
    // let a few more error iterations pass — no second alert
    await new Promise((r) => setTimeout(r, 400));
    const alerts = server.sentMessages.filter((m) => m.text.includes("in a row"));
    expect(alerts.length).toBe(1);
    server.failGetUpdates = 0;
    await t.stop();
  });
});

describe("pairTelegram", () => {
  it("validates the token, captures the chat id and sends the hello", async () => {
    const server = await startMockTelegram();
    cleanups.push(() => server.close());
    let hiId = 0;
    setTimeout(() => {
      hiId = server.pushUpdate("hi", 4242);
    }, 100);
    const said: string[] = [];
    const result = await pairTelegram(
      { ask: async () => "PAIR_TOKEN", say: (l) => said.push(l) },
      { apiBase: server.url, projectName: "demo", maxWaitMs: 5000 },
    );
    expect(result.botUsername).toBe("mockbot");
    expect(result.chatId).toBe(4242);
    expect(result.lastUpdateId).toBe(hiId);
    expect(server.sentMessages.some((m) => m.text.includes("connected"))).toBe(true);
    expect(said.some((l) => l.includes("@mockbot"))).toBe(true);
  });

  it("leaves nothing unconfirmed — a daemon seeded with its offset never replays the pairing message", async () => {
    const server = await startMockTelegram();
    cleanups.push(() => server.close());
    const stateFile = tmpStateFile();

    const hiId = server.pushUpdate("hi", 4242); // update N, the founder's pairing message
    const pairing = await pairTelegram(
      { ask: async () => "PAIR_TOKEN", say: () => {} },
      { apiBase: server.url, projectName: "demo", maxWaitMs: 5000 },
    );
    expect(pairing.lastUpdateId).toBe(hiId);

    // What init.ts does right after pairing succeeds.
    writeJsonAtomic(stateFile, { lastUpdateId: pairing.lastUpdateId }, TransportStateSchema);

    const seen: string[] = [];
    const t = makeTransport(server, stateFile, { chatId: 4242 });
    t.start(async (m) => {
      seen.push(m.text);
    });
    server.pushUpdate("next", 4242); // update N+1, arrives after pairing

    await until(() => seen.length === 1, 5000, "post-pairing message");
    expect(seen).toEqual(["next"]); // "hi" was NOT replayed
    await t.stop();
  });
});
