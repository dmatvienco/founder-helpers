# Migrating from a home-grown script setup

(Being written for real during the migration of MorningWorkout — the
PowerShell-based predecessor this tool grew out of. Will be filled with the
actual step-by-step and the potholes found.)

The short version:

1. `fh init` in the project (pair with your EXISTING bot token — one bot,
   one daemon: the old poller must be OFF before the new one starts, or the
   two will fight over the getUpdates offset).
2. Move project specifics from your old role prompts into
   `.founder-helpers/roles/*.md` overlays and `profile.md`.
3. Re-record the standing permissions you had granted informally:
   `fh grant record ... --quote "<the founder's original words>"` — keep the
   original dates and quotes in `--quote`; honesty of the audit trail beats
   tidiness.
4. Custom roles (stats collectors, marketers) become digest pipeline steps
   with `prepare` scripts.
5. Disable the old schedulers/daemons, start `fh daemon`, run one full day in
   the new world, and only then archive the old scripts.
