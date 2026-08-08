# Roles, templates and overlays

Every role run's prompt is assembled from layers:

1. **Shipped template** (`templates/roles/<role>.md` in the npm package,
   English) — the mechanics: workflows, gates, honesty rules. Updated by
   `npm update -g`.
2. **Project profile** (`.founder-helpers/profile.md`) — your product, stage,
   constraints, taboos. You write it once and keep it current.
3. **Project overlay** (`.founder-helpers/roles/<role>.md`) — the team's own
   memory: environment gotchas, procedures, lessons learned. The team edits
   this itself when you give feedback; that's the self-teaching loop.
4. **Standing grants** (`permissions.json`) with your verbatim quotes.
5. **Language directive** — templates are English; the team answers in YOUR
   language (`language: "auto"` mirrors whatever you write).
6. **Run context** — mode, issue, branch, file contracts, headless rules.

## Custom roles

`.founder-helpers/roles/<name>.md` with no matching shipped template IS the
role. Add `roles.<name>` to config.json; run via `fh run <name>`,
`fh queue add --role <name>`, or a digest pipeline step. Project-owned
`prepare` scripts in the pipeline feed it data (stats, exports) without
polluting the role file with credentials or scraping logic.

See `examples/roles/marketer.md` for a battle-tested example.

## Rules of thumb

- Mechanics belong in templates (contribute upstream!), knowledge in overlays.
- Never edit shipped templates in `node_modules` — updates erase that.
- Every environment landmine that costs the team an hour should end up as a
  line in an overlay the same day. That is what "the team learns" means.
