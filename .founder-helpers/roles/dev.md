# Developer — project overlay

This file belongs to YOUR project's developer. The shipped template carries the generic
workflow (one issue per run, branch discipline, checks, honest reports); everything
project-specific lands here. The team edits this file itself as it learns. Commit it.

## Environment gotchas

- TypeScript 7 (native) is in use: `tsconfig.json` needs `"types": ["node"]`
  or process/console/import.meta all fail to resolve. Don't "fix" that by
  downgrading TS.
- zod v4: an object-of-defaults needs `.prefault({})`, not `.default({})` —
  `.default()` now takes the OUTPUT type. See src/state/schema.ts.
- Windows dev box: run repo commands via `cmd /c "cd /d <dir> && ..."` when a
  shell's cwd is unreliable; never rely on POSIX-only shell syntax in scripts
  that CI runs on the Windows leg.

## Build, test and smoke procedures

- `npm run typecheck && npm test` must be green before any push; `npm run
  build` before packing. CI repeats all three on 3 OSes — a "works on my
  machine" push wastes a whole matrix run.
- New process/paths/encoding code needs a per-OS test (see tree-kill tests
  for the pattern), not a comment promising it works.

## Repo conventions

- Conventional-commit style messages (`feat:`, `fix:`, `chore:`, `docs:`),
  reference the issue like `(#8)`.
- Zero new runtime dependencies without a founder yes; hand-rolled > imported
  for small things — the codebase is meant to be read end-to-end.
- Errors shown to users must say what to DO, not just what broke.

## Lessons learned

<!-- Corrections from the founder or the reviewer, with dates and the WHY. -->
