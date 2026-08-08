import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { Logger } from "../state/log.js";
import type { Transport } from "./transport.js";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const TEXT_EXT = new Set([".txt", ".md"]);

/**
 * The outbox contract: a role writes files into state/outbox/, the daemon
 * sends them and deletes them. Text files go as messages; images go as photos
 * with an optional `<name>.caption.txt` sidecar. A failed send leaves the
 * file in place — nothing founder-facing is ever silently dropped.
 */
export async function flushOutbox(
  transport: Transport,
  outboxDir: string,
  logger?: Pick<Logger, "info" | "warn">,
): Promise<number> {
  if (!existsSync(outboxDir)) return 0;
  const entries = readdirSync(outboxDir).sort();
  let sent = 0;
  for (const entry of entries) {
    if (entry.endsWith(".caption.txt")) continue; // sidecar, consumed with its image
    const file = path.join(outboxDir, entry);
    const ext = path.extname(entry).toLowerCase();
    if (IMAGE_EXT.has(ext)) {
      const sidecar = path.join(outboxDir, `${entry}.caption.txt`);
      const caption = existsSync(sidecar) ? readFileSync(sidecar, "utf8").trim() : undefined;
      await transport.sendPhoto(file, caption);
      rmSync(file, { force: true });
      rmSync(sidecar, { force: true });
      sent++;
      logger?.info(`outbox: sent photo ${entry}`);
    } else if (TEXT_EXT.has(ext)) {
      const text = readFileSync(file, "utf8").trim();
      if (text) await transport.send(text);
      rmSync(file, { force: true });
      sent++;
      logger?.info(`outbox: sent ${entry}`);
    } else {
      logger?.warn(`outbox: skipping unknown file type ${entry}`);
    }
  }
  return sent;
}
