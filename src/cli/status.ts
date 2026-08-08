import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadQueue } from "../core/queue.js";
import { statePaths, type PathsOptions } from "../state/paths.js";
import { RunRecordSchema } from "../state/schema.js";
import { isAlive } from "../util/tree-kill.js";
import { loadConfig, loadLedger } from "./run.js";

export interface StatusJson {
  daemon: { running: boolean; pid: number | null; heartbeatAgeSec: number | null };
  queue: Array<{ id: string; kind: string; issue?: number; retryAt?: string }>;
  lastRuns: Array<{ id: string; role: string; status: string }>;
  grants: string[];
  digest: { enabled: boolean; cron: string | null };
}

/**
 * Pure data gathering for `fh status` — no stdout writes, so it's shared by
 * the human-readable printer and `--json`, and is directly testable.
 */
export function gatherStatus(projectRoot: string, opts: PathsOptions = {}): StatusJson {
  const sp = statePaths(projectRoot, opts);

  let daemon: StatusJson["daemon"] = { running: false, pid: null, heartbeatAgeSec: null };
  const hbFile = path.join(sp.root, "heartbeat.json");
  if (existsSync(hbFile)) {
    try {
      const hb = JSON.parse(readFileSync(hbFile, "utf8")) as { pid: number; at: string };
      const heartbeatAgeSec = Math.round((Date.now() - new Date(hb.at).getTime()) / 1000);
      daemon = { running: isAlive(hb.pid) && heartbeatAgeSec < 90, pid: hb.pid, heartbeatAgeSec };
    } catch {
      // unreadable heartbeat: report as not running, pid/age unknown
    }
  }

  const queue = loadQueue(sp.queueFile).jobs.map((j) => ({
    id: j.id,
    kind: j.kind,
    ...(j.issue !== undefined ? { issue: j.issue } : {}),
    ...(j.retryAt ? { retryAt: j.retryAt } : {}),
  }));

  let lastRuns: StatusJson["lastRuns"] = [];
  if (existsSync(sp.runsDir)) {
    lastRuns = readdirSync(sp.runsDir)
      .sort()
      .reverse()
      .slice(0, 5)
      .flatMap((id) => {
        const recFile = path.join(sp.runsDir, id, "record.json");
        if (!existsSync(recFile)) return [];
        try {
          const rec = RunRecordSchema.parse(JSON.parse(readFileSync(recFile, "utf8")));
          return [{ id: rec.id, role: rec.role, status: rec.status }];
        } catch {
          return [];
        }
      });
  }

  let grants: string[] = [];
  try {
    grants = loadLedger(projectRoot)
      .grants.filter((g) => g.granted && !g.revoked)
      .map((g) => g.scope);
  } catch {
    // ledger unreadable: report no active grants
  }

  let digest: StatusJson["digest"] = { enabled: false, cron: null };
  try {
    const config = loadConfig(projectRoot);
    digest = { enabled: config.digest.enabled, cron: config.digest.cron };
  } catch {
    // config missing/unreadable: report digest as disabled
  }

  return { daemon, queue, lastRuns, grants, digest };
}

export async function statusCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { json: { type: "boolean", default: false } },
  });
  const projectRoot = process.cwd();

  if (values.json) {
    console.log(JSON.stringify(gatherStatus(projectRoot)));
    return 0;
  }

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
