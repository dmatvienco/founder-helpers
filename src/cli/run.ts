import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { assemblePrompt } from "../prompt/assemble.js";
import { writeClaudeSettings } from "../permissions/settings.js";
import { ClaudeRunner } from "../runner/claude-runner.js";
import { MockRunner, type MockScenario } from "../runner/mock-runner.js";
import type { ProgressEvent, Runner } from "../runner/runner.js";
import { writeJsonAtomic } from "../state/atomic.js";
import { statePaths, type PathsOptions } from "../state/paths.js";
import {
  LedgerSchema,
  ProjectConfigSchema,
  RunRecordSchema,
  type Ledger,
  type ProjectConfig,
  type RunRecord,
} from "../state/schema.js";

export function loadConfig(projectRoot: string): ProjectConfig {
  const file = path.join(projectRoot, ".founder-helpers", "config.json");
  if (!existsSync(file)) {
    throw new Error(`No ${file} — run "fh init" first.`);
  }
  return ProjectConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export function loadLedger(projectRoot: string): Ledger {
  const file = path.join(projectRoot, ".founder-helpers", "permissions.json");
  if (!existsSync(file)) return LedgerSchema.parse({});
  return LedgerSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export interface RunRoleOptions {
  mode?: string | undefined;
  issue?: number | undefined;
  base?: string | undefined;
  activeWorkJob?: string | undefined;
  inboundMessage?: string | undefined;
  imagePath?: string | undefined;
  paths?: PathsOptions;
  /** Test hooks. */
  runner?: Runner;
  bin?: string;
  binArgs?: string[];
  timeoutMsOverride?: number;
  onProgress?: (event: ProgressEvent) => void;
}

export interface RunRoleOutcome {
  record: RunRecord;
  runDir: string;
  outputLog: string;
}

function newRunId(role: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return `${stamp}_${role}_${Math.random().toString(36).slice(2, 6)}`;
}

function selectRunner(config: ProjectConfig, sp: { root: string }, override?: Runner): Runner {
  if (override) return override;
  const kind = process.env["FH_RUNNER"] ?? config.runner.kind;
  if (kind === "mock") {
    const scenarioFile = process.env["FH_MOCK_SCENARIOS"];
    const scenarios: MockScenario[] = scenarioFile
      ? (JSON.parse(readFileSync(scenarioFile, "utf8")) as MockScenario[])
      : [];
    return new MockRunner(scenarios, sp.root);
  }
  return new ClaudeRunner();
}

/** One role run end to end: settings → prompt → runner → run record. */
export async function runRole(
  projectRoot: string,
  role: string,
  opts: RunRoleOptions = {},
): Promise<RunRoleOutcome> {
  const config = loadConfig(projectRoot);
  const ledger = loadLedger(projectRoot);
  const sp = statePaths(projectRoot, opts.paths ?? {});
  const runId = newRunId(role);
  const runDir = path.join(sp.runsDir, runId);

  const settingsFile = writeClaudeSettings(sp.root, config, ledger);
  const { promptFile, spawnPrompt } = assemblePrompt({
    projectRoot,
    paths: sp,
    config,
    role,
    runId,
    runDir,
    mode: opts.mode,
    issue: opts.issue,
    base: opts.base,
    activeWorkJob: opts.activeWorkJob,
    inboundMessage: opts.inboundMessage,
    imagePath: opts.imagePath,
    grants: ledger.grants,
  });

  const timeoutMin = config.roles[role]?.timeoutMin ?? 60;
  const runner = selectRunner(config, sp, opts.runner);

  const startedAt = new Date().toISOString();
  const result = await runner.run({
    role,
    promptFile,
    spawnPrompt,
    cwd: projectRoot,
    runDir,
    timeoutMs: opts.timeoutMsOverride ?? timeoutMin * 60_000,
    model: config.runner.model,
    permissionMode: config.runner.permissionMode,
    settingsFile,
    addDirs: [sp.root],
    ...(opts.bin ? { bin: opts.bin } : {}),
    ...(opts.binArgs ? { binArgs: opts.binArgs } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });

  const record: RunRecord = RunRecordSchema.parse({
    id: runId,
    role,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: result.status,
    exitCode: result.exitCode,
  });
  writeJsonAtomic(path.join(runDir, "record.json"), record, RunRecordSchema);
  return { record, runDir, outputLog: result.outputLog };
}

export async function runCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      mode: { type: "string" },
      issue: { type: "string" },
      base: { type: "string" },
      timeout: { type: "string" },
      message: { type: "string" },
    },
  });
  const role = positionals[0];
  if (!role) {
    console.error("Usage: fh run <role> [--mode m] [--issue N] [--base branch]");
    return 1;
  }
  try {
    const outcome = await runRole(process.cwd(), role, {
      mode: values.mode,
      issue: values.issue ? Number(values.issue) : undefined,
      base: values.base,
      inboundMessage: values.message,
      ...(values.timeout ? { timeoutMsOverride: Number(values.timeout) * 60_000 } : {}),
    });
    console.log(`status: ${outcome.record.status} (exit ${outcome.record.exitCode ?? "n/a"})`);
    console.log(`run dir: ${outcome.runDir}`);
    console.log(`output:  ${outcome.outputLog}`);
    return outcome.record.status === "ok" ? 0 : 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
