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
- Headless dev runs on this box: the Bash tool's cwd is already the project
  root, and wrapping a command in `cmd /c "cd /d ... && ..."` triggers a
  permission-approval prompt that nobody is present to answer — the run just
  hangs until timeout. Call `npm run ...` / `git ...` directly instead.
- `proper-lockfile`'s `stale` option is floored at 2000ms internally
  (`lib/lockfile.js`: `Math.max(options.stale || 0, 2000)`), no matter what
  you pass. Any code or test that tunes lock staleness below 2s silently gets
  2000ms instead — budget retry timeouts against that real floor, not the
  number you passed in.
- `npm run format` rewrites ALL of `src/**` + `test/**`, and ~15 committed
  files are currently prettier-dirty — running it silently drags them into
  your diff. Run it, then `git restore` everything except your own files
  before committing (checked 2026-09-07).
- `npx <anything>` needs an approval prompt that a headless run cannot
  answer. To run one test file use `npm test -- <path>`, which goes through
  the allowed `npm` script.
- Fake timers work against the transport loop (`vi.useFakeTimers()` fakes
  `Date` too, which `sleep()` needs), but the loop only unwinds if the fetch
  mock rejects on `signal`'s abort — otherwise `stop()` awaits `loopDone`
  forever and the run hangs to timeout. Stop with the timers still fake:
  `const p = t.stop(); await vi.advanceTimersByTimeAsync(1000); await p;`
- `gh issue view <N> --comments` prints NOTHING here (3/3 on 2026-09-08) —
  exit 0, empty output, which reads exactly like an empty issue. Plain
  `gh issue view <N>` works; for the body plus comments in one go use
  `gh issue view <N> --json number,title,state,labels,body,comments`.
- When the account's usage limit is reached, a role run dies in under a
  second: the run dir holds only `prompt.md` and a short `output.log` ending
  in `"is_error":true … "api_error_status":429`, and no report is written.
  The queue job survives and is re-dispatched every cycle, so the SAME issue
  keeps arriving — on 2026-09-08, 68 run logs between 06:44 and 10:52 UTC end
  in that 429 (grep the runs dir for `"api_error_status":429`). So a
  re-dispatched issue does NOT
  mean the work is missing: check `git log --oneline` and whether your report
  file already exists. If the branch is pushed and the report is there,
  re-verify it (checks, diff vs base) and report that — do not redo the work.
- A run that dies mid-workflow leaves the shared checkout on a DETACHED HEAD
  at whatever `team/…` branch it was on. `git status --porcelain` is empty in
  that state, so step 0's clean-tree gate passes and nothing looks wrong —
  check `git rev-parse --abbrev-ref HEAD` too (it prints `HEAD` when
  detached) and re-attach before working.

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
