# Machine contracts

Formats that CODE parses. Roles must follow them exactly; changing them is a
founder-helpers code change, not a role-file edit.

## Review verdict file — `dev/review-issue<N>.md` (state dir)

The FIRST line must start with exactly one of `✅` `⚠️` `❌` followed by one
short sentence. The daemon reads only this line for the completion
notification; everything after it is for humans.

## Dev report file — `dev/report-issue<N>.md` (state dir)

Free-form markdown, but its EXISTENCE is a post-condition: no report file
after a dev run = the daemon reports the run as suspect to the founder.
The same applies to the branch: `<prefix>issue-<N>` must exist on origin.

## Outbox — `outbox/` (state dir)

- A role "says something to the founder" by writing a NEW file here:
  `.txt` / `.md` → sent as text; `.png` / `.jpg` / `.jpeg` / `.webp` → sent as
  a photo, with an optional `<filename>.caption.txt` sidecar as its caption.
- The daemon sends and DELETES each file. A failed send leaves the file in
  place for the next flush — founder-facing content is never dropped.
- In reply mode, producing at least one outbox file IS the success signal:
  no outbox file → the run counts as failed and is retried (3 strikes, then
  an honest apology to the founder).

## Work queue — `queue.json` (state dir)

Code-owned. Roles NEVER write it directly — they call `fh queue add ...`.
A job leaves the queue only after its chain completes.

## Transport state — `transport-state.json` (state dir)

Code-owned, written by the transport only. Corrupting it from a role session
is impossible by design; do not try.

## State directory map

- `pm/` — the PM's territory (journal, proposals.json, notes). Only the PM
  parses files here; the daemon never does.
- `dev/` — dev reports, review verdicts, screenshots for the founder.
- `runs/<id>/` — assembled prompt, output log and record of every run.
- `outbox/` — see above. `logs/` — rotated daemon logs.
- `secrets.json` — credentials. Never print, never commit, never log.
