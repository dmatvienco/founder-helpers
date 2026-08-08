import { parseArgs } from "node:util";
import { isKnownScope, readLedger, recordGrant, revokeGrant } from "../permissions/ledger.js";
import { KNOWN_SCOPES } from "../state/schema.js";

export async function grantCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;

  if (sub === "record") {
    const { values } = parseArgs({
      args: rest,
      options: {
        scope: { type: "string" },
        quote: { type: "string" },
        conditions: { type: "string" },
        channel: { type: "string" },
      },
    });
    if (!values.scope || !values.quote) {
      console.error('Usage: fh grant record --scope <scope> --quote "<founder\'s exact words>" [--conditions "..."]');
      console.error(`Known scopes (enforced in code): ${KNOWN_SCOPES.join(", ")}`);
      console.error("Freeform scopes are allowed too — they bind through the prompt only.");
      return 1;
    }
    try {
      const grant = recordGrant(process.cwd(), {
        scope: values.scope,
        quote: values.quote,
        conditions: values.conditions,
        channel: values.channel,
      });
      console.log(`recorded ${grant.id} [${grant.scope}]`);
      if (!isKnownScope(grant.scope)) {
        console.log("note: freeform scope — enforced via the prompt, not the settings layer");
      }
      console.log(`revoke any time: fh grant revoke ${grant.id}`);
      console.log("permissions settings regenerated; commit .founder-helpers/ to keep the audit trail");
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  if (sub === "revoke") {
    const id = rest[0];
    if (!id) {
      console.error("Usage: fh grant revoke <grant-id>");
      return 1;
    }
    try {
      const grant = revokeGrant(process.cwd(), id);
      console.log(`revoked ${grant.id} [${grant.scope}]; permissions settings regenerated`);
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  // default: list
  const ledger = readLedger(process.cwd());
  if (ledger.grants.length === 0) {
    console.log("no grants recorded — the team runs in modest mode");
    return 0;
  }
  for (const g of ledger.grants) {
    const state = g.revoked ? `REVOKED ${g.revoked}` : "active";
    console.log(`${g.id}  [${g.scope}]  ${state}`);
    console.log(`    ${g.date}: "${g.quote}"${g.conditions ? `  (conditions: ${g.conditions})` : ""}`);
  }
  return 0;
}
