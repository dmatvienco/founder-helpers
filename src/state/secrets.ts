import { chmodSync } from "node:fs";
import { readJson, writeJsonAtomic } from "./atomic.js";
import type { StatePaths } from "./paths.js";
import { SecretsSchema, type Secrets } from "./schema.js";

/** Secrets live in the state dir, outside the repo. Never printed, never committed. */
export function loadSecrets(sp: StatePaths): Secrets {
  return readJson(sp.secretsFile, SecretsSchema, {});
}

export function saveSecrets(sp: StatePaths, secrets: Secrets): void {
  writeJsonAtomic(sp.secretsFile, SecretsSchema.parse(secrets), SecretsSchema);
  try {
    chmodSync(sp.secretsFile, 0o600); // meaningful on POSIX, harmless no-op effect on Windows
  } catch {
    // best effort
  }
}

export function requireTelegram(sp: StatePaths): { botToken: string; chatId: string | number } {
  const secrets = loadSecrets(sp);
  if (!secrets.telegram) {
    throw new Error(
      `Telegram is not paired for this project.\n` +
        `Run "fh init" interactively to pair a bot (secrets file: ${sp.secretsFile}).`,
    );
  }
  return secrets.telegram;
}
