# founder-helpers reference

## CLI

- `fh init` — scaffold `.founder-helpers/` + state dir; interactive Telegram
  pairing; `--no-telegram` skips pairing; `--refresh-skill` re-copies this
  skill after a package update.
- `fh daemon` — foreground daemon: chat lane (PM replies), work lane
  (serialized dev→reviewer chains), cron digest, heartbeat.
- `fh run <role> [--mode m] [--issue N] [--base B] [--timeout min]` — one role
  run through the same assembler/runner the daemon uses.
- `fh queue add --issue N [--base B] | add --role NAME | add --digest`,
  `fh queue` (list), `fh queue remove <id>`.
- `fh status` / `fh logs [-n N] [-f]` / `fh doctor`.
- `fh send --text "..." | --file f | --photo img [--caption-file f]`.
- `fh grant record --scope S --quote "..." [--conditions "..."] | list |
  revoke <id>`.

## Machine contracts (code parses these — do not improvise)

- Review verdict `dev/review-issue<N>.md`: FIRST line starts with ✅ / ⚠️ / ❌
  plus one sentence.
- Dev report `dev/report-issue<N>.md`: existence is checked after every dev
  run, as is the branch `<prefix>issue-<N>` on origin.
- Outbox: write a NEW file into `outbox/` to message the founder
  (`.txt`/`.md` text, images as photos, `<img>.caption.txt` sidecar). The
  daemon sends and deletes. In reply mode an outbox file is the success
  signal.
- `queue.json` / `transport-state.json` / `heartbeat.json`: code-owned.
  Mutate the queue only via `fh queue`.

## Permission model

- Headless runs use a GENERATED allowlist (`claude-settings.json` in the
  state dir): git/gh/check-commands allowed; pushing to the integration
  branch denied until `git.merge_integration_branch` or
  `git.push_integration_branch` is granted; force-push always denied.
  Denials in headless fail soft — the role reports the grant recipe.
- `runner.bypass_permissions` grant is the only path to
  `--dangerously-skip-permissions`, and `fh doctor` + the daemon warn while
  it is active.
- Grants carry the founder's verbatim quote and a revoke id — they are the
  audit trail. Committed with the repo.

## State dir layout

`secrets.json`, `transport-state.json`, `queue.json`, `heartbeat.json`,
`claude-settings.json` (GENERATED, regenerated on every run/grant change),
`runs/<id>/{prompt.md,output.log,record.json}`, `outbox/`, `pm/` (PM-owned),
`dev/` (reports/verdicts/screens), `logs/daemon.log(.1..3)`.
