# Getting started

Prerequisites: Node >= 20, git, the [Claude Code](https://claude.com/claude-code)
CLI (logged in), and ideally `gh` (authenticated) — the team manages work
through GitHub issues.

```bash
npm i -g founder-helpers
cd your-project
fh init          # scaffolds .founder-helpers/, pairs your Telegram bot
fh doctor        # everything green?
fh daemon        # leave it running (see running-as-a-service.md)
```

Then, from your phone:

1. Write anything to your bot — the PM answers.
2. The PM proposes work as numbered items; you answer "yes 2" / "no 3"
   (in your language — the team mirrors it).
3. An approved issue starts immediately: dev run → fresh-eyes review → the
   verdict lands in your chat. Merging into your main branch stays YOUR
   per-instance decision until you record a standing grant:

```bash
fh grant record --scope git.merge_integration_branch \
  --quote "merge yourself when the review is green, stop asking"
```

Fill `.founder-helpers/profile.md` early — it is the difference between a
team that knows your product and one that guesses. Commit all of
`.founder-helpers/` and `.claude/skills/founder-helpers/`.

Updating: `npm update -g founder-helpers && fh init --refresh-skill`.
Your overlays, profile, grants and state are never touched by updates.
