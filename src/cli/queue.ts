import { parseArgs } from "node:util";
import { addJob, loadQueue, removeJob } from "../core/queue.js";
import { statePaths } from "../state/paths.js";

/**
 * `fh queue add --issue N` is how the PM starts a dev run RIGHT NOW — the
 * daemon's work lane picks it up within seconds. No schedulers involved.
 */
export async function queueCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const sp = statePaths(process.cwd());

  if (sub === "add") {
    const { values } = parseArgs({
      args: rest,
      options: {
        issue: { type: "string" },
        base: { type: "string" },
        role: { type: "string" },
        digest: { type: "boolean", default: false },
      },
    });
    let job;
    if (values.digest) {
      job = addJob(sp.queueFile, { kind: "digest" });
    } else if (values.issue) {
      job = addJob(sp.queueFile, {
        kind: "issue",
        issue: Number(values.issue),
        ...(values.base ? { base: values.base } : {}),
      });
    } else if (values.role) {
      job = addJob(sp.queueFile, { kind: "role", role: values.role });
    } else {
      console.error("Usage: fh queue add --issue N [--base B] | --role NAME | --digest");
      return 1;
    }
    console.log(`queued ${job.id} (${job.kind}${job.issue ? ` #${job.issue}` : ""})`);
    return 0;
  }

  if (sub === "remove") {
    const id = rest[0];
    if (!id) {
      console.error("Usage: fh queue remove <job-id>");
      return 1;
    }
    const ok = removeJob(sp.queueFile, id);
    console.log(ok ? `removed ${id}` : `no such job: ${id}`);
    return ok ? 0 : 1;
  }

  // default: list
  const queue = loadQueue(sp.queueFile);
  if (queue.jobs.length === 0) {
    console.log("queue is empty");
    return 0;
  }
  for (const j of queue.jobs) {
    const what = j.kind === "issue" ? `issue #${j.issue} (base ${j.base ?? "default"})` : j.kind === "role" ? `role ${j.role}` : "digest";
    const retry = j.retryAt ? `  retryAt=${j.retryAt}` : "";
    console.log(`${j.id}  ${what}  added=${j.addedAt}${retry}`);
  }
  return 0;
}
