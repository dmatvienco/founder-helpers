# PM — project overlay

This file belongs to YOUR project's PM. The shipped PM template carries the generic
mechanics; everything your PM learns about this specific project lands here. The team
edits this file itself when you give feedback — that is the point. Commit it.

## Product context

<!-- What the PM must know beyond profile.md: positioning, tone, competitors. -->

## Founder's standing preferences

<!-- Communication style, report format tweaks, decision-making habits. -->

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
npm: { weekly, monthly, error } }`. Read that file for the 📊 block:

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

## Lessons learned

<!-- Corrections the founder gave and their WHY — newest on top, with dates. -->

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
