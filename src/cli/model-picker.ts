/**
 * Interactive model choice for `fh init`: same ask/say shape as pair.ts's
 * Telegram wizard, so it's testable without a real TTY.
 *
 * There is no API to enumerate available models (checked `claude --help`,
 * 2026-09-06) — the CLI only documents a fixed alias set that resolves to
 * "the latest" of each family, plus any full model id. So each engine's list
 * below is a hardcoded snapshot, not a fetch; typing any other id directly is
 * the escape hatch for models released after this ships. The Codex list is
 * UNVERIFIED (no network / `codex --help` access while this was written,
 * #43) — model knowledge only, same caveat as engine.ts's ENGINES registry.
 */

import type { EngineKind } from "./engine.js";
import type { PairIo } from "./pair.js";

export interface ModelChoice {
  alias: string;
  label: string;
}

export const KNOWN_MODELS: Record<EngineKind, ModelChoice[]> = {
  claude: [
    { alias: "sonnet", label: "sonnet — balanced, current default" },
    { alias: "opus", label: "opus — most capable, slower/pricier" },
    { alias: "haiku", label: "haiku — fastest/cheapest" },
    { alias: "fable", label: "fable — creative/expressive tone" },
  ],
  codex: [
    { alias: "gpt-5-codex", label: "gpt-5-codex — balanced, current default" },
    { alias: "gpt-5", label: "gpt-5 — most capable, slower/pricier" },
    { alias: "o4-mini", label: "o4-mini — fastest/cheapest" },
  ],
};

/**
 * Ask which model to pin in `runner.model`. Enter keeps `current` (the
 * schema default); typing a number picks a known alias from the given
 * engine's list; typing anything else is taken as a full model id, so a
 * brand-new model still works without a code change.
 */
export async function pickModel(
  io: PairIo,
  current: string,
  engine: EngineKind = "claude",
): Promise<string> {
  const models = KNOWN_MODELS[engine];
  io.say("");
  io.say(`Model for your team's sessions (used by every role today) — ${engine}:`);
  for (const [i, m] of models.entries()) {
    io.say(`  ${i + 1}) ${m.label}`);
  }
  io.say(`  Or type any other model id directly.`);
  const answer = (await io.ask(`Model [Enter = ${current}]: `)).trim();
  if (!answer) return current;
  const idx = Number(answer);
  if (Number.isInteger(idx) && idx >= 1 && idx <= models.length) {
    const choice = models[idx - 1];
    if (choice) return choice.alias;
  }
  return answer;
}
