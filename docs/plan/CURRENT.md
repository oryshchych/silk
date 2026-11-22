# CURRENT.md: working state

> Memory between sessions. State lives here and in git, not in context.
> **The agent updates this file as the last action of every session.**

## Current phase

**Phase 0.5, "money skeleton"** (`phase-005-money-skeleton.md`). The owner gave
the explicit go-ahead on 2026-11-22. The work starts in a NEW session; the
session that finished phase 0 does not continue into it.

Phase 0 closed with **23 of 24** acceptance criteria verified by execution.
Open: no. 20, "`pg_dump` to R2 by schedule". The first nightly run is at
03:00 Kyiv on 2026-11-23; see next step.

Standing rules (also in `AGENTS.md` section 0):
- all technical text is English; Ukrainian only for site content
- one phase per session: report, update this file, stop

Infra: staging `https://staging.damazla.com` (basic auth), Hetzner CAX11 (ARM,
4 GB, 49.12.64.197), Dokploy `https://dokploy.damazla.com`, daily dump to R2.

## Done

- `6728094`..`3d48a11` monorepo, tooling, env, compose, PG 18 image, CI
- PR #1-#2 migrations + Testcontainers, accountant answers (fiscal, seams)
- PR #3 `createDb()`/`Tx`, seed; #4-#6 `Money`, DTO, `apps/web`, `ai/`, skills
- PR #8-#9 web image, `migrate` service, closed staging; #10-#11 dump to R2
- PR #12 Claude Code hooks; #13 phase 0 report

## Next step

1. Phase 0.5: read `phase-005-money-skeleton.md`, build the thinnest end-to-end
   money path with real concurrency tests on Postgres. Not before.
2. After 03:00 Kyiv on 2026-11-23: a second file must exist under `staging/`
   in the R2 bucket (container `dump`, `rclone lsl`); this closes criterion 20.

## Open decisions for the owner

- Shop name (`LACE & SILK` is a placeholder), brand palette and fonts
- Nova Poshta API 2.0 access; Checkbox account
- COD: printing the paper receipt into the parcel; a return receipt may point
  only to a `sale` receipt, which a FK cannot express (see `NOTES.md`)
- Phase 0 scope not done: CI jobs `test:integration`, `migrate:upgrade`,
  `migrate:safety`, `size-limit`; Playwright, shadcn/ui, jsx-a11y (ESLint 10)
- Merged branches still on GitHub: `docs/accountant-answers`,
  `feat/db-migrations`, `feat/db-client-seed`, `feat/money-dto`

## Deviations from the plan

- TS 6.0.3; Postgres on Debian; Next 16.4.3 (critical RCE in <= 16.4.0)
- Tailwind v4: tokens in CSS `@theme`, not `tailwind.config.ts`
- staging basic auth lives in the app (`proxy.ts`), not in Caddy/Dokploy
- `worker` removed from compose until phase 0.5 brings `apps/worker`
- rclone 1.76.0: the Debian 1.60 build is incompatible with R2 (501)
- hooks are Node scripts, with no `allow` list in `settings.json`
- most existing docs and comments are still Ukrainian; they are rewritten in
  English when touched, and one dedicated translation pass is planned
