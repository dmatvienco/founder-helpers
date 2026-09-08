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
- `npm run format` rewrites ALL of `src/**` + `test/**`. The 15 committed
  files that used to be prettier-dirty were formatted in #32, so on a clean
  main the command is now a no-op and safe to run. If it does touch files you
  did not edit, main has drifted again: commit that as its own
  `style: prettier format` commit rather than mixing it into your diff
  (checked 2026-09-08).
- `npx <anything>` needs an approval prompt that a headless run cannot
  answer. To run one test file use `npm test -- <path>`, which goes through
  the allowed `npm` script.
- CI does NOT run on `team/*` pushes: `.github/workflows/ci.yml` triggers only
  on `push` to `main` and on `pull_request`, and this repo opens no PRs. So an
  issue that says "verify on the CI run your branch push triggers" cannot be
  satisfied from a dev run — `gh run list --branch team/issue-N` stays empty.
  Verify workflow edits by reading the upstream action manifest (e.g.
  `gh api repos/actions/checkout/contents/action.yml?ref=v5` → `runs.using`),
  and leave the live confirmation to the PM's post-merge run on main.
- A green local `npm test` on this Windows box does NOT imply a green CI
  windows-latest leg: `test/integration/runner.test.ts` fails there
  intermittently (`expected '' to contain 'RESUME_ARG:none'`) while passing
  locally. Check `gh run list --limit 5` before blaming your own diff for a
  red main (seen 2026-09-08 on run 34193299638).
- Fake timers work against the transport loop (`vi.useFakeTimers()` fakes
  `Date` too, which `sleep()` needs), but the loop only unwinds if the fetch
  mock rejects on `signal`'s abort — otherwise `stop()` awaits `loopDone`
  forever and the run hangs to timeout. Stop with the timers still fake:
  `const p = t.stop(); await vi.advanceTimersByTimeAsync(1000); await p;`

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
