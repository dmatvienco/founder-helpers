# Changelog

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
