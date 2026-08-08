import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface Command {
  name: string;
  summary: string;
  run: (args: string[]) => Promise<number>;
}

// Real commands land milestone by milestone (init, daemon, run, status,
// doctor, logs, send, queue, grant). The dispatcher stays this small on purpose.
const commands: Command[] = [];

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
