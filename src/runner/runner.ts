export type RunStatus = "ok" | "timeout" | "limit" | "auth" | "error";

export interface RunSpec {
  role: string;
  /** Path to the fully assembled prompt file (runs/<id>/prompt.md). */
  promptFile: string;
  /** The short pointer text actually passed to `claude -p`. */
  spawnPrompt: string;
  /** Working directory for the run — the project root. */
  cwd: string;
  /** runs/<id>/ — output.log and any runner artifacts land here. */
  runDir: string;
  timeoutMs: number;
  model: string;
  permissionMode: "allowlist" | "acceptEdits" | "bypass";
  /** Claude Code settings file (allowlist/acceptEdits modes). */
  settingsFile?: string;
  /** Extra directories the run may touch (state dir etc.). */
  addDirs: string[];
  /** Override the claude binary (tests use a node script). */
  bin?: string;
  /** Arguments injected BEFORE the computed ones (tests: the script path). */
  binArgs?: string[];
  /** Called for each progress line as the run streams. Best-effort — a run must complete correctly with nobody listening. */
  onProgress?: (event: ProgressEvent) => void;
}

/** A short, ready-to-display action line — e.g. "reading src/x.ts", "running tests". */
export interface ProgressEvent {
  text: string;
}

export interface RunResult {
  status: RunStatus;
  exitCode: number | null;
  /** Path to the captured stdout+stderr log. */
  outputLog: string;
  durationMs: number;
}

export interface Runner {
  run(spec: RunSpec): Promise<RunResult>;
}

/** The phrase the claude CLI prints when the shared session limit is hit. */
export const SESSION_LIMIT_RE = /hit your session limit/i;
