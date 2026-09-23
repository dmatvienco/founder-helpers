/**
 * Session engines a person can actually pick in `fh init` — a subset of
 * `runner.kind` in the schema (which also allows "mock", a test-only value
 * nobody chooses interactively).
 *
 * Every Codex-specific string `fh doctor`/`fh init` show a human — binary
 * name, credentials path, login command, install URL — lives here, ONE
 * place, same rule as codex-runner.ts's buildCodexArgs: a correction is a
 * one-line fix here, not a hunt through doctor.ts/init.ts. All of it is
 * UNVERIFIED (no network / `codex --help` access while this was written,
 * #42/#43) — model knowledge only.
 */

import path from "node:path";
import type { PairIo } from "./pair.js";

export type EngineKind = "claude" | "codex";

export interface EngineInfo {
  kind: EngineKind;
  label: string;
  /** Binary looked up on PATH. */
  binary: string;
  installUrl: string;
  /** Human-readable login instruction, ready to drop into a detail string. */
  loginCommand: string;
  credentialsPath(home: string): string;
  /**
   * Model offered as the `pickModel` baseline right after switching INTO this
   * engine (see `init.ts`'s `chooseEngineAndModel`) — must be this engine's
   * own model, never the previous engine's stored one (#44). Matches the
   * "balanced, current default" entry in model-picker.ts's `KNOWN_MODELS`.
   */
  defaultModel: string;
}

export const ENGINES: Record<EngineKind, EngineInfo> = {
  claude: {
    kind: "claude",
    label: "Claude Code",
    binary: "claude",
    installUrl: "https://claude.com/claude-code",
    loginCommand: '"claude /login" (or "claude login")',
    credentialsPath: (home) => path.join(home, ".claude", ".credentials.json"),
    defaultModel: "sonnet",
  },
  codex: {
    kind: "codex",
    label: "Codex",
    binary: "codex",
    installUrl: "https://github.com/openai/codex",
    loginCommand: '"codex login"',
    credentialsPath: (home) => path.join(home, ".codex", "auth.json"),
    defaultModel: "gpt-5-codex",
  },
};

/**
 * Ask which engine runs the team's sessions. Same injected ask/say pattern as
 * pair.ts and model-picker.ts's pickModel, so it is testable without a TTY.
 * Enter keeps `current`; an unrecognized answer also keeps `current` rather
 * than crashing (there is no free-text escape hatch here — only two engines
 * exist behind the Runner interface today).
 */
export async function pickEngine(io: PairIo, current: EngineKind): Promise<EngineKind> {
  io.say("");
  io.say("Which engine runs your team's headless sessions?");
  io.say(`  1) ${ENGINES.claude.label} — default`);
  io.say(`  2) ${ENGINES.codex.label}`);
  const answer = (await io.ask(`Engine [Enter = ${ENGINES[current].label}]: `)).trim().toLowerCase();
  if (!answer) return current;
  if (answer === "2" || answer === "codex") return "codex";
  if (answer === "1" || answer === "claude") return "claude";
  return current;
}
