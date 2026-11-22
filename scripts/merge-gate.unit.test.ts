import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateMerge, latestReview, parseMergeCommand, type PrSnapshot } from './merge-gate';

const HEAD = '8056468c0ffee0123456789abcdef0123456789a';

const green = [
  { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { name: 'knip', status: 'COMPLETED', conclusion: 'SKIPPED' },
];

const passComment = (sha: string): { body: string } => ({
  body: `## review-pr-silk: PASS (iteration 2 of 3), \`feat/x\` @ \`${sha}\`\n\nGates ok.`,
});

function pr(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    state: 'OPEN',
    baseRefName: 'main',
    isDraft: false,
    mergeable: 'MERGEABLE',
    headRefOid: HEAD,
    statusCheckRollup: green,
    comments: [passComment('8056468')],
    ...overrides,
  };
}

describe('evaluateMerge', () => {
  it('allows a ready PR', () => {
    expect(evaluateMerge(pr())).toEqual({ ok: true, reasons: [] });
  });

  it.each([
    ['closed PR', { state: 'MERGED' }, /not open/],
    ['stacked PR', { baseRefName: 'feat/other' }, /target main/],
    ['draft', { isDraft: true }, /draft/],
    ['merge conflicts', { mergeable: 'CONFLICTING' }, /conflicts/],
    ['no CI reported', { statusCheckRollup: [] }, /no CI checks/],
  ])('blocks: %s', (_, overrides, reason) => {
    const result = evaluateMerge(pr(overrides));
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(reason);
  });

  it('blocks a failing, a pending and an in-progress check, and names them', () => {
    const result = evaluateMerge(
      pr({
        statusCheckRollup: [
          { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'build', status: 'IN_PROGRESS' },
          { context: 'external', state: 'PENDING' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toMatch(/lint: failure/);
    expect(result.reasons[0]).toMatch(/build: in_progress/);
    expect(result.reasons[0]).toMatch(/external: pending/);
  });

  it('blocks without a review-pr-silk report', () => {
    const result = evaluateMerge(pr({ comments: [{ body: 'looks good to me' }] }));
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/run the skill first/);
  });

  it('blocks when the latest verdict is FAIL', () => {
    const result = evaluateMerge(
      pr({
        comments: [
          passComment('8056468'),
          { body: '## review-pr-silk: FAIL (iteration 3 of 3), `feat/x` @ `8056468`' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/FAIL/);
  });

  it('blocks when commits were pushed after the PASS', () => {
    const result = evaluateMerge(pr({ headRefOid: 'aaaaaaa0123456789abcdef0123456789abcdef0' }));
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/for 8056468, but the PR head is aaaaaaa/);
  });

  it('blocks a PASS with no commit in the header', () => {
    const result = evaluateMerge(
      pr({ comments: [{ body: '## review-pr-silk: PASS (iteration 1)' }] }),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/no commit/);
  });

  it('accepts a PASS after an earlier FAIL (latest wins)', () => {
    const result = evaluateMerge(
      pr({
        comments: [
          { body: '## review-pr-silk: FAIL (iteration 1 of 3), `feat/x` @ `1111111`' },
          passComment('8056468'),
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('reports every problem at once', () => {
    const result = evaluateMerge(pr({ isDraft: true, statusCheckRollup: [], comments: [] }));
    expect(result.reasons).toHaveLength(3);
  });
});

describe('latestReview', () => {
  it('ignores unrelated comments and a header that is not at line start', () => {
    expect(latestReview([{ body: 'see "## review-pr-silk: PASS" above' }])).toBeNull();
  });
});

describe('parseMergeCommand', () => {
  it.each([
    ['gh pr merge 17 --merge', { ref: '17', admin: false, repo: null }],
    ['gh pr merge --merge', { ref: null, admin: false, repo: null }],
    ['gh pr merge 5 --admin', { ref: '5', admin: true, repo: null }],
    [
      'gh pr merge 5 --repo oryshchych/silk --merge',
      { ref: '5', admin: false, repo: 'oryshchych/silk' },
    ],
    ['gh pr merge --repo=oryshchych/silk 9', { ref: '9', admin: false, repo: 'oryshchych/silk' }],
    ['gh pr merge --subject "feat: x" --body "y" 12', { ref: '12', admin: false, repo: null }],
    ['cd x && gh pr merge 3 --merge', { ref: '3', admin: false, repo: null }],
    ['git commit -m "x" && gh pr merge 3', { ref: '3', admin: false, repo: null }],
    [
      'gh pr merge --subject "a && b; c" --body \'d | e\' 12',
      { ref: '12', admin: false, repo: null },
    ],
    ['gh pr merge 8 --match-head-commit abc1234 --merge', { ref: '8', admin: false, repo: null }],
  ])('%s', (command, expected) => {
    expect(parseMergeCommand(command)).toEqual(expected);
  });

  it.each([
    'gh pr view 17',
    'gh pr create --title "gh pr merge is blocked"',
    'echo gh pr merge 5',
    'echo "done; gh pr merge 5 && gh pr merge 6"',
    'git commit -m "docs: how gh pr merge works"',
    'pnpm verify',
  ])('is not a merge: %s', (command) => {
    expect(parseMergeCommand(command)).toBeNull();
  });
});

describe('guard-merge hook (paths that need no network)', () => {
  const root = resolve(import.meta.dirname, '..');
  const run = (command: string): number | null =>
    spawnSync('node', [join(root, '.claude/hooks/guard-merge.mjs')], {
      cwd: root,
      input: JSON.stringify({ tool_input: { command } }),
      encoding: 'utf8',
    }).status;

  it('blocks --admin without asking GitHub', () => {
    expect(run('gh pr merge 5 --admin --merge')).toBe(2);
  });

  it('ignores commands that are not a merge', () => {
    expect(run('gh pr view 5')).toBe(0);
    expect(run('echo gh pr merge 5')).toBe(0);
    expect(run('git status')).toBe(0);
  });

  it('does not block on garbage input', () => {
    const result = spawnSync('node', [join(root, '.claude/hooks/guard-merge.mjs')], {
      cwd: root,
      input: 'not json',
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  });
});
