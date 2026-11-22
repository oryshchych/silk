import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  classifyCommand,
  evaluateMerge,
  latestReview,
  requiredCheckNames,
  splitCommands,
  type CheckEntry,
  type Classified,
  type GateContext,
  type PrSnapshot,
} from './merge-gate';

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const SHORT = HEAD.slice(0, 12);
const OWNER = 'owner-login';

const ok = (name: string): CheckEntry => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' });
const required = ['lint', 'build'];
const green = required.map(ok);

const report = (verdict: string, sha: string, login = OWNER): PrSnapshot['comments'][number] => ({
  body: `## review-pr-silk: ${verdict} (iteration 2 of 3), \`feat/x\` @ \`${sha}\`\n\nGates ok.`,
  author: { login },
});

function pr(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    state: 'OPEN',
    baseRefName: 'main',
    isDraft: false,
    mergeable: 'MERGEABLE',
    headRefOid: HEAD,
    statusCheckRollup: green,
    comments: [report('PASS', SHORT)],
    ...overrides,
  };
}

const context = (overrides: Partial<GateContext> = {}): GateContext => ({
  requiredChecks: required,
  trustedLogins: [OWNER],
  matchHeadCommit: HEAD,
  ...overrides,
});

const reasons = (snapshot: PrSnapshot, ctx: GateContext = context()): string =>
  evaluateMerge(snapshot, ctx).reasons.join(' | ');

describe('requiredCheckNames', () => {
  it('reads job ids and honours a job name', () => {
    const workflow = [
      'name: CI',
      'on:',
      '  push:',
      'jobs:',
      '  # comment between jobs',
      '  lint:',
      '    runs-on: ubuntu-latest',
      '  build:',
      '    name: Build the app',
      '    runs-on: ubuntu-latest',
      '',
      '  test-unit:',
      '    runs-on: ubuntu-latest',
      'other:',
      '  not-a-job:',
    ].join('\n');
    expect(requiredCheckNames(workflow)).toEqual(['lint', 'Build the app', 'test-unit']);
  });

  it('returns nothing for a file without jobs', () => {
    expect(requiredCheckNames('name: CI\n')).toEqual([]);
  });
});

describe('latestReview', () => {
  it('needs a trusted author', () => {
    expect(latestReview([report('PASS', SHORT, 'stranger')], [OWNER])).toBeNull();
  });

  it('needs the header on the first line, not quoted or fenced', () => {
    const header = `## review-pr-silk: PASS @ \`${SHORT}\``;
    const forged = [
      { body: `see:\n${header}`, author: { login: OWNER } },
      { body: `> ${header}`, author: { login: OWNER } },
      { body: `\`\`\`\n${header}\n\`\`\``, author: { login: OWNER } },
    ];
    expect(latestReview(forged, [OWNER])).toBeNull();
  });

  it('ignores a sha shorter than 12 characters', () => {
    expect(latestReview([report('PASS', 'abcdef0')], [OWNER])).toEqual({
      verdict: 'PASS',
      sha: '',
    });
  });

  it('takes the latest trusted verdict', () => {
    const comments = [report('FAIL', SHORT), report('PASS', SHORT)];
    expect(latestReview(comments, [OWNER])?.verdict).toBe('PASS');
  });
});

describe('evaluateMerge', () => {
  it('allows a ready PR', () => {
    expect(evaluateMerge(pr(), context())).toEqual({ ok: true, reasons: [] });
  });

  it.each([
    ['closed PR', { state: 'MERGED' }, /not open/],
    ['stacked PR', { baseRefName: 'feat/other' }, /target main/],
    ['draft', { isDraft: true }, /draft/],
    ['merge conflicts', { mergeable: 'CONFLICTING' }, /conflicts/],
    ['mergeable unknown', { mergeable: 'UNKNOWN' }, /still computing/],
  ])('blocks: %s', (_, overrides, reason) => {
    expect(reasons(pr(overrides))).toMatch(reason);
  });

  it('blocks a required check that never reported', () => {
    expect(reasons(pr({ statusCheckRollup: [ok('lint')] }))).toMatch(/build: has not reported/);
  });

  it('blocks when no check reported at all', () => {
    expect(reasons(pr({ statusCheckRollup: [] }))).toMatch(
      /lint: has not reported, build: has not reported/,
    );
  });

  it('does not accept SKIPPED or NEUTRAL for a required check', () => {
    const skipped: CheckEntry = { name: 'build', status: 'COMPLETED', conclusion: 'SKIPPED' };
    expect(reasons(pr({ statusCheckRollup: [ok('lint'), skipped] }))).toMatch(/build: skipped/);
  });

  it('names failing, pending and in-progress checks', () => {
    const rollup: CheckEntry[] = [
      { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'build', status: 'IN_PROGRESS' },
      { context: 'external', state: 'PENDING' },
    ];
    const text = reasons(pr({ statusCheckRollup: rollup }));
    expect(text).toMatch(/lint: failure/);
    expect(text).toMatch(/build: in_progress/);
    expect(text).toMatch(/external: pending/);
  });

  it('uses the latest attempt of a re-run check', () => {
    const rollup: CheckEntry[] = [
      { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
      ok('lint'),
      ok('build'),
    ];
    expect(evaluateMerge(pr({ statusCheckRollup: rollup }), context()).ok).toBe(true);
  });

  it('blocks an extra failing check but tolerates a skipped extra one', () => {
    const extra: CheckEntry = { name: 'optional', status: 'COMPLETED', conclusion: 'SKIPPED' };
    expect(evaluateMerge(pr({ statusCheckRollup: [...green, extra] }), context()).ok).toBe(true);
    const failing: CheckEntry = { name: 'optional', status: 'COMPLETED', conclusion: 'FAILURE' };
    expect(reasons(pr({ statusCheckRollup: [...green, failing] }))).toMatch(/optional: failure/);
  });

  it('refuses when the required checks are unknown', () => {
    expect(reasons(pr(), context({ requiredChecks: [] }))).toMatch(/could not determine/);
  });

  it('blocks without a report, with a forged one, and with a FAIL', () => {
    expect(reasons(pr({ comments: [] }))).toMatch(/run the skill first/);
    expect(reasons(pr({ comments: [report('PASS', SHORT, 'stranger')] }))).toMatch(
      /run the skill first/,
    );
    expect(reasons(pr({ comments: [report('FAIL', SHORT)] }))).toMatch(/verdict is FAIL/);
  });

  it('a forged PASS cannot override a real FAIL', () => {
    const comments = [report('FAIL', SHORT), report('PASS', SHORT, 'stranger')];
    expect(reasons(pr({ comments }))).toMatch(/verdict is FAIL/);
  });

  it('blocks when a commit was pushed after the PASS', () => {
    const moved = 'f'.repeat(40);
    const text = reasons(pr({ headRefOid: moved }), context({ matchHeadCommit: moved }));
    expect(text).toMatch(new RegExp(`for ${SHORT}, but the PR head is ${'f'.repeat(12)}`));
  });

  it('blocks a report with a short sha', () => {
    expect(reasons(pr({ comments: [report('PASS', 'abcdef0')] }))).toMatch(/12 or more hex/);
  });

  it('requires --match-head-commit and that it equals the head', () => {
    expect(reasons(pr(), context({ matchHeadCommit: null }))).toMatch(/pass --match-head-commit/);
    expect(reasons(pr(), context({ matchHeadCommit: 'a'.repeat(40) }))).toMatch(/does not match/);
  });

  it('reports every problem at once', () => {
    const text = evaluateMerge(
      pr({ isDraft: true, comments: [] }),
      context({ matchHeadCommit: null }),
    );
    expect(text.reasons).toHaveLength(3);
  });
});

describe('splitCommands', () => {
  it('keeps quoted operators inside a word', () => {
    expect(splitCommands('git commit -m "a && b; c" && echo done')).toEqual([
      ['git', 'commit', '-m', 'a && b; c'],
      ['echo', 'done'],
    ]);
  });
});

describe('classifyCommand: merges', () => {
  const merge = (
    ref: string | null,
    extra: Partial<Extract<Classified, { kind: 'merge' }>> = {},
  ): Classified[] => [{ kind: 'merge', ref, repo: null, matchHeadCommit: null, ...extra }];

  it.each([
    ['gh pr merge 17 --merge', merge('17')],
    ['gh pr merge --merge', merge(null)],
    [`gh pr merge 8 --match-head-commit ${HEAD} --merge`, merge('8', { matchHeadCommit: HEAD })],
    [`gh pr merge 8 --match-head-commit=${HEAD}`, merge('8', { matchHeadCommit: HEAD })],
    ['gh pr merge 5 --repo oryshchych/silk --merge', merge('5', { repo: 'oryshchych/silk' })],
    ['gh --repo oryshchych/silk pr merge 5', merge('5', { repo: 'oryshchych/silk' })],
    ['gh pr merge --subject "feat: x" --body "y" 12', merge('12')],
    ['gh pr merge --subject "a && b; c" --body \'d | e\' 12', merge('12')],
    ['cd x && gh pr merge 3 --merge', merge('3')],
    ['git commit -m "x" && gh pr merge 3', merge('3')],
    // Wrappers that Claude Code strips before matching permission rules.
    ['time gh pr merge 5', merge('5')],
    ['timeout 30 gh pr merge 5', merge('5')],
    ['nohup gh pr merge 5', merge('5')],
    ['nice -n 5 gh pr merge 5', merge('5')],
    ['env FOO=1 gh pr merge 5', merge('5')],
    ['FOO=1 gh pr merge 5', merge('5')],
    ['sudo gh pr merge 5', merge('5')],
    ['command gh pr merge 5', merge('5')],
    ['/opt/homebrew/bin/gh pr merge 5', merge('5')],
    ['(gh pr merge 5)', merge('5')],
    ['{ gh pr merge 5; }', merge('5')],
  ])('%s', (command, expected) => {
    expect(classifyCommand(command)).toEqual(expected);
  });
});

describe('classifyCommand: refusals', () => {
  it.each([
    'gh pr merge 5 --admin',
    'time gh pr merge 5 --admin --merge',
    'gh pr merge 5 --auto --merge',
    'gh pr merge 5 --merge; gh pr merge 6 --merge',
    'gh api -X PUT repos/oryshchych/silk/pulls/5/merge',
    'gh api repos/oryshchych/silk/pulls/5/merge -f merge_method=merge',
    'gh api graphql -f query="mutation { mergePullRequest(input: {pullRequestId: \\"x\\"}) { clientMutationId } }"',
    'gh api graphql -f query="mutation { enablePullRequestAutoMerge(input: {pullRequestId: \\"x\\"}) { clientMutationId } }"',
    'bash -c "gh pr merge 5 --merge"',
    "sh -c 'gh pr merge 5'",
    'eval "gh pr merge 5"',
    'echo 5 | xargs gh pr merge',
    'echo $(gh pr merge 5)',
    'echo `gh pr merge 5`',
    'bash -c "git push origin main"',
    'git push origin main',
    'git push origin HEAD:main',
    'git push origin +main',
    'git push origin :main',
    'git push origin feat/x:main',
    'git push origin HEAD:refs/heads/main',
    'git push --all',
    'git push --mirror origin',
    'git -C packages/db push origin main',
    // Heredocs the shell expands or runs.
    'cat <<EOF\n`gh pr merge 5`\nEOF',
    "bash <<'EOF'\ngh pr merge 5 --admin\nEOF",
    "sh <<'EOF'\ngit push origin main\nEOF",
    "cat <<'EOF'\nharmless\nEOF\ngit push origin main",
  ])('%s', (command) => {
    const result = classifyCommand(command);
    expect(result.some((item) => item.kind === 'refuse')).toBe(true);
  });
});

describe('classifyCommand: push-check and harmless commands', () => {
  it.each(['git push', 'git push origin', 'git push -u origin HEAD', 'git push origin HEAD'])(
    'needs the current branch: %s',
    (command) => {
      expect(classifyCommand(command)).toEqual([{ kind: 'push-check' }]);
    },
  );

  it.each([
    'git push origin feat/x',
    'git push -u origin chore/x',
    'git push origin HEAD:refs/heads/feat/y',
    'git push origin --delete feat/old',
    'gh pr view 5',
    'gh pr create --title "gh pr merge is gated"',
    'gh pr comment 5 --body "do not gh pr merge --admin"',
    'gh api repos/oryshchych/silk/pulls/5',
    'gh api repos/oryshchych/silk/pulls/5/comments',
    'gh api graphql -f query="query { viewer { login } }"',
    'echo "gh pr merge 5"',
    'echo "done; gh pr merge 5 && gh pr merge 6"',
    'git commit -m "docs: how gh pr merge works"',
    'git status',
    'pnpm verify',
    // Documentation in a quoted heredoc is data, not commands.
    "python3 - <<'PY'\nprint('`gh pr merge 5 --admin`, git push origin main, $(gh pr merge 5)')\nPY",
    "cat > notes.md <<'EOF'\ngit push origin main\ngh pr merge 5 --auto\nEOF",
    'cat > notes.md <<"EOF"\nbash -c "gh pr merge 5"\nEOF',
    "cat <<-'EOF'\n\tgit push --all\n\tEOF",
  ])('is not touched: %s', (command) => {
    expect(classifyCommand(command)).toEqual([]);
  });
});

describe('guard-merge hook (a real process, with a fake gh)', () => {
  const root = resolve(import.meta.dirname, '..');
  const hook = join(root, '.claude/hooks/guard-merge.mjs');
  const workflow = 'name: CI\njobs:\n  lint:\n    runs-on: x\n  build:\n    runs-on: x\n';

  /** A directory with a `gh` shell script that answers like GitHub would. */
  function fakeGh(view: string, userCode = 0): string {
    const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
    const content = Buffer.from(workflow).toString('base64');
    const script = [
      '#!/bin/sh',
      'case "$*" in',
      `  "api user --jq .login") if [ ${String(userCode)} -ne 0 ]; then exit ${String(userCode)}; fi; echo ${OWNER} ;;`,
      `  api\\ repos/*) printf '%s' '${content}' ;;`,
      `  pr\\ view*) printf '%s' '${view}' ;;`,
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'gh'), script);
    chmodSync(join(dir, 'gh'), 0o755);
    return dir;
  }

  /**
   * Runs the hook with a hermetic environment: a throwaway HOME, and a PATH that
   * holds only the fake gh (when given) and, if asked, the system tools. No real
   * gh is ever reachable, so nothing here touches the network or the repo.
   */
  function run(
    command: string,
    options: { ghDir?: string; cwd?: string; system?: boolean } = {},
  ): number | null {
    const cwd = options.cwd ?? root;
    const parts = [options.ghDir, options.system === false ? undefined : '/usr/bin:/bin'];
    const empty = mkdtempSync(join(tmpdir(), 'empty-path-'));
    return spawnSync(process.execPath, [hook], {
      cwd,
      input: JSON.stringify({ tool_input: { command } }),
      encoding: 'utf8',
      env: {
        PATH: parts.filter((part) => part !== undefined).join(':') || empty,
        CLAUDE_PROJECT_DIR: cwd,
        HOME: mkdtempSync(join(tmpdir(), 'home-')),
      },
    }).status;
  }

  const view = (overrides: Partial<PrSnapshot> = {}): string =>
    JSON.stringify({ number: 7, ...pr(overrides) }).replaceAll("'", '');
  const merge = `gh pr merge 7 --merge --match-head-commit ${HEAD}`;

  it('lets a ready PR through', () => {
    expect(run(merge, { ghDir: fakeGh(view()) })).toBe(0);
  });

  it('blocks a PR that is not ready, with a clear reason', () => {
    expect(run(merge, { ghDir: fakeGh(view({ isDraft: true })) })).toBe(2);
  });

  it('does not crash open when GitHub returns nulls', () => {
    expect(run(merge, { ghDir: fakeGh(view({ statusCheckRollup: null as never })) })).toBe(2);
    expect(run(merge, { ghDir: fakeGh('null') })).toBe(2);
    expect(run(merge, { ghDir: fakeGh('not json') })).toBe(2);
  });

  it('fails closed when gh itself fails', () => {
    expect(run(merge, { ghDir: fakeGh(view(), 1) })).toBe(2);
  });

  it('fails closed when gh is not installed', () => {
    expect(run(merge, { system: false })).toBe(2);
  });

  it.each([
    'gh pr merge 5 --admin',
    'time gh pr merge 5 --admin',
    'gh pr merge 5 --auto',
    'gh api -X PUT repos/oryshchych/silk/pulls/5/merge',
    'bash -c "gh pr merge 5"',
    'git push origin main',
  ])('refuses without asking GitHub: %s', (command) => {
    expect(run(command)).toBe(2);
  });

  it.each([
    'gh pr view 5',
    'echo gh pr merge 5',
    'git status',
    'git push origin feat/x',
    'pnpm verify',
  ])('ignores: %s', (command) => {
    expect(run(command)).toBe(0);
  });

  it('refuses a bare push while main is checked out, and allows it on a feature branch', () => {
    const repo = mkdtempSync(join(tmpdir(), 'push-check-'));
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOME: repo },
      });
    git('init', '-q', '-b', 'main');
    expect(run('git push', { cwd: repo })).toBe(2);
    git('checkout', '-q', '-b', 'feat/x');
    expect(run('git push', { cwd: repo })).toBe(0);
  });

  it('does not block on garbage input', () => {
    const status = spawnSync(process.execPath, [hook], {
      cwd: root,
      input: 'not json',
      encoding: 'utf8',
    }).status;
    expect(status).toBe(0);
  });
});
