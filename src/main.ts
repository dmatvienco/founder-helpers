import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { daemonCommand } from "./cli/daemon.js";
import { doctorCommand } from "./cli/doctor.js";
import { grantCommand } from "./cli/grant.js";
import { initCommand } from "./cli/init.js";
import { logsCommand } from "./cli/logs.js";
import { queueCommand } from "./cli/queue.js";
import { runCommand } from "./cli/run.js";
import { sendCommand } from "./cli/send.js";
import { sessionCommand } from "./cli/session.js";
import { statusCommand } from "./cli/status.js";

export interface Command {
  name: string;
  summary: string;
  run: (args: string[]) => Promise<number>;
}

const commands: Command[] = [
  { name: "init", summary: "Set up founder-helpers in the current project", run: initCommand },
  { name: "daemon", summary: "Run the daemon in the foreground", run: daemonCommand },
  { name: "run", summary: "Run one role once (fh run <role> [--issue N])", run: runCommand },
  { name: "queue", summary: "Work queue: add --issue N | list | remove <id>", run: queueCommand },
  { name: "status", summary: "Daemon, queue, last runs, grants", run: statusCommand },
  { name: "logs", summary: "Show the daemon log (-n 50, --follow)", run: logsCommand },
  { name: "send", summary: "Send text/photo to the founder's chat", run: sendCommand },
  { name: "session", summary: "PM reply-mode session: reset", run: sessionCommand },
  { name: "grant", summary: "Standing permissions: record | list | revoke", run: grantCommand },
  { name: "doctor", summary: "Check the environment and configuration", run: doctorCommand },
];

function packageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Both src/ and dist/ sit one level below the package root.
  const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

function printHelp(): void {
  const commandLines = commands.length
    ? commands.map((c) => `  ${c.name.padEnd(10)} ${c.summary}`)
    : ["  (none yet — this is a pre-release skeleton)"];
  const lines = [
    "founder-helpers — your AI team on headless Claude Code",
    "",
    "Usage: fh <command> [options]",
    "",
    "Commands:",
    ...commandLines,
    "",
    "Options:",
    "  -v, --version  Print version",
    "  -h, --help     Print this help",
  ];
  console.log(lines.join("\n"));
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    return 0;
  }
  if (cmd === "-v" || cmd === "--version" || cmd === "version") {
    console.log(packageVersion());
    return 0;
  }
  const found = commands.find((c) => c.name === cmd);
  if (!found) {
    console.error(`Unknown command: ${cmd}`);
    console.error("");
    printHelp();
    return 1;
  }
  return found.run(rest);
}
