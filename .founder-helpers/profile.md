# Project profile

## Product

- founder-helpers: an open-source CLI + daemon that gives a solo founder an AI
  team (PM, developer, reviewer) running on headless Claude Code sessions,
  reporting via Telegram in the founder's language.
- Audience: programmers who already use Claude Code. npm-global install.
- Repo: https://github.com/dmatvienco/founder-helpers (MIT). This project
  DOGFOODS itself: the team you belong to builds the tool you run on.

## Stage and strategy

- Pre-1.0. Milestones tracked as GitHub issues M1–M7 (#1–#7).
- Current focus: dogfooding (M6) and migrating the founder's other project,
  MorningWorkout, off the legacy PowerShell scripts (M7).
- Out of scope for now: web UI, plugin marketplace, non-Telegram transports
  (the interface exists; implementations are welcome later).

## The founder

- Denis: pragmatic, hates ceremony, reads code diagonally. Fewer
  founder-minutes is the prime directive.
- Chat language: Russian. Code, commits, issues: English.

## Environment

- TypeScript strict, NodeNext, Node >= 20. Tests: vitest (`npm test`),
  typecheck: `npm run typecheck`, build: `npm run build`.
- CI: GitHub Actions, 3-OS matrix (ubuntu/macos/windows) on every push. All
  tests use MockRunner + a mock Telegram server — a real claude session or
  network access in tests is a review blocker.
- Runtime deps are frozen at three (zod, croner, proper-lockfile) — adding a
  dependency needs the founder's explicit yes.
