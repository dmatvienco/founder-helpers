import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadQueue } from "../core/queue.js";
import { statePaths } from "../state/paths.js";
import { RunRecordSchema } from "../state/schema.js";
import { isAlive } from "../util/tree-kill.js";
import { loadConfig, loadLedger } from "./run.js";

export async function statusCommand(_args: string[]): Promise<number> {
  const projectRoot = process.cwd();
  const sp = statePaths(projectRoot);

  // Daemon liveness via heartbeat.
  const hbFile = path.join(sp.root, "heartbeat.json");
  if (existsSync(hbFile)) {
    try {
      const hb = JSON.parse(readFileSync(hbFile, "utf8")) as { pid: number; at: string };
      const ageSec = Math.round((Date.now() - new Date(hb.at).getTime()) / 1000);
      const alive = isAlive(hb.pid) && ageSec < 90;
      console.log(
        alive
          ? `daemon: running (pid ${hb.pid}, heartbeat ${ageSec}s ago)`
          : `daemon: NOT running (last heartbeat ${ageSec}s ago, pid ${hb.pid})`,
      );
    } catch {
      console.log("daemon: unknown (heartbeat unreadable)");
    }
  } else {
    console.log("daemon: never started for this project");
  }

  // Queue.
  const queue = loadQueue(sp.queueFile);
  console.log(`queue: ${queue.jobs.length} job(s)`);
  for (const j of queue.jobs) {
    console.log(
      `  ${j.id}  ${j.kind}${j.issue ? ` #${j.issue}` : ""}${j.retryAt ? `  retryAt=${j.retryAt}` : ""}`,
    );
  }

  // Last runs.
  if (existsSync(sp.runsDir)) {
    const runs = readdirSync(sp.runsDir).sort().reverse().slice(0, 5);
    if (runs.length) console.log("last runs:");
    for (const id of runs) {
      const recFile = path.join(sp.runsDir, id, "record.json");
      if (!existsSync(recFile)) continue;
      try {
        const rec = RunRecordSchema.parse(JSON.parse(readFileSync(recFile, "utf8")));
        console.log(`  ${rec.id}  ${rec.role}  ${rec.status}`);
      } catch {
        console.log(`  ${id}  (unreadable record)`);
      }
    }
  }

  // Grants + digest schedule.
  try {
    const ledger = loadLedger(projectRoot);
    const active = ledger.grants.filter((g) => g.granted && !g.revoked);
    console.log(`standing grants: ${active.length ? active.map((g) => g.scope).join(", ") : "none (modest mode)"}`);
  } catch {
    console.log("standing grants: ledger unreadable");
  }
  try {
    const config = loadConfig(projectRoot);
    console.log(
      config.digest.enabled ? `digest: cron "${config.digest.cron}"` : "digest: disabled",
    );
  } catch {
    console.log("config: missing — run fh init");
  }
  return 0;
}
