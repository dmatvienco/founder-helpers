/**
 * Interactive model choice for `fh init`: same ask/say shape as pair.ts's
 * Telegram wizard, so it's testable without a real TTY.
 *
 * There is no API to enumerate available models (checked `claude --help`,
 * 2026-09-06) — the CLI only documents a fixed alias set that resolves to
 * "the latest" of each family, plus any full model id. So this list is a
 * hardcoded snapshot, not a fetch; typing any other id directly is the
 * escape hatch for models released after this ships.
 */

import type { PairIo } from "./pair.js";

export interface ModelChoice {
  alias: string;
  label: string;
}

export const KNOWN_MODELS: ModelChoice[] = [
  { alias: "sonnet", label: "sonnet — balanced, current default" },
  { alias: "opus", label: "opus — most capable, slower/pricier" },
  { alias: "haiku", label: "haiku — fastest/cheapest" },
  { alias: "fable", label: "fable — creative/expressive tone" },
];

/**
 * Ask which model to pin in `runner.model`. Enter keeps `current` (the
 * schema default); typing a number picks a known alias; typing anything
 * else is taken as a full model id, so a brand-new model still works
 * without a code change.
 */
export async function pickModel(io: PairIo, current: string): Promise<string> {
  io.say("");
  io.say("Model for your team's sessions (used by every role today):");
  for (const [i, m] of KNOWN_MODELS.entries()) {
    io.say(`  ${i + 1}) ${m.label}`);
  }
  io.say(`  Or type any other model id directly.`);
  const answer = (await io.ask(`Model [Enter = ${current}]: `)).trim();
  if (!answer) return current;
  const idx = Number(answer);
  if (Number.isInteger(idx) && idx >= 1 && idx <= KNOWN_MODELS.length) {
    const choice = KNOWN_MODELS[idx - 1];
    if (choice) return choice.alias;
  }
  return answer;
}
