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
- `gh issue view <N>` sometimes returns completely empty (twice in a row at
  the start of run 2026-09-08_06-15-36, then fine later in the same run). It
  is not a permission denial — the same shell runs `gh issue edit` fine. Don't
  conclude the issue is empty: fall back to
  `gh issue view <N> --json number,title,body,comments,labels > <state-dir>/issue.json`
  and Read the file.
- Fake timers work against the transport loop (`vi.useFakeTimers()` fakes
  `Date` too, which `sleep()` needs), but the loop only unwinds if the fetch
  mock rejects on `signal`'s abort — otherwise `stop()` awaits `loopDone`
  forever and the run hangs to timeout. Stop with the timers still fake:
  `const p = t.stop(); await vi.advanceTimersByTimeAsync(1000); await p;`
- A test fixture that hard-codes a wall-clock time and compares the parse
  against the real `Date.now()` is time-of-day flaky: the two session-limit
  reset fixtures ("11:30am (UTC)", "1pm (Europe/Amsterdam)") went red only
  when the suite happened to run within an hour after that clock (#33, seen
  2026-09-08 13:30 local). Compute the fixture's time from `Date.now()` and
  assert a range, don't pin a literal clock.
- `test/integration/telegram.test.ts` "typing keepalive ticks while composing
  and stops cleanly" is timing-sensitive: it counts chat actions across a real
  `setTimeout(150)`, so under full-suite parallel load one extra keepalive tick
  can land and it fails with `expected 4 to be 3`. Seen once on 2026-09-08,
  green on re-run and green alone. Re-run before believing you broke it.

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
