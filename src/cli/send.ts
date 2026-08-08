import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createProjectTransport } from "../transport/telegram.js";
import type { PathsOptions } from "../state/paths.js";

export interface SendOptions {
  text?: string | undefined;
  file?: string | undefined;
  photo?: string | undefined;
  captionFile?: string | undefined;
  paths?: PathsOptions;
  apiBase?: string;
}

/**
 * Transport-agnostic "say something to the founder" — used by role sessions
 * (announce before long work, send screenshots) and by humans for testing.
 * Replaces the predecessor's tg-send.ps1.
 */
export async function sendFromProject(projectRoot: string, opts: SendOptions): Promise<void> {
  const transport = createProjectTransport(
    projectRoot,
    opts.paths ?? {},
    opts.apiBase ? { apiBase: opts.apiBase } : {},
  );
  if (opts.photo) {
    const caption = opts.captionFile
      ? readFileSync(opts.captionFile, "utf8").trim()
      : undefined;
    await transport.sendPhoto(opts.photo, caption);
  }
  const text = opts.text ?? (opts.file ? readFileSync(opts.file, "utf8").trim() : undefined);
  if (text) await transport.send(text);
  if (!opts.photo && !text) {
    throw new Error("Nothing to send: pass --text, --file or --photo.");
  }
}

export async function sendCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      text: { type: "string" },
      file: { type: "string" },
      photo: { type: "string" },
      "caption-file": { type: "string" },
    },
  });
  try {
    await sendFromProject(process.cwd(), {
      text: values.text,
      file: values.file,
      photo: values.photo,
      captionFile: values["caption-file"],
    });
    console.log("sent");
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
