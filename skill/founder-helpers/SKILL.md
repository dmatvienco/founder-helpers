---
name: founder-helpers
description: Manage this project's founder-helpers AI team - diagnose the daemon, read team state, adjust roles/config/permissions, trigger runs. Use when the user asks about their AI team, its Telegram bot, digests, queued work, grants, or anything under .founder-helpers/.
---

# Managing founder-helpers in this project

This project runs an AI team (PM + developer + reviewer) on headless Claude
Code sessions, orchestrated by the `founder-helpers` daemon (`fh`). You — an
interactive Claude Code session — are the team's mechanic, not its fifth
member: prefer fixing the system over doing the team's work for it.

## Ground truth

- Committed config lives in `.founder-helpers/`: `config.json` (branches,
  labels, runner, digest cron, checks), `profile.md` (product context),
  `roles/*.md` (project overlays = the team's own memory; for roles without a
  shipped template the same file IS the role), `permissions.json` (standing
  grants, audit trail), `claude-settings.json` (GENERATED — never hand-edit;
  regenerate via `fh grant`).
- Everything else is in the state dir (outside the repo): run `fh status` to
  see it, or `fh doctor` for its path. Code-owned files there
  (`queue.json`, `transport-state.json`, `heartbeat.json`) must never be
  edited by hand or by a model — use the CLI.
- Machine contracts (verdict first line, outbox semantics, report paths):
  see `reference.md` next to this skill.

## Common operations

| Ask | Do |
|---|---|
| "Is the team alive?" | `fh status`, then `fh logs -n 100` if something looks off |
| "Full health check" | `fh doctor` |
| "Start/stop the daemon" | `fh daemon` in a terminal (foreground; Ctrl+C stops). Service recipes: docs/running-as-a-service.md in the founder-helpers repo |
| "Run the dev on issue N now" | `fh queue add --issue N` (daemon must be running) |
| "Send the digest now" | `fh queue add --digest` |
| "Test a role once" | `fh run <role> [--mode morning\|reply] [--issue N]` |
| "Say something to my chat" | `fh send --text "..."` |
| "What has the founder allowed?" | `fh grant list` |
| "Record/revoke a standing permission" | `fh grant record --scope <s> --quote "<exact words>"` / `fh grant revoke <id>` |
| "Update founder-helpers" | `npm update -g founder-helpers`, then `fh init --refresh-skill` here |

## Troubleshooting

- **Daemon not running / stale heartbeat**: check `fh logs`; a stale
  `daemon.lock` in the state dir clears itself (staleness 60s) — just start
  `fh daemon` again.
- **"Another daemon appears to be running"**: it probably is. Find it before
  overriding anything; two daemons = a split Telegram offset.
- **Bot silent**: `fh doctor` (token? pairing?), then `fh logs` for transport
  errors. Re-pair with `fh init` if the token changed.
- **A run "hangs"**: look at `runs/<id>/output.log` in the state dir; runs
  are tree-killed at timeout, so a stuck run resolves itself — the question
  is why (usually a check waiting on input; checks must be non-interactive).
- **Claude session limit**: the daemon already queues and retries by itself;
  don't restart anything, it resolves when the limit lifts.

## Editing the team

- Improve the team = edit overlays (`.founder-helpers/roles/*.md`) and
  `profile.md`, commit them. NEVER edit the shipped templates inside the npm
  package — updates would erase that.
- New custom role = create `.founder-helpers/roles/<name>.md` and add a
  `roles.<name>` entry in config.json; run it via `fh run <name>` or add it
  to the digest pipeline. Example: `examples/roles/marketer.md` in the
  founder-helpers repo.
- Permission questions: the default is modest (no pushes to the integration
  branch). Escalation is ALWAYS an explicit founder decision recorded via
  `fh grant record` with their verbatim words — never edit
  `permissions.json` by hand to grant yourself anything.
