import { z } from "zod";

/** Committed project config: .founder-helpers/config.json */
export const ProjectConfigSchema = z.object({
  language: z.string().default("auto"),
  integrationBranch: z.string().min(1),
  branchPrefix: z.string().default("team/"),
  labels: z
    .object({
      approved: z.string().default("status:approved"),
      inProgress: z.string().default("status:in-progress"),
      review: z.string().default("status:review"),
      blocked: z.string().default("status:blocked"),
    })
    .prefault({}),
  runner: z
    .object({
      kind: z.enum(["claude", "mock"]).default("claude"),
      model: z.string().default("claude-sonnet-5"),
      permissionMode: z.enum(["allowlist", "acceptEdits", "bypass"]).default("allowlist"),
    })
    .prefault({}),
  roles: z
    .record(z.string(), z.object({ timeoutMin: z.number().int().positive().default(60) }))
    .default({ dev: { timeoutMin: 90 }, reviewer: { timeoutMin: 20 } }),
  digest: z
    .object({
      enabled: z.boolean().default(true),
      cron: z.string().default("0 8 * * *"),
      pipeline: z
        .array(
          z.object({
            prepare: z.array(z.string()).default([]),
            role: z.string(),
            mode: z.string().optional(),
          }),
        )
        .default([{ prepare: [], role: "pm", mode: "morning" }]),
    })
    .prefault({}),
  checks: z
    .array(
      z.object({
        name: z.string(),
        cmd: z.string(),
        dir: z.string().default("."),
      }),
    )
    .default([]),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/** Secrets, state dir only — never in the repo. */
export const SecretsSchema = z.object({
  telegram: z
    .object({
      botToken: z.string().min(1),
      chatId: z.union([z.string(), z.number()]),
    })
    .optional(),
});
export type Secrets = z.infer<typeof SecretsSchema>;

/** Transport bookkeeping — written by transport code ONLY, never by a model. */
export const TransportStateSchema = z.object({
  lastUpdateId: z.number().int().default(0),
});
export type TransportState = z.infer<typeof TransportStateSchema>;

/** Work-lane queue — written by daemon/CLI code ONLY, never by a model. */
export const QueueJobSchema = z.object({
  id: z.string(),
  kind: z.enum(["issue", "digest", "role"]),
  issue: z.number().int().positive().optional(),
  base: z.string().optional(),
  role: z.string().optional(),
  addedAt: z.string(),
  retryAt: z.string().optional(),
});
export type QueueJob = z.infer<typeof QueueJobSchema>;

export const QueueSchema = z.object({
  jobs: z.array(QueueJobSchema).default([]),
});
export type Queue = z.infer<typeof QueueSchema>;

/** Standing-permission ledger: .founder-helpers/permissions.json (committed). */
export const GrantSchema = z.object({
  id: z.string(),
  scope: z.string(),
  granted: z.boolean().default(true),
  date: z.string(),
  channel: z.string().optional(),
  quote: z.string(),
  conditions: z.string().optional(),
  revoked: z.string().nullable().default(null),
});
export type Grant = z.infer<typeof GrantSchema>;

export const LedgerSchema = z.object({
  version: z.literal(1).default(1),
  grants: z.array(GrantSchema).default([]),
});
export type Ledger = z.infer<typeof LedgerSchema>;

/** Well-known grant scopes the CODE understands (freeform scopes are prompt-only). */
export const KNOWN_SCOPES = [
  "git.merge_integration_branch",
  "git.push_integration_branch",
  "runner.bypass_permissions",
  "deploy.production",
  "spend.money",
] as const;

/** One headless run's record: state/runs/<id>/record.json */
export const RunRecordSchema = z.object({
  id: z.string(),
  role: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  status: z.enum(["running", "ok", "timeout", "limit", "error"]),
  exitCode: z.number().int().nullable().optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;
