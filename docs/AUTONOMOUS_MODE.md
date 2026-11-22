# Autonomous mode

**Status: in force** since 2026-11-22, granted by the owner in chat. It stays in
force until the owner revokes it (in chat, or by removing the `allow` rule from
`.claude/settings.json`).

The owner leaves for hours at a time. Work continues without them, inside the
limits below. Everything that needs the owner goes into
`docs/plan/OWNER_QUEUE.md`; the owner answers it when they are back.

## What is delegated

1. **Review and merge.** Review every PR with `review-pr-silk` and merge it
   when the merge gate passes. Any session may merge its own PR; the
   orchestrating session merges what is left.
2. **Moving between phases.** When a phase's acceptance criteria are verified by
   execution: run `/phase-report`, merge the `CURRENT.md` update, and start the
   next phase in a **new session** without waiting for a go-ahead. This is the
   standing go-ahead; it suspends the wait described in `AGENTS.md` section 1
   for as long as this mode is in force.
3. **The owner queue.** Keep `docs/plan/OWNER_QUEUE.md` current.

## The merge gate (mechanical)

`gh pr merge` is allowed in `.claude/settings.json` only through the
`guard-merge` hook (`scripts/merge-gate.ts`, 33 tests). It refuses unless:

- the PR is open, targets `main`, is not a draft, has no conflicts;
- every CI check is green;
- the latest `review-pr-silk` comment is a **PASS for the PR's current head
  commit**, so any push after the review invalidates it;
- `--admin` is not used. If GitHub cannot be queried, the merge is refused.

The gate cannot judge whether a PR is wise. That is the skill's job, so a
merge never replaces the review. Only merge PRs that were reviewed with the
skill; leave anything else (for example a dependency bot's PR) in the queue.

## Hard stops: never, in any mode

- Anything on production: deploys, DDL, data, environment, secrets.
- Real payments, real waybills, real receipts.
- Spending money, creating accounts or subscriptions, entering credentials, or
  anything that needs the owner's secrets or identity.
- Deleting data that cannot be restored.
- Force-push, `--no-verify`, `--admin`, or weakening a gate, a lint rule, a hook
  or a test to get something through.
- Starting a phase whose prerequisites in the queue are unanswered BLOCKERs.

## Decisions: the owner queue

When a decision belongs to the owner (`AGENTS.md` section 5: a choice not covered
by the architecture that affects the schema, a heavy dependency, legal matters,
a plan that contradicts the architecture, an unmeetable criterion):

1. Add an entry to `docs/plan/OWNER_QUEUE.md` straight away: what, why it matters,
   options, your recommendation.
2. Classify it.
   - **BLOCKER**: the work cannot continue without the answer. Stop that line of
     work and move to something unblocked. If nothing is unblocked, stop and
     say so in the final message.
   - **DEFER**: continue with the recommended default. The default must be
     reversible, and the code or PR notes where it was applied.
3. Do not wait for the owner in chat. They will read the queue.

## When things go wrong

- A gate or CI fails, or a PR is still not PASS after 3 review rounds: queue it,
  stop that PR, do not retry blindly and do not work around the gate.
- After every merge, check that staging is healthy
  (`curl -s https://staging.damazla.com/api/health`, wait for the Dokploy deploy
  first). If it is not, stop merging, find the cause, and fix or revert through
  a normal PR.
- CI red on `main`: stop merging until it is green again.

## Starting the next phase

Preconditions: the phase report is delivered, `CURRENT.md` is updated and merged,
and no unanswered BLOCKER in the queue is tagged with the next phase. Start a
fresh session (`start_session`, its own worktree) with a brief that names
`AGENTS.md`, `CURRENT.md`, this file and the phase file, and states the rules:
English only, no AI attribution, every PR through `review-pr-silk`.
