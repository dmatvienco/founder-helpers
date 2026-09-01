import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { StatePaths } from "../state/paths.js";
import type { Grant, ProjectConfig } from "../state/schema.js";
import { languageDirective } from "./language.js";

function templatesDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");
}

/** Shipped role template path — also used by ReplyLane to watch it for updates (e.g. `npm update -g`). */
export function roleTemplateFile(role: string): string {
  return path.join(templatesDir(), "roles", `${role}.md`);
}

/** Project overlay path — also used by ReplyLane to detect an external edit mid-session. */
export function roleOverlayFile(projectRoot: string, role: string): string {
  return path.join(projectRoot, ".founder-helpers", "roles", `${role}.md`);
}

/** Project profile path — also used by ReplyLane to detect an external edit mid-session. */
export function profileFile(projectRoot: string): string {
  return path.join(projectRoot, ".founder-helpers", "profile.md");
}

export interface AssembleContext {
  projectRoot: string;
  paths: StatePaths;
  config: ProjectConfig;
  role: string;
  runId: string;
  runDir: string;
  mode?: string | undefined;
  issue?: number | undefined;
  base?: string | undefined;
  /** Set when the work lane is busy, so a reply-mode PM defers git mutations. */
  activeWorkJob?: string | undefined;
  /** The founder's message this run must answer (reply mode). */
  inboundMessage?: string | undefined;
  /** Local path to a photo attached to the founder's message, if any (#24). */
  imagePath?: string | undefined;
  grants: Grant[];
  /**
   * Reply mode only: the resumed session already has the role/profile/
   * overlay/grants/language content from an earlier turn and nothing watched
   * has changed since — skip re-sending it, Run context only.
   */
  trimmed?: boolean;
}

export interface AssembledPrompt {
  promptFile: string;
  spawnPrompt: string;
}

function section(title: string, body: string): string {
  return `\n\n---\n\n# ${title}\n\n${body.trim()}`;
}

/**
 * Prompt = shipped English template + project profile + project overlay +
 * standing grants + language directive + run context. The template ships with
 * the npm package (upgraded globally); the overlay belongs to the project and
 * is where the team's self-teaching lands.
 */
export function assemblePrompt(ctx: AssembleContext): AssembledPrompt {
  const parts: string[] = [];

  const templateFile = roleTemplateFile(ctx.role);
  const overlayFile = roleOverlayFile(ctx.projectRoot, ctx.role);
  const projectProfileFile = profileFile(ctx.projectRoot);

  const hasTemplate = existsSync(templateFile);
  const hasOverlay = existsSync(overlayFile);
  if (!hasTemplate && !hasOverlay) {
    throw new Error(
      `Unknown role "${ctx.role}": no shipped template and no .founder-helpers/roles/${ctx.role}.md in the project.`,
    );
  }

  if (!ctx.trimmed) {
    if (hasTemplate) {
      parts.push(readFileSync(templateFile, "utf8").trim());
    }
    if (existsSync(projectProfileFile)) {
      parts.push(
        section(
          "Project profile (written by the founder)",
          readFileSync(projectProfileFile, "utf8"),
        ),
      );
    }
    if (hasOverlay) {
      const title = hasTemplate
        ? "Project overlay (your team's own knowledge — trust it)"
        : `Custom role definition: ${ctx.role}`;
      parts.push(section(title, readFileSync(overlayFile, "utf8")));
    }

    const active = ctx.grants.filter((g) => g.granted && !g.revoked);
    const grantLines = active.length
      ? active
          .map(
            (g) =>
              `- [${g.scope}] granted ${g.date}: "${g.quote}"` +
              (g.conditions ? ` — conditions: ${g.conditions}` : "") +
              ` (revoke with: fh grant revoke ${g.id})`,
          )
          .join("\n")
      : "None.";
    parts.push(
      section(
        "Active standing grants",
        `${grantLines}\n\n` +
          `Default rule: anything NOT covered by a grant above requires explicit per-instance ` +
          `approval from the founder. When unsure whether a grant covers an action, it does not — ask. ` +
          `Two things are NEVER covered by standing grants: communicating externally as the founder, ` +
          `and spending money.`,
      ),
    );

    parts.push(section("Language", languageDirective(ctx.config.language)));
  }

  const contextLines = [
    `- Role: ${ctx.role}`,
    ctx.mode ? `- Mode: ${ctx.mode}` : undefined,
    ctx.issue !== undefined ? `- Issue: #${ctx.issue}` : undefined,
    `- Base / integration branch: ${ctx.base ?? ctx.config.integrationBranch}`,
    `- Branch prefix for work branches: ${ctx.config.branchPrefix}`,
    `- Project root: ${ctx.projectRoot}`,
    `- State directory (yours to use, never committed): ${ctx.paths.root}`,
    `- Outbox directory (a founder-facing message = write a file here): ${ctx.paths.outboxDir}`,
    ctx.issue !== undefined
      ? `- Dev report contract: write ${path.join(ctx.paths.devDir, `report-issue${ctx.issue}.md`)}`
      : undefined,
    ctx.issue !== undefined
      ? `- Review verdict contract: write ${path.join(ctx.paths.devDir, `review-issue${ctx.issue}.md`)} — its FIRST line must be exactly one of ✅ / ⚠️ / ❌ plus one short sentence`
      : undefined,
    ctx.activeWorkJob
      ? `- NOTE: the work lane is currently busy (${ctx.activeWorkJob}). Do not perform git-mutating actions in this run; report status honestly instead.`
      : undefined,
    ctx.inboundMessage !== undefined
      ? `- The founder just wrote (answer THIS message):\n\n"""\n${ctx.inboundMessage}\n"""`
      : undefined,
    ctx.imagePath !== undefined
      ? `- The founder's message has a photo attached — read it with your file tools at: ${ctx.imagePath}`
      : undefined,
    `- Run id: ${ctx.runId}`,
  ].filter((l): l is string => Boolean(l));

  parts.push(
    section(
      "Run context",
      `${contextLines.join("\n")}\n\n` +
        `You are running HEADLESS: no human is present. Never ask questions, never wait for ` +
        `input, and never block waiting for asynchronous notifications or monitor callbacks — ` +
        `nobody can deliver them; poll synchronously inside a single step instead.`,
    ),
  );

  mkdirSync(ctx.runDir, { recursive: true });
  const promptFile = path.join(ctx.runDir, "prompt.md");
  writeFileSync(promptFile, `${parts.join("")}\n`, "utf8");

  const spawnPrompt = ctx.trimmed
    ? `Nothing about your role, profile, overlay or grants has changed since your last message in ` +
      `this conversation — you already know all of that, no need to re-read or re-verify it. Read ` +
      `the file "${promptFile}" for what's new this turn (just the Run context) and follow it. ` +
      `You are running headless with no human present — never ask questions and never wait for input.`
    : `Read the file "${promptFile}" and follow it exactly. ` +
      `You are running headless with no human present — never ask questions and never wait for input.`;
  return { promptFile, spawnPrompt };
}
