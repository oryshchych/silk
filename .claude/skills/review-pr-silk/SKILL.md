---
name: review-pr-silk
description: Review a Silk pull request against the project's best practices, fix every finding, and re-run until it passes. Mandatory for every session that creates or updates a PR. Run it right after opening the PR, and again after each round of fixes.
---

# review-pr-silk

The living memory of how we review. It runs mechanical gates, dispatches the
specialist reviewers, walks the checklist, and **loops until the verdict is
PASS**. A PR is not ready for the owner before that.

If this skill and `AGENTS.md` disagree, `AGENTS.md` wins: fix the skill. When a
new class of defect shows up in review or after merge, add one line to the
checklist, with the lesson.

You never merge, never force-push, never bypass hooks (`--no-verify`), and never
"fix" a finding by weakening a rule, a lint config or a test.

## 1. Scope the PR

```bash
git fetch -q origin
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
gh pr view --json number,title,body,baseRefName,headRefName,url   # if the PR exists
gh pr view --comments                                               # reviewer comments
gh pr checks                                                        # CI status
```

Read the whole diff, not only the stat. Existing reviewer comments and failing
CI checks are findings too.

## 2. Mechanical gates

Run every gate that matches what changed. Quote the failing output; do not
paraphrase it.

| Changed                                                | Gate                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| anything                                               | `pnpm verify` (format, lint, typecheck, unit), `pnpm knip`, `pnpm boundaries`, `pnpm ai:check`           |
| `package.json`, lockfile                               | `pnpm audit --audit-level high`                                                                          |
| `packages/db/src/schema.ts`, `packages/db/migrations/` | `pnpm db:check`, `pnpm migrate:fresh`                                                                    |
| anything touching Postgres (db, core, payments, seed)  | `pnpm test:int`                                                                                          |
| `apps/web`, `packages/shared`                          | `NEXT_TELEMETRY_DISABLED=1 pnpm --filter web build`                                                      |
| Dockerfiles, compose, `infra/`                         | build each touched image and validate the compose overlays (commands below)                              |
| tooling, lint config, CI, hooks, `ai/`                 | repeat `pnpm verify` **from a clean clone** (commands below): locally generated files mask missing steps |
| after every push                                       | `gh pr checks`: all CI jobs green before PASS                                                            |

Gate details:

```bash
# Images (build only what the diff touches)
docker build -f apps/web/Dockerfile -t store-web:review --build-arg NEXT_PUBLIC_SITE_URL=https://staging.example.com .
docker build -f packages/db/Dockerfile -t store-db-tools:review .
docker build -t store-dump:review infra/dump
# Compose overlays: the subshell supplies the variables the files require
# (APP_ENV is mandatory). Works in bash and zsh.
(
  export POSTGRES_DB=store POSTGRES_SUPERUSER=root POSTGRES_SUPERUSER_PASSWORD=x \
    POSTGRES_MIGRATE_USER=migrate POSTGRES_MIGRATE_PASSWORD=x \
    POSTGRES_APP_USER=app POSTGRES_APP_PASSWORD=x NEXT_PUBLIC_SITE_URL=https://example.com
  APP_ENV=staging docker compose -f docker-compose.yml -f docker-compose.staging.yml config --quiet 2>/dev/null
  APP_ENV=production docker compose -f docker-compose.yml -f docker-compose.production.yml config --quiet 2>/dev/null
)
# Known: the production check fails today on the missing `.env.backup` (tracked in
# NOTES.md, fixed before production launch). Report it as known, not as a new finding.

# Clean clone of the PR branch (never your working tree)
SCRATCH=$(mktemp -d)
git clone --branch "$(git branch --show-current)" "$(git rev-parse --show-toplevel)" "$SCRATCH/clean"
cd "$SCRATCH/clean" && cp .env.example .env
pnpm install --frozen-lockfile && pnpm verify
```

## 3. Specialist reviewers

Subagents are read-only and have their own context, so they do not agree with
what you just wrote. Their findings join the same list.

| Diff touches                                              | Dispatch                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| pricing, inventory, orders, payments, checkout, webhooks  | `money-reviewer` (and skills `/money-change`, `/new-webhook`) |
| a new or changed migration                                | `migration-reviewer` (and skill `/new-migration`)             |
| admin mutations, DTOs, exports, auth, role-dependent data | `security-auditor` (mandatory in phases 4, 5, 12)             |
| storefront pages, metadata, JSON-LD, robots, sitemap      | `seo-reviewer` (phases 1, 6)                                  |

If the built-in `/code-review` skill is available, run it too for plain
correctness bugs; otherwise read the diff looking for them.

## 4. Checklist

Tick each item against the diff, not from memory. Items that do not apply are
skipped, not ticked.

### A. PR hygiene

- [ ] Base is `main`. The PR is **not stacked** on another PR; the branch is not `main`.
- [ ] One concern, thin. Out-of-scope findings went to `NOTES.md`, not into the diff.
- [ ] Every commit is small and coherent, conventional, lowercase subject after the type, English, no AI attribution. Run `git show --stat <sha>` for **each** commit: the message must match the content (staged files can leak into the wrong commit).
- [ ] No force-push, no `--no-verify`, no `.env*` (except `.env.example`), no scratch or probe files, no build output.
- [ ] Title is conventional-commit style. The description is English and has: what and why, how it was verified (commands and results), what is not included or deviates from the plan, decisions needed from the owner. No AI attribution lines.

### B. Language

- [ ] All technical text is English: code, comments, docs, test names, logs and errors, commit and PR text. Cyrillic is allowed only in site content (`apps/web/messages/uk.json`; product, seed and legal text). Any hit outside `uk.json` is reviewed by hand. The command needs `grep -P` (GNU grep or ugrep):
      `git diff origin/main...HEAD -U0 -- . ':!apps/web/messages/uk.json' | grep -nP '^\+.*\p{Cyrillic}'`
- [ ] Ukrainian technical files that the diff touches are rewritten in English where touched. Untouched files are not mass-translated.

### C. Architecture and TypeScript

- [ ] Domain logic lives in `packages/core` and takes `tx` as the first parameter; `core` imports no `next/*`, reads no cookies. Server actions and route handlers stay thin.
- [ ] No `any`, no `as` cast to silence the compiler, no `@ts-ignore`; `@ts-expect-error` has a description of 20+ characters.
- [ ] No commented-out code, no `console.log`.
- [ ] `process.env` is read only through `@store/shared/env`.
- [ ] Next.js 16 specifics follow `AGENTS.md` section 4 (`proxy.ts`, `await params`, two-argument `revalidateTag`, `remotePatterns`). When unsure, read `node_modules/next/dist/docs/`, not memory.
- [ ] A new dependency heavier than a utility has the owner's approval; versions are pinned; no dependency cycles (`pnpm boundaries`).

### D. Money and stock (when touched)

- [ ] Amounts are `Money` (integer kopiykas) from `@store/shared/money`; arithmetic only through its functions; one rounding point with an explicit mode; discounts distributed by `allocate`.
- [ ] Stock changes only by an atomic conditional `UPDATE`, never read, check in JS, write. ADR-18 semantics: reserve until `shipped`; cancellation never changes `stock_quantity`.
- [ ] Financial status changes only from a verified server source (webhook, `getPaymentStatus`, confirmed receipt, `refund_operations`), never from a browser redirect.
- [ ] Event, financial state, stock, history and outbox change in **one** transaction. Lock order is the same on every path.
- [ ] Prices and availability come from the database; the client sends only `variantId`, `quantity` and the intent id.
- [ ] Gift-card seams hold (`docs/GIFT_CARDS.md` section 0): checkout rejects `gift_card` products and provider; nothing sells or redeems them.

### E. Database (when touched)

- [ ] Committed migrations are never edited. New ones come from `drizzle-kit generate` (or `--custom`); journal and snapshots are consistent (`pnpm db:check`).
- [ ] Extensions are created before objects that need them; generated columns use IMMUTABLE expressions and explicit `STORED`; a backfill touches a column in the trigger's column list.
- [ ] Financial foreign keys are `ON DELETE RESTRICT`. Invariants that can be expressed in the schema (CHECK, UNIQUE, FK) are in the schema, not only in code.
- [ ] New behavior in a migration has a test in `packages/db/test/migrate-fresh.int.test.ts` that proves it works, not just that it ran.
- [ ] Nothing runs DDL against production. Seeds stay deterministic and refuse production and non-empty databases.

### F. Web and UI (when touched)

- [ ] Every user-visible string goes through `next-intl`, with keys in **both** `uk.json` and `en.json`; no literal strings in JSX (lint enforces it).
- [ ] Colors use semantic tokens (`--surface`, `--text-primary`, ...); no hex in components; `grep -rE "blush|cream|pink" packages/ apps/web/src` is empty.
- [ ] Images have `alt`, `width`, `height`. Interactive elements are keyboard-reachable with a visible focus ring; icon-only buttons have an accessible name.
- [ ] The storefront is light-only: no server-side theme cookie on public pages (ADR-21). The locale comes from the URL only: no `Accept-Language` redirects.

### G. Security and environment

- [ ] Secrets are server-only (`NEXT_PUBLIC_*` is the only client-visible prefix); nothing sensitive in logs; gitleaks stays green.
- [ ] Admin mutations check the role **inside the action** and write `audit_log`.
- [ ] Data leaving the server goes through explicit DTOs (`serialize`, no `passthrough`/loose objects); the **serialized** response is tested per role, not what the UI shows.
- [ ] Webhooks fail closed: raw body, signature before parsing, invalid ones to `webhook_quarantine`.
- [ ] A new environment variable is added in all places: `.env.example`, `packages/shared/src/env.schema.ts`, the `web` allowlist in `docker-compose.yml`, and the docs when behavior differs per environment. One image serves staging and production (ADR-10): runtime values, except `NEXT_PUBLIC_*`.

### H. Tests

- [ ] Every new behavior has a test that **fails without the change**. For tricky logic, break the code on purpose and confirm the test fails (negative control).
- [ ] A bug in money or stock is reproduced by a failing test first.
- [ ] Money, stock and payment changes have a concurrency test with **separate connections** and barriers, on real Postgres; no mocked database; no fake timers for expiry (Postgres owns time).
- [ ] Tests live in the right project (`*.unit.test.ts`, `*.int.test.ts`); no `.only`, no `.skip`; they assert behavior, not implementation. `pricing` and `inventory` keep their coverage thresholds.

### I. Infrastructure and deploy

- [ ] Images build, run as a non-root user, have a working healthcheck, and carry no secrets (`.dockerignore` keeps `.env*` out).
- [ ] Compose overlays stay valid for staging and production.
- [ ] The PR says what changes on staging when it merges: Dokploy deploys `main` automatically.
- [ ] Scripts that talk to an external service were run against the real service or a faithful fake, and the PR says which.
- [ ] A new CI job really runs what it claims; no always-green stubs.

### J. Docs and state

- [ ] A behavior or architecture change updates the document that describes it (ADR, `ENVIRONMENTS.md`, `DEVELOPMENT.md`); the touched part is English.
- [ ] Generated files are not edited by hand (`AGENTS.md`, `CLAUDE.md`, the Copilot and Cursor mirrors): edit `ai/*`, run `pnpm ai:sync`.
- [ ] `docs/plan/CURRENT.md` changes only at the end of a session or phase, stays at 60 lines or fewer, and is English. Mid-phase slice PRs do not touch it.
- [ ] The PR stays inside the current phase and does not start the next one.

### Traps that already bit us

- Locally generated files hid a missing CI step (Next route types before type-aware lint). Check from a clean clone.
- Files staged earlier ended up in a later commit with the wrong message. `git show --stat` every commit.
- A test harness bug looked like a product failure (and the reverse can look like success). Make the test fail on purpose.
- A string-matching guard blocked its own documentation. Match the command, not the text.
- A provider-specific behavior (R2 and an old rclone) only showed up against the real service.
- Stacked PRs merged into the wrong base. Every PR targets `main`.

## 5. Report

```
review-pr-silk: iteration N, <branch> @ <short sha>
Gates: verify ok | knip ok | boundaries ok | ai:check ok | <others> | CI ok
Findings:
  [BLOCKER]    path:line  what is wrong -> why it matters -> concrete fix
  [SHOULD-FIX] path:line  ...
  [NIT]        path:line  ...
Verdict: PASS | FAIL (b blockers, s should-fix)
```

- **BLOCKER**: breaks a hard rule (`AGENTS.md` section 2), security, data loss risk, a failing gate or CI check, a missing required test, a wrong base or a stacked PR.
- **SHOULD-FIX**: violates the definition of done or a convention, or an unclear PR description.
- **NIT**: style or taste. Listed, optional.
- **PASS** needs zero blockers, zero should-fix, every gate and CI check green.
- A finding you believe is wrong is not silently ignored: say why in the report.
- A finding that needs an owner decision (`AGENTS.md` section 5): stop and ask.

## 6. Fix loop

1. Fix every BLOCKER and SHOULD-FIX (and NITs that are cheap), as new small commits (`fix(...)`, English). Do not amend or force-push pushed commits.
2. Push, wait for CI, and **re-run this skill from section 1**, the whole of it, not only the changed lines.
3. Repeat until PASS. After 3 iterations without PASS, stop and report the remaining findings to the owner.

## 7. Record the result

Post the full report as a PR comment in English (`gh pr comment <number> --body-file <file>`): verdict, iteration count, commit sha, gates, how each earlier comment was handled, and open NITs. Put one line in the `Review` section of the PR description (`gh pr edit <number> --body-file <file>`): the verdict, the iteration count and a link to that comment. If posting is denied, give the same text to the owner in chat. Then tell the owner the PR is ready to merge.
