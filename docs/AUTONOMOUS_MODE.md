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
`guard-merge` hook (`scripts/merge-gate.ts` holds the rules,
`scripts/guard-merge.ts` the orchestration, both unit-tested). It refuses unless:

- the PR is open, targets `main`, is not a draft, and GitHub reports it as
  mergeable (no conflicts, not still computing);
- **every CI job defined in `ci.yml` on `main`** has a check run, and every run
  of that name succeeded. The list comes from `main`, so a PR cannot shrink its
  own checks; a job that never reported, was skipped, or is still running blocks
  the merge. Matrix jobs and `${{ }}` names are not understood and also block
  (the safe direction);
- the latest `review-pr-silk` report, written by the authenticated GitHub user,
  is a **PASS for the PR's current head commit**. The header must be the first
  line of the comment and name the commit with at least 12 hex characters, and
  any push after the review invalidates it;
- the command pins the commit with `--match-head-commit <full sha>`, so GitHub
  itself refuses the merge if the PR changed after the check;
- the PR **does not change the guard rails**: `.claude/settings.json`,
  `.claude/hooks/**`, the `review-pr-silk` skill, the gate scripts, workflows and
  this file. The owner merges those, so a session cannot weaken the gate and use
  it to merge itself. The gate files in the checkout must also equal
  `origin/main`.

Refused outright: `--admin`, `--auto`, `gh api` merge endpoints and GraphQL merge
mutations, unknown `gh` subcommands (an alias can hide a merge), `gh alias` and
`gh extension`, git aliases, a merge hidden in `bash -c`, `eval`, `xargs` or a
command substitution, any `$`-built or glob argument of a merge or push, more
than one merge in one command, and any push to `main` (explicit, `--all`,
`--mirror`, glob refspecs, `-C`/`--git-dir`, or a bare push while `main` is
checked out, judged in the directory the command runs in). `gh` and `git` are
found at any position of a command, so wrappers need no list. Heredoc bodies are
read as commands too (no skipping), so prose that quotes these commands is
written with the Write/Edit tools, not a Bash heredoc. Once a command could merge
or push, any problem (GitHub unreachable, an unexpected answer, an internal
error) refuses it.

Limits, stated honestly:

- It is not a sandbox. A script run by an interpreter (`python`, `node`) can
  still call GitHub, and a hook cannot see inside it.
- The agent and the owner are the same GitHub user, so the `review-pr-silk`
  comment proves a report was posted, not that the review was honest. CI and the
  pinned commit are what the gate truly enforces; the review itself is the
  skill's job.
- The real backstop is branch protection on `main` (required PR, required
  checks, no direct push), which only the owner can enable: Q9 in the owner
  queue. Until then this gate is a strong guard rail, not a wall.
- Auto permission mode runs a classifier before the allow rule; a merge it
  blocks stays in the queue for the owner.

Only merge PRs that were reviewed with the skill; leave anything else (for
example a dependency bot's PR) in the queue.

## Review tiers (speed and cost)

Approved by the owner on 2026-11-23, tightened the same day after phase 2 took
3 to 4 hours. The review effort follows the risk of the change; the gate (CI, PASS
for the current head, pinned commit) applies to every tier.

| Tier | Change | Review |
|---|---|---|
| T0 | docs, CI-only, config text | CI green and the orchestrator reads the diff. No worktree run, no specialist |
| T1 | small code change that touches no cache, rate limit, proxy, DTO, auth, money, schema or webhook | CI green; the orchestrator runs `pnpm verify` (and `test:int` until CI has the integration job, owner queue Q6) in a worktree. No specialist unless the diff is not trivial, then one |
| T2 | money, stock, payments, DTOs, caching keys, rate limits, `proxy.ts`, schema, webhooks, auth | **one** specialist chosen by the dominant risk (`money-reviewer`, `security-auditor`, `migration-reviewer`, `seo-reviewer`), 3 to 5 mutations of the critical protections, the orchestrator's own run |

Two specialists on one PR only when it carries two independent high-risk
surfaces (for example a migration plus a money path, or a webhook plus a
public route). Never three.

Who reviews what:

- **The orchestrator owns T2 specialists.** An authoring session does not run
  its own `money-reviewer`, `security-auditor` or `migration-reviewer` on a
  PR: it would duplicate the orchestrator's review. It runs the gates
  (`verify`, `test:int`, build, smoke, `review-pr-silk` checklist) and may break
  its own critical code on purpose to prove its tests fail.
- **Reviewers get a scope, not the whole repository.** Name the files, the
  attack surface and the mutations; tell them not to repeat what CI or the
  author's gates already show.
- **Cheaper models for read-heavy reviewers** where the review is mostly reading
  and measuring; keep the strongest model for design-heavy work.

Rounds and re-review:

- **One consolidated findings comment, one fix round.** Collect all findings of
  all reviewers into a single PR comment first (cross-session messages can sit in
  a queue for a long time, a comment cannot be lost), and the author fixes them
  together.
- **Re-review is scoped.** After the fixes the orchestrator re-checks only the
  changed files and the new attack surface the fixes created (its own run plus
  two mutations of its choosing). No specialist re-run for mechanical fixes whose
  tests pass in the orchestrator's run, and no repeating mutations the author
  already showed failing.
- **At most two rounds.** After the second round the PR is merged, queued for
  the owner, or stopped.
- **Accepted risk.** A PASS may carry should-fix items when all three hold: there
  is no blocker, the item is not reachable in production yet or is covered by an
  owner queue entry, and the PASS comment names it, its owner and where it will
  be fixed. Anything reachable in production, any money or data loss path, and
  any blocker is fixed before the merge.

Cost of the work itself:

- **Bigger slices.** Prefer one coherent PR per slice over many tiny ones; each PR
  costs a full review round. Split only when a PR passes about 40 files or mixes
  independent risks.
- **Prepare the next slice while the previous one is in review.** PRs are never
  stacked (every PR targets `main`; the merge gate refuses anything else). The
  author builds the next slice locally off the previous head, then rebases it on
  `main` and opens it as soon as the previous PR is merged.
- **Do not duplicate CI.** If CI already ran a check on the head commit, the
  orchestrator does not repeat it unless CI does not cover it. CI has no
  integration job until the owner merges it (Q6), so `test:int` is still run by
  hand for T1 and T2 until then.
- **Run in parallel.** The orchestrator's own checks run while CI is still
  running; specialists on one PR run in parallel, not one after another.
- **Measure the right thing.** For cache growth count every store (`.next/server`,
  `.next/cache`), not one directory.
- **Time-box a phase.** Budget a phase in review rounds, not hours: slices times
  at most two rounds. When a phase passes its budget the orchestrator says so in
  the owner queue instead of adding rounds.

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
