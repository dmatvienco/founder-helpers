import { readJson, writeJsonAtomic } from "../state/atomic.js";
import { QueueSchema, type Queue, type QueueJob } from "../state/schema.js";

/**
 * Work-lane queue, persisted in queue.json (code-owned; a model never writes
 * it directly — the PM uses `fh queue add`). A job is removed only AFTER its
 * chain completes, so a crash mid-job means the job reruns rather than
 * vanishing. Rewritten atomically after every mutation.
 */

export function loadQueue(file: string): Queue {
  return readJson(file, QueueSchema, { jobs: [] });
}

export function saveQueue(file: string, queue: Queue): void {
  writeJsonAtomic(file, queue, QueueSchema);
}

export function addJob(
  file: string,
  job: Omit<QueueJob, "id" | "addedAt">,
): QueueJob {
  const queue = loadQueue(file);
  const full: QueueJob = {
    ...job,
    id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    addedAt: new Date().toISOString(),
  };
  queue.jobs.push(full);
  saveQueue(file, queue);
  return full;
}

export function removeJob(file: string, id: string): boolean {
  const queue = loadQueue(file);
  const before = queue.jobs.length;
  queue.jobs = queue.jobs.filter((j) => j.id !== id);
  saveQueue(file, queue);
  return queue.jobs.length < before;
}

export function setRetry(file: string, id: string, retryAtIso: string): void {
  const queue = loadQueue(file);
  const job = queue.jobs.find((j) => j.id === id);
  if (job) {
    job.retryAt = retryAtIso;
    saveQueue(file, queue);
  }
}

/** First job whose retryAt (if any) has passed — FIFO order is priority. */
export function nextEligibleJob(file: string, now = new Date()): QueueJob | undefined {
  const queue = loadQueue(file);
  return queue.jobs.find((j) => !j.retryAt || new Date(j.retryAt) <= now);
}
