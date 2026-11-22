// PreToolUse(Bash): nothing reaches `main` except through the merge gate.
//
//  - `gh pr merge` is allowed in settings.json, but only through this gate
//    (scripts/merge-gate.ts): the PR is open, targets main, is not a draft,
//    mergeable, every CI job from ci.yml at the PR head succeeded, the latest
//    review-pr-silk report is a PASS by the authenticated user for the PR's
//    CURRENT head commit, and the command pins that commit with
//    --match-head-commit.
//  - Other routes are refused: `gh pr merge --admin/--auto`, `gh api` merge
//    endpoints and GraphQL merge mutations, merges hidden in `bash -c`, `eval`
//    or `xargs`, and `git push` to main (explicit, --all, or implicit while
//    main is the current branch).
//
// Fail closed: once a command could merge or push, any problem (GitHub
// unreachable, an unexpected answer, a thrown error, the gate module failing to
// load) refuses it. Commands that do not mention "merge" or "push" are never
// touched.
import { execFileSync } from 'node:child_process';

import { block, projectDir, readInput } from './lib.mjs';

const command = readInput().tool_input?.command;
if (typeof command !== 'string') process.exit(0);
if (!/\bmerge\b|\bpush\b|mergePullRequest/.test(command)) process.exit(0);

const refuse = (message) => block(`Blocked by guard-merge: ${message}`);

function failClosed(error) {
  const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
  refuse(
    `internal error (${detail}). Merging and pushing to main are refused when the gate cannot run.`,
  );
}
process.on('uncaughtException', failClosed);
process.on('unhandledRejection', failClosed);

const gh = (args) =>
  execFileSync('gh', args, {
    cwd: projectDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Missing or malformed fields become safe defaults, so the gate refuses instead of crashing. */
function normalize(raw) {
  if (typeof raw !== 'object' || raw === null) throw new Error('gh returned no PR data');
  return {
    number: raw.number ?? '?',
    state: String(raw.state ?? ''),
    baseRefName: String(raw.baseRefName ?? ''),
    isDraft: raw.isDraft === true,
    mergeable: String(raw.mergeable ?? ''),
    headRefOid: String(raw.headRefOid ?? ''),
    statusCheckRollup: Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : [],
    comments: Array.isArray(raw.comments) ? raw.comments : [],
  };
}

async function main() {
  const gate = await import('../../scripts/merge-gate.ts');
  const items = gate.classifyCommand(command);

  for (const item of items) {
    if (item.kind === 'refuse') refuse(`${item.reason}.`);
  }
  for (const item of items) {
    if (item.kind !== 'push-check') continue;
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: projectDir,
      encoding: 'utf8',
    }).trim();
    if (branch === 'main') refuse('direct push to main; push a feature branch and open a PR.');
  }

  const merge = items.find((item) => item.kind === 'merge');
  if (merge === undefined) return;

  const repoArgs = merge.repo === null ? [] : ['--repo', merge.repo];
  const view = ['pr', 'view', ...(merge.ref === null ? [] : [merge.ref]), ...repoArgs];
  const snapshot = normalize(
    JSON.parse(
      gh([
        ...view,
        '--json',
        'number,state,baseRefName,isDraft,mergeable,headRefOid,statusCheckRollup,comments',
      ]),
    ),
  );

  const login = gh(['api', 'user', '--jq', '.login']).trim();
  if (login === '') throw new Error('could not read the authenticated GitHub user');

  const repoPath = merge.repo ?? '{owner}/{repo}';
  const workflow = Buffer.from(
    gh([
      'api',
      `repos/${repoPath}/contents/.github/workflows/ci.yml?ref=${snapshot.headRefOid}`,
      '--jq',
      '.content',
    ]).replace(/\s/g, ''),
    'base64',
  ).toString('utf8');

  const result = gate.evaluateMerge(snapshot, {
    requiredChecks: gate.requiredCheckNames(workflow),
    trustedLogins: [login],
    matchHeadCommit: merge.matchHeadCommit,
  });
  if (!result.ok) {
    refuse(
      `PR #${snapshot.number} is not ready to merge.\n` +
        result.reasons.map((reason) => `  - ${reason}`).join('\n') +
        '\nRun /review-pr-silk, fix the findings, wait for CI, then try again.',
    );
  }
}

try {
  await main();
} catch (error) {
  failClosed(error);
}
