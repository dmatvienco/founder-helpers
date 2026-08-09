# founder-helpers

[![CI](https://github.com/dmatvienco/founder-helpers/actions/workflows/ci.yml/badge.svg)](https://github.com/dmatvienco/founder-helpers/actions/workflows/ci.yml)

**Founder's little helpers** — your own AI team (a PM, a developer and a reviewer) built on
headless [Claude Code](https://claude.com/claude-code) runs. The PM talks to you in Telegram,
in your language; the team takes issues, writes code in branches, reviews it with fresh eyes,
and merges only when you say yes.

**→ [The idea, for engineers — with diagrams](docs/README.md)**

Born as a set of scripts that has been running a real product's team since July 2026;
being rebuilt here as a portable, installable tool.

## Status

0.1.x — young but real: the full loop (Telegram → PM → work queue → dev run →
fresh-eyes review → gated merge) is implemented, tested on a 3-OS CI matrix,
and dogfooded — [#8](https://github.com/dmatvienco/founder-helpers/issues/8)
was built by this repo's own AI team. Docs: [getting started](docs/getting-started.md).

## How it works

- `npm i -g founder-helpers`
- `fh init` in your project: role overlays and the team's knowledge base live in
  `.founder-helpers/` (committed); secrets stay outside the repo
- `fh daemon`: Telegram long-poll plus a work queue of dev → review runs that start
  when you say go — no fixed schedules for the dev
- The team is **self-teaching**: your feedback lands in project overlay files, not in the
  shipped templates, so `npm update -g` upgrades the brains without erasing what your
  team has learned about your project
- A **permissions ledger** records your "do it and don't ask again" grants — with your exact
  words, a date, and a revoke command. Merging to your main branch stays gated until you
  explicitly grant it

## License

MIT
