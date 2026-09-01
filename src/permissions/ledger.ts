import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { KNOWN_SCOPES, LedgerSchema, type Grant, type Ledger } from "../state/schema.js";
import { writeClaudeSettings } from "./settings.js";
import { statePaths, type PathsOptions } from "../state/paths.js";
import { ProjectConfigSchema, type ProjectConfig } from "../state/schema.js";

export function ledgerFile(projectRoot: string): string {
  return path.join(projectRoot, ".founder-helpers", "permissions.json");
}

function configOf(projectRoot: string): ProjectConfig {
  const file = path.join(projectRoot, ".founder-helpers", "config.json");
  return ProjectConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export function readLedger(projectRoot: string): Ledger {
  const file = ledgerFile(projectRoot);
  if (!existsSync(file)) return LedgerSchema.parse({});
  return LedgerSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

function saveLedger(projectRoot: string, ledger: Ledger, opts: PathsOptions): void {
  writeFileSync(ledgerFile(projectRoot), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  // The settings layer must always reflect the ledger.
  const sp = statePaths(projectRoot, opts);
  writeClaudeSettings(sp.root, configOf(projectRoot), ledger);
}

export interface RecordGrantInput {
  scope: string;
  quote: string;
  conditions?: string | undefined;
  channel?: string | undefined;
}

/**
 * Record a standing grant — the durable form of the founder saying
 * "do it, and don't ask again". The verbatim quote IS the authority;
 * it must be the founder's actual words, never a paraphrase.
 */
export function recordGrant(
  projectRoot: string,
  input: RecordGrantInput,
  opts: PathsOptions = {},
): Grant {
  const ledger = readLedger(projectRoot);
  const slug = input.scope.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const grant: Grant = {
    id: `g-${new Date().toISOString().slice(0, 10)}-${slug}-${Math.random().toString(36).slice(2, 5)}`,
    scope: input.scope,
    granted: true,
    date: new Date().toISOString(),
    quote: input.quote,
    revoked: null,
    ...(input.conditions ? { conditions: input.conditions } : {}),
    ...(input.channel ? { channel: input.channel } : {}),
  };
  ledger.grants.push(grant);
  saveLedger(projectRoot, ledger, opts);
  return grant;
}

export function revokeGrant(projectRoot: string, id: string, opts: PathsOptions = {}): Grant {
  const ledger = readLedger(projectRoot);
  const grant = ledger.grants.find((g) => g.id === id);
  if (!grant) throw new Error(`No grant with id "${id}". Use "fh grant list".`);
  if (grant.revoked) throw new Error(`Grant "${id}" is already revoked (${grant.revoked}).`);
  grant.revoked = new Date().toISOString();
  saveLedger(projectRoot, ledger, opts);
  return grant;
}

export function isKnownScope(scope: string): boolean {
  return (KNOWN_SCOPES as readonly string[]).includes(scope);
}
