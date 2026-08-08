import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { flushOutbox } from "../../src/transport/outbox.js";
import type { InboundMessage, Transport } from "../../src/transport/transport.js";

class FakeTransport implements Transport {
  texts: string[] = [];
  photos: { file: string; caption?: string | undefined }[] = [];
  failNext = false;
  start(_onMessage: (m: InboundMessage) => Promise<void>): void {}
  async stop(): Promise<void> {}
  async send(text: string): Promise<void> {
    if (this.failNext) throw new Error("send down");
    this.texts.push(text);
  }
  async sendPhoto(file: string, caption?: string): Promise<void> {
    if (this.failNext) throw new Error("send down");
    this.photos.push({ file, caption });
  }
  setTyping(_on: boolean): void {}
}

function makeOutbox(): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "fh-outbox-")), "outbox");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("flushOutbox", () => {
  it("sends text files and photos with sidecar captions, then deletes them", async () => {
    const dir = makeOutbox();
    writeFileSync(path.join(dir, "01-digest.md"), "утренняя сводка", "utf8");
    writeFileSync(path.join(dir, "02-shot.png"), Buffer.from([1, 2, 3]));
    writeFileSync(path.join(dir, "02-shot.png.caption.txt"), "экран приложения", "utf8");

    const t = new FakeTransport();
    const sent = await flushOutbox(t, dir);

    expect(sent).toBe(2);
    expect(t.texts).toEqual(["утренняя сводка"]);
    expect(t.photos).toEqual([
      { file: path.join(dir, "02-shot.png"), caption: "экран приложения" },
    ]);
    expect(existsSync(path.join(dir, "01-digest.md"))).toBe(false);
    expect(existsSync(path.join(dir, "02-shot.png"))).toBe(false);
    expect(existsSync(path.join(dir, "02-shot.png.caption.txt"))).toBe(false);
  });

  it("keeps files when sending fails — nothing founder-facing is dropped", async () => {
    const dir = makeOutbox();
    writeFileSync(path.join(dir, "reply.txt"), "ответ", "utf8");
    const t = new FakeTransport();
    t.failNext = true;
    await expect(flushOutbox(t, dir)).rejects.toThrow("send down");
    expect(existsSync(path.join(dir, "reply.txt"))).toBe(true);
  });

  it("is a no-op on a missing or empty dir", async () => {
    const t = new FakeTransport();
    expect(await flushOutbox(t, path.join(tmpdir(), "does-not-exist-xyz"))).toBe(0);
    expect(await flushOutbox(t, makeOutbox())).toBe(0);
  });
});
