# Changelog

## 0.10.0

- The daemon now reads the reset time out of the Claude CLI's session-limit
  message ("resets 1pm (Europe/Amsterdam)") and pauses both lanes until that
  time plus a minute instead of retrying blind every 15 minutes; the founder
  notice carries the reset time. A deliberate wait-until-reset is no longer
  counted in the transport loop's alert streak, so hours of waiting no longer
  produce the false "message loop failed 4x in a row" alarm (#30).
- Follow-up to #30: a reset that reads as already past by less than an hour
  is treated as "about now" and falls back to the short blind retry instead
  of becoming a 24h pause; any limit pause is capped at 6h; the reset is read
  only from the limit phrase's own line, and a clock without a zone is
  refused rather than guessed (#33).
- An issue job interrupted by a session limit or auth failure resumes at the
  stage it reached: the worker persists `stage: "review"` in `queue.json`
  once the dev step really ended ok (branch on origin, report present), so
  the retry after the pause runs the reviewer only, not the whole chain
  again. A reply run that already wrote its outbox now sends it before
  pausing on limit/auth, instead of leaving the founder's answer unsent
  until the next reset (#34, #36).
- `setTyping(false)` on the Telegram transport now waits for the keepalive
  tick already on the wire, so a "typing" indicator can't land after the
  stop, and `stop()` no longer aborts a request mid-flight; the flaky
  keepalive test is pinned deterministically (#31).
- `ClaudeRunner` now awaits the `output.log` flush before resolving, closing
  the race behind the windows-latest-only `RESUME_ARG` flake in
  `runner.test.ts` (#35).
- CI: `actions/checkout` and `actions/setup-node` bumped to v5; one
  prettier-format commit over the repo (#32).

## 0.9.0

- The Telegram transport's per-poll abort guard is now bound to its own
  controller and always cleared, so a single `fetch failed` no longer leaves
  a stray 75s timer that aborts the next poll, which aborted the one after
  that, and so on until a daemon restart. Because a successful poll sat
  between every two aborts, the error streak never exceeded 1 and neither
  the 0.7.0 self-heal nor the founder alert could fire on that pattern (#28).
- `scripts/collect-metrics.mjs` now records the `start`/`end` date range npm
  reports alongside the weekly/monthly download counts, and the PM's digest
  instructions report the count as npm's figure "as of" that end date when
  the range lags, so a stale upstream stats pipeline no longer reads as an
  adoption plateau (#29).

## 0.8.0

- `fh init` now asks which model to pin for the team's sessions (or accept
  the default on Enter) instead of silently locking every new project to
  the schema default forever (#26).
- Each role (pm/dev/reviewer) can now run a different model via
  `roles.<role>.model` in `config.json`, falling back to the project's
  default model when unset. The PM now asks once which model to use per
  role and never repeats the question, and flags a newly-released Claude
  model as a digest proposal when it notices one (#27).

## 0.7.0

- The Telegram transport loop now self-heals a stuck connection pool
  instead of hanging forever until the daemon is restarted by hand: once
  the loop error streak hits the alert threshold, it throws away and
  recreates its underlying connection pool before the next retry. If that
  doesn't clear the stuck state, the streak keeps growing and the founder
  is still alerted as before.

## 0.6.0

- A resumed reply-mode turn now skips re-sending the full role
  template/profile/overlay/grants block when nothing watched has changed
  since the last turn in the same conversation — the resumed session
  already has it. Falls back to the full prompt automatically on session
  start or the moment any of those files' mtime changes, so an external
  edit (founder editing profile.md, a grant recorded/revoked outside the
  conversation) is never silently missed.

## 0.5.0

- Reply-mode PM runs now resume the claude CLI's own session instead of
  starting cold every time, so a founder follow-up doesn't pay for a full
  re-verification of everything the PM already checked minutes earlier; the
  session resets on the next morning digest or when the founder asks to
  start fresh, which the PM now does itself via the new `fh session reset`.
- Telegram messages from a chat_id other than the one paired at `fh init`
  are now logged instead of silently dropped, so a stray/foreign message
  shows up in the daemon log rather than vanishing invisibly (#25).

## 0.4.0

- Telegram transport now downloads the actual photo bytes for inbound
  messages (not just the caption), threading a local `imagePath` through to
  the PM prompt so the model can look at what the founder sent; a failed
  download still delivers the caption instead of dropping the message (#24).
- `authNotified`/`limitNotified` are reset on successful digest and role job
  completion, so a prior auth-failure or session-limit notice doesn't
  suppress a real new one after the team recovers (#23).

## 0.3.0

- The runner detects an expired Claude OAuth session via a structured field
  instead of guessing from error text, pauses work and notifies the founder
  once instead of burning retries on a session that can't succeed, and `fh
  doctor` now checks Claude credential freshness (#21).
- `ClaudeRunner` flushes the trailing unterminated stdout line after the
  child process closes instead of dropping it, so a session-limit hit
  landing in that final line is no longer misclassified as a generic error
  (#22).

## 0.2.0

- Reply-mode runs now stream live progress lines to Telegram (via `claude
  --output-format stream-json`) instead of a static "typing…" indicator, so
  the founder sees what the team is actually doing while a run is in
  progress (#20).
- `fh status` and the daemon heartbeat report the commit the daemon is
  actually running and flag drift against `HEAD`, so a stale long-lived
  daemon process after a merge is visible instead of silent (#14).
- Morning digest can collect GitHub stars/forks/watchers/open-issues and npm
  download counts via a project-owned prepare hook, feeding the 📊 metrics
  block (#19).
- Daemon retries lock acquisition on restart instead of dying inside the
  60s staleness window when the previous holder's pid is already dead (#16).

## 0.1.1

- Telegram: captioned photos are delivered to the PM using the caption as the
  message text; bare non-text updates (stickers, voice) get a polite one-time
  notice instead of being silently skipped (#10 — found in production by a
  migrated project's own PM).
- Pairing: `fh init` now persists and confirms the wizard's getUpdates offset,
  so the daemon no longer replays the pairing backlog and replies never lag
  one message behind (#11).
- `claude-settings.json` is generated into the state dir instead of the repo —
  role runs no longer dirty the working tree (#9).

All three were found by running the tool on real projects within 48 hours of
the first cutover, filed as issues, implemented by the project's own AI dev,
reviewed by its fresh-context reviewer, and merged through the gate.

## 0.1.0

First published release: `fh init` (scaffold + Telegram pairing), the
two-lane daemon (chat lane + serialized work lane), on-demand dev→review
chains with code-level post-conditions, cron digest, permissions ledger with
verbatim-quote grants, generated allowlist ("modest by default"), `fh
status/queue/logs/send/grant/doctor`, English role playbooks with
language mirroring. Dogfooded: issue #8 was built by this repo's own team.
