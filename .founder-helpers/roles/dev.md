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
- `gh issue view <N>` can print NOTHING with exit 0 — plain (twice in a row
  at the start of run 2026-09-08_06-15-36, fine later in the same run) and
  with `--comments` (3/3 on 2026-09-08). That reads exactly like an empty
  issue and is not a permission denial (the same shell runs `gh issue edit`
  fine). Never conclude the issue is empty: use
  `gh issue view <N> --json number,title,state,labels,body,comments`
  (optionally `> <state-dir>/issue.json` and Read the file).
- Fake timers work against the transport loop (`vi.useFakeTimers()` fakes
  `Date` too, which `sleep()` needs), but the loop only unwinds if the fetch
  mock rejects on `signal`'s abort — otherwise `stop()` awaits `loopDone`
  forever and the run hangs to timeout. Stop with the timers still fake:
  `const p = t.stop(); await vi.advanceTimersByTimeAsync(1000); await p;`
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
- A test fixture that hard-codes a wall-clock time and compares the parse
  against the real `Date.now()` is time-of-day flaky: the two session-limit
  reset fixtures ("11:30am (UTC)", "1pm (Europe/Amsterdam)") went red only
  when the suite happened to run within an hour after that clock (#33, seen
  2026-09-08 13:30 local). Compute the fixture's time from `Date.now()` and
  assert a range, don't pin a literal clock.
- `test/integration/telegram.test.ts` "typing keepalive ticks while composing
  and stops cleanly" used to be timing-sensitive: it counted chat actions
  across a real `setTimeout(150)`, so under full-suite parallel load one extra
  keepalive tick could land and it failed with `expected 4 to be 3` (seen on
  branches without #31 on 2026-09-08). #31 made `setTyping(false)` wait for
  the tick on the wire and the test awaits it, so on main after that merge a
  failure here is news, not the known flake.

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
