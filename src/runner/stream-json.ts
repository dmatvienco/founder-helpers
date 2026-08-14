/**
 * Pure helpers for `claude -p --output-format stream-json` (JSON Lines).
 * Kept schema-tolerant on purpose: a CLI version drift must degrade to "no
 * progress events" rather than crash a headless run (#20).
 */

export type StreamJsonEvent =
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "text"; text: string }
  | { kind: "result"; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse one JSON-lines line into the events this runner cares about:
 * `tool_use` blocks (progress lines) and extracted assistant/result text
 * (session-limit detection). `thinking` blocks and anything unrecognized are
 * intentionally dropped — not meant for chat. Malformed lines yield no
 * events instead of throwing.
 */
export function parseStreamJsonLine(line: string): StreamJsonEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];

  if (parsed["type"] === "assistant" && isRecord(parsed["message"])) {
    const content = parsed["message"]["content"];
    if (!Array.isArray(content)) return [];
    const events: StreamJsonEvent[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block["type"] === "tool_use" && typeof block["name"] === "string") {
        events.push({ kind: "tool_use", name: block["name"], input: block["input"] });
      } else if (block["type"] === "text" && typeof block["text"] === "string") {
        events.push({ kind: "text", text: block["text"] });
      }
    }
    return events;
  }

  if (parsed["type"] === "result" && typeof parsed["result"] === "string") {
    return [{ kind: "result", text: parsed["result"] }];
  }

  return [];
}

/**
 * Split a stdout chunk stream into complete lines, holding the trailing
 * partial line for the next call. Node's stdout chunking never guarantees
 * line boundaries, on any OS.
 */
export function splitLines(pending: string, chunk: string): { lines: string[]; pending: string } {
  const parts = (pending + chunk).split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, pending: rest };
}

const MAX_TARGET_LEN = 60;

function truncate(value: string): string {
  return value.length > MAX_TARGET_LEN ? `${value.slice(0, MAX_TARGET_LEN - 1)}…` : value;
}

const TOOL_VERBS: Record<string, string> = {
  Read: "reading",
  Write: "writing",
  Edit: "editing",
  NotebookEdit: "editing",
  Grep: "searching",
  Glob: "listing",
  Bash: "running",
  WebFetch: "fetching",
  WebSearch: "searching the web for",
  Task: "delegating to",
  TodoWrite: "updating the todo list",
};

const TARGET_FIELDS: Record<string, string[]> = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Grep: ["pattern"],
  Glob: ["pattern"],
  Bash: ["command"],
  WebFetch: ["url"],
  WebSearch: ["query"],
  Task: ["subagent_type", "description"],
};

/**
 * Tool name + short target only — NEVER the raw `tool_use.input` verbatim.
 * A `Bash` command in particular can carry secrets (e.g. an Authorization
 * header); truncating avoids echoing the tool's full input into chat.
 */
export function describeToolUse(name: string, input: unknown): string {
  const verb = TOOL_VERBS[name] ?? `using ${name}`;
  const record = isRecord(input) ? input : {};
  const fields = TARGET_FIELDS[name] ?? [];
  let target: string | undefined;
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value) {
      target = value;
      break;
    }
  }
  return target ? `${verb} ${truncate(target)}` : verb;
}
