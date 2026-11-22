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
`guard-merge` hook (`scripts/merge-gate.ts`, 116 tests). It refuses unless:

- the PR is open, targets `main`, is not a draft, and GitHub reports it as
  mergeable (no conflicts, not still computing);
- **every CI job defined in `ci.yml` at the PR head succeeded**: a job that
  never reported, was skipped, or is still running blocks the merge;
- the latest `review-pr-silk` report, written by the authenticated GitHub user,
  is a **PASS for the PR's current head commit**. The header must be the first
  line of the comment and name the commit with at least 12 hex characters, so
  a quote, a code block or someone else's comment cannot stand in for it, and
  any push after the review invalidates it;
- the command pins the commit with `--match-head-commit <full sha>`, so GitHub
  itself refuses the merge if the PR changed after the check.

Refused outright: `--admin`, `--auto` (it merges later without re-checking),
`gh api` merge endpoints and GraphQL merge mutations, a merge hidden in
`bash -c`, `eval`, `xargs` or a command substitution, more than one merge in one
command, and `git push` to `main` (explicit, `--all`, `--mirror`, or a bare push
while `main` is checked out). Wrappers such as `time`, `timeout`, `nohup`,
`sudo`, `env` and a full path to `gh` are looked through. The body of a quoted
heredoc (`<<'EOF'`) is data and is skipped, unless a shell receives it. Once a
command could merge or push, any problem (GitHub unreachable, an unexpected
answer, an internal error) refuses it.

What it is not: a sandbox. A script run by an interpreter (`python`, `node`) can
still call GitHub. The real backstop is branch protection on `main` (required
PR, required checks, no direct push), which the owner has to enable: see Q9 in
the owner queue. The gate also cannot judge whether a PR is wise; that is the
skill's job, so a merge never replaces the review. Only merge PRs that were
reviewed with the skill; leave anything else (for example a dependency bot's PR)
in the queue.

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
