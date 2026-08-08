# Contributing

Early days — the architecture is settled but most modules are still landing.

## Dev setup

```bash
npm install
npm run typecheck
npm test
npm run build
```

Node >= 20. No runtime dependencies beyond `zod`, `croner` and `proper-lockfile` — please
keep it that way; this codebase is meant to be read end-to-end by its users.

## Ground rules

- Tests run with a **mock runner and a mock Telegram server** — never assume a live Claude
  CLI or network in CI. Real-Claude smoke tests are manual and env-gated (`FH_E2E_REAL=1`).
- One issue-sized change per PR. The project dogfoods itself: from milestone M4 onward,
  most changes are implemented by a founder-helpers team run, so keep issues small enough
  for a single headless run.
- Cross-platform is not negotiable: anything touching processes, paths or encodings needs
  to work on Linux, macOS and Windows (CI runs all three).
