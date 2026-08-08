import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { statePaths } from "../state/paths.js";

export async function logsCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      lines: { type: "string", short: "n", default: "50" },
      follow: { type: "boolean", short: "f", default: false },
    },
  });
  const sp = statePaths(process.cwd());
  const file = path.join(sp.logsDir, "daemon.log");
  if (!existsSync(file)) {
    console.log(`no log yet (${file})`);
    return 0;
  }

  const printTail = (from: number): number => {
    const content = readFileSync(file, "utf8");
    process.stdout.write(content.slice(from));
    return content.length;
  };

  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  const n = Number(values.lines);
  process.stdout.write(lines.slice(-n - 1).join("\n"));
  if (!values.follow) return 0;

  // Simple polling follow — good enough for a local daemon log.
  let offset = content.length;
  console.log("\n--- following (Ctrl+C to stop) ---");
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      try {
        if (statSync(file).size > offset) offset = printTail(offset);
      } catch {
        // rotated away; restart from zero
        offset = 0;
      }
    }, 500);
    process.on("SIGINT", () => {
      clearInterval(timer);
      resolve();
    });
  });
  return 0;
}
