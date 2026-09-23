/**
 * Pure helpers for `codex exec --json` (JSON Lines). Codex's own event shape
 * — a `{"id": "...", "msg": {"type": "...", ...}}` envelope — is UNVERIFIED:
 * no `codex exec --help` output was available while this was written (#42).
 * Kept schema-tolerant for the same reason stream-json.ts is: a wrong or
 * drifted shape must degrade to "no progress events", not crash a headless
 * run. Do not touch stream-json.ts — Claude's shapes stay where they are.
 */

export type CodexStreamEvent =
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "text"; text: string }
  | { kind: "auth_error" }
  | { kind: "session_id"; id: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Best-effort signal that an "error" event describes an auth failure rather than e.g. a rate limit. */
const AUTH_ERROR_RE = /not logged in|unauthorized|401|authentication/i;

/**
 * Parse one JSON-lines line from `codex exec --json` into the events this
 * runner cares about. A line that fails to parse, or a `msg.type` we do not
 * recognize, yields no events — same rule stream-json.ts follows, so a CLI
 * version drift degrades a run instead of crashing it.
 */
export function parseCodexLine(line: string): CodexStreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed["msg"])) return [];
  const msg = parsed["msg"];
  const type = msg["type"];

  if (type === "session_configured" && typeof msg["session_id"] === "string") {
    return [{ kind: "session_id", id: msg["session_id"] }];
  }
  if (type === "error") {
    const message = typeof msg["message"] === "string" ? msg["message"] : "";
    return AUTH_ERROR_RE.test(message)
      ? [{ kind: "auth_error" }]
      : [{ kind: "text", text: message }];
  }
  if (type === "exec_command_begin") {
    const command = Array.isArray(msg["command"]) ? msg["command"].join(" ") : undefined;
    return [{ kind: "tool_use", name: "exec_command", input: { command } }];
  }
  if (type === "patch_apply_begin") {
    const target = typeof msg["path"] === "string" ? msg["path"] : undefined;
    return [{ kind: "tool_use", name: "patch_apply", input: { path: target } }];
  }
  if (type === "agent_message" && typeof msg["message"] === "string") {
    return [{ kind: "text", text: msg["message"] }];
  }
  return [];
}

const MAX_TARGET_LEN = 60;

function truncate(value: string): string {
  return value.length > MAX_TARGET_LEN ? `${value.slice(0, MAX_TARGET_LEN - 1)}…` : value;
}

/**
 * Tool name + short target only, mirroring stream-json.ts's describeToolUse
 * for Codex's own event names — never the raw input verbatim (an
 * exec_command's command can carry secrets).
 */
export function describeCodexAction(name: string, input: unknown): string {
  const record = isRecord(input) ? input : {};
  if (name === "exec_command") {
    const command = record["command"];
    return typeof command === "string" && command ? `running ${truncate(command)}` : "running";
  }
  if (name === "patch_apply") {
    const target = record["path"];
    return typeof target === "string" && target ? `editing ${truncate(target)}` : "editing";
  }
  return `using ${name}`;
}
