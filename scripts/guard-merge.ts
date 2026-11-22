/**
 * Orchestration of the merge gate: classify the command, then (for a merge) ask
 * GitHub and git for the facts and evaluate the rules in `merge-gate.ts`.
 * Dependencies are injected so every path is testable without a network.
 *
 * Fail closed: the caller treats any thrown error as a refusal.
 */
import {
  classifyCommand,
  evaluateMerge,
  protectedPathsTouched,
  requiredCheckNames,
} from './merge-gate.ts';
import type { PrSnapshot } from './merge-gate.ts';

export interface GuardDeps {
  /** Runs `gh` with the given arguments and returns stdout. Throws on failure. */
  gh: (args: string[]) => string;
  /** Runs `git` in the directory the agent command runs in. Throws on failure. */
  git: (args: string[]) => string;
}

export interface GuardResult {
  /** A message to show the agent when the command is refused; null to allow. */
  refusal: string | null;
}

const PR_FIELDS =
  'number,state,baseRefName,isDraft,mergeable,headRefOid,statusCheckRollup,comments,files,changedFiles';

/** The files that implement the gate must be exactly what `origin/main` has. */
const GATE_FILES = [
  'scripts/merge-gate.ts',
  'scripts/guard-merge.ts',
  '.claude/hooks',
  '.claude/settings.json',
];

interface RawPr {
  number?: unknown;
  state?: unknown;
  baseRefName?: unknown;
  isDraft?: unknown;
  mergeable?: unknown;
  headRefOid?: unknown;
  statusCheckRollup?: unknown;
  comments?: unknown;
  files?: unknown;
  changedFiles?: unknown;
}

const isRawPr = (raw: unknown): raw is RawPr => typeof raw === 'object' && raw !== null;

/** Missing or malformed fields become safe defaults, so the gate refuses instead of crashing. */
function normalize(raw: unknown): PrSnapshot & { number: string } {
  if (!isRawPr(raw)) throw new Error('gh returned no PR data');
  const value = raw;
  const text = (field: unknown): string =>
    typeof field === 'string' || typeof field === 'number' ? String(field) : '';
  const list = (field: unknown): unknown[] => (Array.isArray(field) ? field : []);
  return {
    number: text(value.number),
    state: text(value.state),
    baseRefName: text(value.baseRefName),
    isDraft: value.isDraft === true,
    mergeable: text(value.mergeable),
    headRefOid: text(value.headRefOid),
    statusCheckRollup: list(value.statusCheckRollup) as PrSnapshot['statusCheckRollup'],
    comments: list(value.comments) as PrSnapshot['comments'],
    files: list(value.files) as PrSnapshot['files'],
    changedFiles:
      typeof value.changedFiles === 'number' ? value.changedFiles : Number.MAX_SAFE_INTEGER,
  };
}

function gateFilesDiffer(deps: GuardDeps): string | null {
  deps.git(['fetch', '-q', 'origin', 'main']);
  const changed = deps
    .git(['diff', '--name-only', 'origin/main', '--', ...GATE_FILES])
    .split('\n')
    .filter((line) => line !== '');
  return changed.length === 0 ? null : changed.join(', ');
}

export function guard(command: string, deps: GuardDeps): GuardResult {
  const items = classifyCommand(command);

  for (const item of items) {
    if (item.kind === 'refuse') return { refusal: `${item.reason}.` };
  }
  if (items.some((item) => item.kind === 'push-check')) {
    const branch = deps.git(['branch', '--show-current']).trim();
    if (branch === '' || branch === 'main') {
      return {
        refusal: 'direct push to main (or a detached HEAD); push a feature branch and open a PR.',
      };
    }
  }

  const merge = items.find((item) => item.kind === 'merge');
  if (merge === undefined) return { refusal: null };

  const differing = gateFilesDiffer(deps);
  if (differing !== null) {
    return {
      refusal:
        `the gate files in this checkout differ from origin/main (${differing}); ` +
        'merge from a checkout that matches main, so the gate cannot be weakened locally.',
    };
  }

  const repoArgs = merge.repo === null ? [] : ['--repo', merge.repo];
  const view = ['pr', 'view', ...(merge.ref === null ? [] : [merge.ref]), ...repoArgs];
  const snapshot = normalize(JSON.parse(deps.gh([...view, '--json', PR_FIELDS])) as unknown);

  const login = deps.gh(['api', 'user', '--jq', '.login']).trim();
  if (login === '') throw new Error('could not read the authenticated GitHub user');

  // Required checks come from main, not from the PR: a PR must not shrink its own checks.
  const repoPath = merge.repo ?? '{owner}/{repo}';
  const workflow = Buffer.from(
    deps
      .gh([
        'api',
        `repos/${repoPath}/contents/.github/workflows/ci.yml?ref=main`,
        '--jq',
        '.content',
      ])
      .replace(/\s/g, ''),
    'base64',
  ).toString('utf8');

  const result = evaluateMerge(snapshot, {
    requiredChecks: requiredCheckNames(workflow),
    trustedLogins: [login],
    matchHeadCommit: merge.matchHeadCommit,
  });
  if (!result.ok) {
    return {
      refusal:
        `PR #${snapshot.number} is not ready to merge.\n` +
        result.reasons.map((reason) => `  - ${reason}`).join('\n') +
        '\nRun /review-pr-silk, fix the findings, wait for CI, then try again.',
    };
  }
  // Defence in depth: the evaluator already refuses these, but a list here costs nothing.
  if (protectedPathsTouched(snapshot.files.map((file) => file.path)).length > 0) {
    return { refusal: 'the PR changes the guard rails; the owner merges those.' };
  }
  return { refusal: null };
}
