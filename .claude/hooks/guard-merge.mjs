// PreToolUse(Bash): `gh pr merge` is allowed in settings.json, but only through
// this gate. The conditions (scripts/merge-gate.ts): the PR is open, targets
// main, is not a draft, has no conflicts, every CI check is green, and the
// latest review-pr-silk comment is a PASS for the PR's CURRENT head commit.
// A push after the review therefore invalidates it.
//
// Fail closed: if GitHub cannot be queried, the merge is blocked.
import { execFileSync } from 'node:child_process';

import { evaluateMerge, parseMergeCommand } from '../../scripts/merge-gate.ts';
import { block, projectDir, readInput } from './lib.mjs';

const command = readInput().tool_input?.command;
if (typeof command !== 'string') process.exit(0);

const merge = parseMergeCommand(command);
if (merge === null) process.exit(0);

if (merge.admin) {
  block(
    'Blocked by guard-merge: --admin bypasses branch rules and the review gate. ' +
      'Merge without it once review-pr-silk has PASSed and CI is green.',
  );
}

const fields = 'state,baseRefName,isDraft,mergeable,headRefOid,statusCheckRollup,comments,number';
const args = ['pr', 'view'];
if (merge.ref !== null) args.push(merge.ref);
if (merge.repo !== null) args.push('--repo', merge.repo);
args.push('--json', fields);

let snapshot;
try {
  snapshot = JSON.parse(
    execFileSync('gh', args, {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
} catch (error) {
  const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
  block(
    `Blocked by guard-merge: could not read the PR from GitHub (${detail}). ` +
      'Merging is refused when the gate cannot be checked.',
  );
}

const result = evaluateMerge(snapshot);
if (!result.ok) {
  block(
    `Blocked by guard-merge: PR #${snapshot.number} is not ready to merge.\n` +
      result.reasons.map((reason) => `  - ${reason}`).join('\n') +
      '\nRun /review-pr-silk, fix the findings, wait for CI, then try again.',
  );
}
