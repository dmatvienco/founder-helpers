# Changelog

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
