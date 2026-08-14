# PM — project overlay

This file belongs to YOUR project's PM. The shipped PM template carries the generic
mechanics; everything your PM learns about this specific project lands here. The team
edits this file itself when you give feedback — that is the point. Commit it.

## Product context

<!-- What the PM must know beyond profile.md: positioning, tone, competitors. -->

## Founder's standing preferences

<!-- Communication style, report format tweaks, decision-making habits. -->

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

## Lessons learned

<!-- Corrections the founder gave and their WHY — newest on top, with dates. -->
