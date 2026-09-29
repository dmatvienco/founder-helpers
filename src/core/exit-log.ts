import os from "node:os";
import type { Logger } from "../state/log.js";

/** The slice of `process` this module touches; tests pass a fake. */
export interface ExitLogProcess {
  pid: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  exit(code?: number): unknown;
}

/**
 * Signals another listener already turns into a graceful stop (`fh daemon`'s
 * shutdown): log them, change nothing.
 */
const LOG_ONLY_SIGNALS = ["SIGINT", "SIGTERM"];
/**
 * Signals nobody listens for, so Node kills the process without a trace
 * (SIGHUP: console/terminal closed; SIGBREAK: Ctrl+Break or console close on
 * Windows). Log, then exit like the default would.
 */
const TERMINATING_SIGNALS = ["SIGHUP", "SIGBREAK"];

function describe(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/**
 * Write the reason to the daemon log before the process goes away. Every
 * fatal path still ends in an exit, the log line just comes first (#56).
 * Returns a function that removes the listeners again.
 */
export function installExitLogging(logger: Logger, proc: ExitLogProcess = process): () => void {
  const installed: Array<[string, (...args: any[]) => void]> = [];
  const add = (event: string, listener: (...args: any[]) => void): void => {
    proc.on(event, listener);
    installed.push([event, listener]);
  };

  add("uncaughtException", (err: unknown, origin: unknown) => {
    logger.error(`fatal: uncaughtException (${String(origin)}): ${describe(err)}`);
    proc.exit(1);
  });
  add("unhandledRejection", (reason: unknown) => {
    logger.error(`fatal: unhandledRejection: ${describe(reason)}`);
    proc.exit(1);
  });
  add("exit", (code: number) => {
    logger.info(`process exit code=${code} pid=${proc.pid}`);
  });

  const signals = os.constants.signals as Record<string, number>;
  for (const sig of [...LOG_ONLY_SIGNALS, ...TERMINATING_SIGNALS]) {
    // SIGBREAK only exists on Windows; a listener for it elsewhere is dead weight.
    if (signals[sig] === undefined) continue;
    const terminates = TERMINATING_SIGNALS.includes(sig);
    add(sig, () => {
      logger.warn(`received ${sig}${terminates ? ", exiting" : ""}`);
      if (terminates) proc.exit(128 + (signals[sig] ?? 0));
    });
  }

  return () => {
    for (const [event, listener] of installed) proc.removeListener(event, listener);
  };
}
