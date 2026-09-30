import { EventEmitter } from "node:events";
import { constants } from "node:os";
import { describe, expect, it } from "vitest";
import { installExitLogging, type ExitLogProcess } from "../../src/core/exit-log.js";
import type { Logger } from "../../src/state/log.js";

function fixture() {
  const lines: string[] = [];
  const logger: Logger = {
    debug: (m) => lines.push(`DEBUG ${m}`),
    info: (m) => lines.push(`INFO ${m}`),
    warn: (m) => lines.push(`WARN ${m}`),
    error: (m) => lines.push(`ERROR ${m}`),
    file: "unused",
  };
  const emitter = new EventEmitter();
  const exits: number[] = [];
  const proc: ExitLogProcess = {
    pid: 4242,
    on: (e, l) => emitter.on(e, l),
    removeListener: (e, l) => emitter.removeListener(e, l),
    exit: (code) => {
      exits.push(code ?? 0);
    },
  };
  return { lines, logger, emitter, exits, proc };
}

describe("installExitLogging", () => {
  it("logs an uncaught exception with its stack, then exits 1", () => {
    const f = fixture();
    installExitLogging(f.logger, f.proc);
    f.emitter.emit("uncaughtException", new Error("boom"), "uncaughtException");
    expect(f.lines[0]).toMatch(
      /^ERROR fatal: uncaughtException \(uncaughtException\): Error: boom/,
    );
    expect(f.exits).toEqual([1]);
  });

  it("logs an unhandled rejection (non-Error reason too), then exits 1", () => {
    const f = fixture();
    installExitLogging(f.logger, f.proc);
    f.emitter.emit("unhandledRejection", "plain string");
    expect(f.lines).toEqual(["ERROR fatal: unhandledRejection: plain string"]);
    expect(f.exits).toEqual([1]);
  });

  it("logs the exit code and pid on process exit", () => {
    const f = fixture();
    installExitLogging(f.logger, f.proc);
    f.emitter.emit("exit", 3);
    expect(f.lines).toEqual(["INFO process exit code=3 pid=4242"]);
  });

  it("SIGINT/SIGTERM are logged only: the graceful shutdown owns the exit", () => {
    const f = fixture();
    installExitLogging(f.logger, f.proc);
    f.emitter.emit("SIGINT");
    f.emitter.emit("SIGTERM");
    expect(f.lines).toEqual(["WARN received SIGINT", "WARN received SIGTERM"]);
    expect(f.exits).toEqual([]);
  });

  it("SIGHUP is logged and still terminates like the default would", () => {
    const f = fixture();
    installExitLogging(f.logger, f.proc);
    f.emitter.emit("SIGHUP");
    expect(f.lines).toEqual(["WARN received SIGHUP, exiting"]);
    expect(f.exits).toEqual([128 + (constants.signals["SIGHUP"] ?? 0)]);
  });

  it("only listens for SIGBREAK where the OS has it", () => {
    const f = fixture();
    installExitLogging(f.logger, f.proc);
    expect(f.emitter.listenerCount("SIGBREAK")).toBe(
      (constants.signals as Record<string, number>)["SIGBREAK"] === undefined ? 0 : 1,
    );
  });

  it("the returned function removes every listener", () => {
    const f = fixture();
    const uninstall = installExitLogging(f.logger, f.proc);
    uninstall();
    for (const e of f.emitter.eventNames()) expect(f.emitter.listenerCount(e)).toBe(0);
    f.emitter.emit("exit", 0);
    expect(f.lines).toEqual([]);
  });
});
