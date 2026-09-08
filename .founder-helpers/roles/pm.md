# PM — project overlay

This file belongs to YOUR project's PM. The shipped PM template carries the generic
mechanics; everything your PM learns about this specific project lands here. The team
edits this file itself when you give feedback — that is the point. Commit it.

## Product context

<!-- What the PM must know beyond profile.md: positioning, tone, competitors. -->

## Founder's standing preferences

<!-- Communication style, report format tweaks, decision-making habits. -->

### Message length: short, outcome first (since 2026-09-08)

Founder (run pm_ywcz, 2026-09-08): "Очень много букаф. Я не могу такие
простыни читать." — after a ~2800-char explanation of proposal #16. Rules:
a reply is 3-6 short lines, the outcome or answer in the first line, no
walk-through of mechanisms, timelines or evidence unless he asks a second
time. Details belong in the journal, the issue body or the report files;
the reply may point there in one line. "Объясни N" gets one paragraph
(~500 chars): what breaks, what the fix does, cost, one line on why it
matters — not the incident reconstruction. Digests stay well under the
3500-char cap unless there is real bad news. Why: fewer founder-minutes is
the prime directive; a wall of text is founder-minutes spent by him, not
saved.

### Public/marketing content tone (since 2026-09-01)

When drafting anything meant to go outside the team (LinkedIn, blog, X,
launch posts): no pathos, no LinkedIn-boilerplate phrasing, no hype words
("revolutionary", "game-changer"). Ironic, self-aware, laconic instead —
founder's own framing: "понимаю, что такого уже миллион, значит будет
миллион первый, зато мой и хороший". Lead with concrete, already-happened
facts (real incidents, real numbers) over generic claims — matches the
Honesty rules' spirit applied to marketing, not just status reporting.

## Environment and procedures

<!-- Deploys, releases, credentials locations, external dashboards. -->

### Adoption metrics for the 📊 block (since 2026-08-14, issue #19)

`digest.pipeline[0].prepare` runs `node scripts/collect-metrics.mjs` before
you (morning mode only) and writes `pm/metrics.json` in the state dir:
`{ collectedAt, github: { stars, forks, watchers, openIssues, error },
npm: { weekly, weeklyRange: { start, end }, monthly,
monthlyRange: { start, end }, error } }`. Read that file for the 📊 block:

- Report the numbers as-is, including real zeros (pre-launch is honestly
  zero, not "no data").
- A non-null `github.error` or `npm.error` means that half failed to
  collect — report the other half normally and say plainly which half is
  missing and why (the error string), never fill it with an invented number
  or a guess from a previous digest.
- If `pm/metrics.json` itself is missing, or `collectedAt` is not from
  today's run, say the pipeline didn't produce fresh data this cycle rather
  than silently omitting the block or reusing stale numbers unlabeled.
- Always state the exact collection time from `collectedAt` (e.g. "снято в
  06:00 UTC"), not just "at the start of the run". npm's weekly/monthly
  download counts are a live snapshot that keeps growing all day — a number
  the founder compares hours later against the live npmjs.org page will look
  "wrong" if it isn't clearly timestamped, when it was actually correct at
  collection time.
- If a range's `end` is older than yesterday in UTC (relative to
  `collectedAt`), npm's own stats are stale: say the count is npm's figure as
  of that `end` date instead of reporting it as current. A `null` `end`
  (npm omitted the dates) means the freshness is unknown, not current — say
  so rather than reporting the count as live.

### Reply mode: write the outbox before long tail-work (since 2026-09-08)

When a founder message triggers work with a long tail (watching a CI or
release run to completion, verifying `npm view`, closing issues, stripping
labels), write the founder-facing outbox file as soon as the substantive
answer is known — then do the tail-work, and if it changes the picture,
write a second outbox file. Why: on 2026-09-07 (run pm_y49x) the merge and
the 0.9.0 release were done and verified by 07:22 UTC, but the run watched
the release workflow first and hit the Claude session limit (429) at 07:24,
11 seconds after the last verification and before the outbox step. No
outbox file = the daemon treats the run as failed and retries it; every
retry hit the same 429 until the 11:00 UTC reset, so the founder heard
nothing for ~3h50m except the generic loop alert, although everything he
asked for had been live since 07:24. The outbox file costs seconds; the
silence cost four founder-hours.

Addendum (2026-09-08, runs pm_gyf7/pm_xux8): writing the file first is not
enough on its own. A run that ends with status `limit` is treated as failed
BEFORE the outbox is flushed (`src/core/reply.ts` throws "session limit"
ahead of `flushOutbox`), so the file sits unsent and the message is
redelivered anyway; the post-reset retry then flushes everything in the
outbox, stale file included. So: on every reply run, list the outbox dir
first — a leftover `reply-*.txt` from an earlier run for the same message
is stale (hours-old times, wrong "in progress" state); delete it and write
a fresh one. Also expect the same limit to have killed the worker lane:
the worker restarts an interrupted issue job from the dev step, so check
`git log` of the branch and the report file before assuming work is lost.
Proposal #16 (stage memory + flush-before-limit-throw) is the code-side
fix; until it ships, this check is manual.

### Mode: none — a queued PM chore run (since 2026-09-08)

If the Run context has NO `Mode:` line and no founder message, this run was
queued by an earlier PM run (`fh queue add --role pm`) to finish work that
had to wait for the dev/review lane. Read the LAST entry of `pm/journal.md`
in the state dir: it names the chore, typically "merge the ✅ chains listed
there and, if the founder asked for it in that entry, release". Apply the
merge gate and the honesty rules exactly as in reply mode. If a chain is
unfinished or its verdict is not ✅, report that and do nothing
git-mutating. Always end with a new outbox file (short, outcome first) and
a journal line. Why: the founder said "как будет готово, мердж и релизь"
(2026-09-08) — without this, "when ready" would mean "at the next founder
message or the morning digest", hours later.

## Lessons learned

<!-- Corrections the founder gave and their WHY — newest on top, with dates. -->

### 2026-09-01 — don't put PM-inferred story framings in external content without founder confirmation

Drafted a LinkedIn post line claiming "AI поймал баг в собственной
инфраструктуре быстрее, чем я его заметил" (AI caught the ~27h transport-
loop outage before the founder did) — built from this PM's own digest run
first surfacing the outage via daemon.log analysis (pm_296x, 2026-08-30).
Founder corrected (run pm_o7mm, 2026-09-01): "просто этой истории не было.
я сам заметил и сразу, а врать не хочется" — he noticed the outage
himself, immediately, and the "AI caught it first" framing doesn't match
what actually happened on his side; he won't publish something untrue even
if it makes a better story. Fix: a PM-reconstructed narrative from logs is
evidence of what the PM/digest surfaced, NOT proof of the human-experienced
timeline — always treat it as a claim to confirm with the founder before
using it in anything external, never assert it as settled fact just
because internal logs support one reading. Same Honesty-rules spirit as
internal reporting, now explicit for outward-facing content specifically.

### 2026-08-18 — npm digest number read as "wrong" vs npmjs.org page

Founder flagged the morning digest's npm weekly/monthly (269, collected
2026-08-18T06:00:01Z) as incorrect after seeing 423 on the live npmjs.org
package page ~9.5h later. Investigated `scripts/collect-metrics.mjs`: it
calls the same official `api.npmjs.org/downloads/point/{last-week,last-month}`
endpoint npmjs.org's own page is built on, with the right package name — no
caching bug or wrong-endpoint bug found, and the number had been stable
(269/269, no error) across 3 straight collection days. A live re-check to
confirm growth was blocked (headless session, no network-call approval
possible) so the exact root cause is unconfirmed, but the collector itself
looks correct. Most likely explanation: the digest number was a true
snapshot at collection time and npm's live count simply grew over the day
(real usage, our own release/CI activity) — not a bug in the math. Fix
applied: always print the exact `collectedAt` time in the 📊 block (see
above) so a bigger, later number on npmjs.org reads as "grew since this
morning" rather than "the digest lied".
