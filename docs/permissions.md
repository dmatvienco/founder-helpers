# Permissions: modest by default, explicit by grant

Headless runs get a GENERATED Claude Code allowlist
(`claude-settings.json`, written into the state dir — never committed, never
hand-edited): git, gh, `fh`, and your configured check commands are allowed;
**pushing to the integration branch is denied**; force-push is always denied.
In headless `-p` mode a denied tool fails SOFT: the model receives the denial
and is required by its template to report the exact unblock recipe instead of
faking success.

## Running on Codex: the permissions caveat

Everything above — the generated allowlist/deny rules, including "do not push
to the integration branch without a `git.push_integration_branch` grant" — is
a **Claude Code settings-file feature**. It has **no Codex equivalent**. Under
`runner.kind: "codex"` (picked in `fh init`, or set directly in
`.founder-helpers/config.json`), those boundaries rest on Codex's own sandbox
mode plus the role prompts alone — there is no code-enforced backstop if a
prompt is ignored or a run goes off the rails.

`fh grant` and the permissions ledger below still work exactly the same way
under Codex — they remain the team's own authority record, and role prompts
still consult it. What changes is that **nothing below the model enforces
it**: no denied-tool failure, no generated allowlist. Pick Codex only with
that trade-off in mind.

## Standing grants

When you tell the team "do it and don't ask again", the PM records it:

```bash
fh grant record --scope git.merge_integration_branch \
  --quote "<your exact words>" [--conditions "tests green AND verdict ✅ only"]
```

`permissions.json` is committed — it is the team's authority audit trail:
scope, date, your verbatim quote, revoke id. `fh grant revoke <id>` undoes
any grant, and the settings layer regenerates on every change.

Scopes the CODE enforces (they lift/deny actual tool permissions):

| Scope | Effect |
|---|---|
| `git.merge_integration_branch` | PM may merge+push the integration branch when tests are green and the verdict is ✅ |
| `git.push_integration_branch` | direct pushes to the integration branch allowed |
| `runner.bypass_permissions` | headless runs use `--dangerously-skip-permissions` (doctor + daemon warn while active) |
| `deploy.production`, `spend.money` | reserved: consulted by role prompts |

Freeform scopes (any other string) bind through the prompt only.

## The two floors

Never covered by any grant, by design: **communicating with the outside
world as you** (posts, reviews, emails) and **spending money**. Those always
need your per-instance yes on the concrete text or amount.

## The merge gate

Default: per-instance "yes" + green checks + ✅ verdict + verdict's extra
checks done + clean tree. A standing merge grant replaces only the
per-instance yes for ✅ verdicts; a ⚠️ verdict still asks you.
