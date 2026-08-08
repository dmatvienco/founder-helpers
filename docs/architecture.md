# Architecture

One daemon per project (`fh daemon`, single instance via lockfile):

```
Telegram ──long-poll──► TelegramTransport ──► ReplyLane ──► PM run ──► outbox ──► Telegram
                          (owns offset)          │
                                                 │ fh queue add --issue N
                                                 ▼
                       Worker (work lane, serialized) ──► dev run ──► reviewer run
                          │  post-conditions: branch pushed? report? verdict line?
                          ▼
                       completion message (verdict first line + honest warnings)

Cron (digest schedule) ──► queue(digest) ──► prepare scripts ──► role runs ──► outbox
```

## Two lanes

The chat lane is always available: the PM answers even while the work lane
is busy (the reply prompt carries a "work lane busy" note so the PM defers
git mutations). The work lane is strictly serialized — one chain at a time.

## Ownership rules (the crash-proofing)

- Files a MODEL writes (reports, verdicts, outbox, pm/) are parsed only by
  models or checked for existence — the daemon's hot loop never parses them.
- Files CODE owns (queue.json, transport-state.json) are never written by a
  model; all writes are atomic (tmp → validate → rename) with .bak recovery.
- A queue job is removed only after its chain completes: a crash mid-job
  means a rerun, never a silent loss.
- A rejected message handler means redelivery: founder messages are never
  dropped, and honest-failure ladders cap the retries.

## Runs

Every role run = assembled prompt (shipped template + profile + overlay +
grants + language + run context) → `claude -p` with a hard timeout and a
process-tree kill → captured output → run record. Session-limit output
pauses the queue with a backoff instead of hammering the CLI.

## Brains vs memory

Templates (this package, English, updated by npm) carry the mechanics.
Overlays (`.founder-helpers/roles/*.md`, committed) carry everything the
team learns about YOUR project — the self-teaching loop writes there, so
updates never erase experience.
