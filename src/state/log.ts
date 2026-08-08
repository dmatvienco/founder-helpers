import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  /** Rotate when the file exceeds this many bytes. Default 5 MB. */
  maxBytes?: number;
  /** How many rotated files to keep (file.1 .. file.N). Default 3. */
  keep?: number;
  /** Mirror lines to stderr as well (daemon foreground mode). */
  echo?: boolean;
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  file: string;
}

/**
 * Append-only file logger with size rotation. The predecessor's daemon.log
 * reached 79 MB because nothing ever rotated it — never again.
 */
export function createLogger(file: string, opts: LoggerOptions = {}): Logger {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const keep = opts.keep ?? 3;
  mkdirSync(path.dirname(file), { recursive: true });

  function rotateIfNeeded(): void {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size < maxBytes) return;
    try {
      rmSync(`${file}.${keep}`, { force: true });
      for (let i = keep - 1; i >= 1; i--) {
        try {
          renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        } catch {
          // that slot didn't exist yet
        }
      }
      renameSync(file, `${file}.1`);
    } catch {
      // rotation must never take the process down
    }
  }

  function write(level: LogLevel, msg: string): void {
    rotateIfNeeded();
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}\n`;
    try {
      appendFileSync(file, line, "utf8");
    } catch {
      // last resort: at least try the console
    }
    if (opts.echo || level === "error") {
      // errors always reach stderr so a foreground run is debuggable
      if (opts.echo || process.env["FH_LOG_ECHO"] === "1") process.stderr.write(line);
    }
  }

  return {
    debug: (msg) => write("debug", msg),
    info: (msg) => write("info", msg),
    warn: (msg) => write("warn", msg),
    error: (msg) => write("error", msg),
    file,
  };
}
