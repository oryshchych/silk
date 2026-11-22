/**
 * Merge gate rules: the objective conditions under which an agent session may
 * merge a PR, and the command classifier that finds every way a command could
 * merge a PR or push to `main`. Pure functions, no I/O. The orchestration that
 * talks to GitHub and git lives in `guard-merge.ts`; the Claude Code hook is
 * `.claude/hooks/guard-merge.mjs`.
 *
 * Node runs this file directly (type stripping), so it has no imports and uses
 * only erasable syntax.
 *
 * Scope. This catches agent mistakes and plain obfuscation. It is not a
 * sandbox: a script run by an interpreter can still do anything. The backstop is
 * branch protection on `main`, which the owner has to enable
 * (docs/plan/OWNER_QUEUE.md, Q9).
 */

export interface CheckEntry {
  name?: string;
  context?: string;
  /** GitHub Actions check run: QUEUED, IN_PROGRESS, COMPLETED. */
  status?: string;
  /** GitHub Actions check run result: SUCCESS, FAILURE, ... */
  conclusion?: string;
  /** Commit status context (not a check run): SUCCESS, PENDING, FAILURE, ERROR. */
  state?: string;
}

export interface PrComment {
  body: string;
  author?: { login?: string } | null;
}

export interface PrSnapshot {
  state: string;
  baseRefName: string;
  isDraft: boolean;
  mergeable: string;
  headRefOid: string;
  statusCheckRollup: CheckEntry[];
  comments: PrComment[];
  files: { path: string }[];
  changedFiles: number;
}

export interface GateContext {
  /** CI job names that must have succeeded (from ci.yml on main). */
  requiredChecks: readonly string[];
  /** Logins allowed to author the review report (the authenticated gh user). */
  trustedLogins: readonly string[];
  /** The value given to `--match-head-commit`, if any. */
  matchHeadCommit: string | null;
}

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Files that define the guard rails. A PR that touches them is merged by the
 * owner, never by an agent: otherwise a session could weaken the gate and use
 * the weakened gate to merge itself.
 */
const PROTECTED_PATHS: readonly RegExp[] = [
  /^\.claude\/settings\.json$/,
  /^\.claude\/hooks\//,
  /^\.claude\/skills\/review-pr-silk\//,
  /^scripts\/(merge-gate|guard-merge)/,
  /^\.github\/workflows\//,
  /^docs\/AUTONOMOUS_MODE\.md$/,
];

export function protectedPathsTouched(paths: readonly string[]): string[] {
  return paths.filter((path) => PROTECTED_PATHS.some((pattern) => pattern.test(path)));
}

const checkName = (entry: CheckEntry): string => entry.name ?? entry.context ?? 'unnamed check';

function isSuccess(entry: CheckEntry): boolean {
  if (entry.state !== undefined) return entry.state === 'SUCCESS';
  return entry.status === 'COMPLETED' && entry.conclusion === 'SUCCESS';
}

function isPassing(entry: CheckEntry): boolean {
  if (isSuccess(entry)) return true;
  return (
    entry.state === undefined &&
    entry.status === 'COMPLETED' &&
    (entry.conclusion === 'NEUTRAL' || entry.conclusion === 'SKIPPED')
  );
}

function describe(entry: CheckEntry): string {
  const label = checkName(entry);
  if (entry.state !== undefined) return `${label}: ${entry.state.toLowerCase()}`;
  if (entry.status !== 'COMPLETED') return `${label}: ${(entry.status ?? 'unknown').toLowerCase()}`;
  return `${label}: ${(entry.conclusion ?? 'unknown').toLowerCase()}`;
}

/**
 * Names of the jobs in a GitHub Actions workflow file: the job's `name:` if it
 * has one, otherwise its id. A small reader for the layout we use (jobs at two
 * spaces, `name:` at four), not a YAML parser. Matrix jobs, reusable workflows
 * and `${{ }}` names are not understood: they show up as "has not reported",
 * which refuses the merge (the safe direction).
 */
export function requiredCheckNames(workflow: string): string[] {
  const jobs: { id: string; name: string | null }[] = [];
  let inJobs = false;
  for (const line of workflow.split('\n')) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs || /^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) {
      inJobs = false;
      continue;
    }
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (job !== null) {
      jobs.push({ id: job[1] ?? '', name: null });
      continue;
    }
    const name = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    const last = jobs[jobs.length - 1];
    if (name !== null && last !== undefined && last.name === null) {
      last.name = (name[1] ?? '').replace(/^["']|["']$/g, '');
    }
  }
  return jobs.map((job) => job.name ?? job.id);
}

/**
 * The latest review-pr-silk verdict comment by a trusted author. The header must
 * be the very first characters of the comment, so a quote, a code block or a
 * later line cannot pass for a report. The sha needs at least 12 hex characters.
 * Note: the agent runs as the same GitHub user as the owner, so this proves the
 * report was posted, not that the review was honest. CI and the pinned head
 * commit are what the gate can actually enforce.
 */
export function latestReview(
  comments: readonly PrComment[],
  trustedLogins: readonly string[],
): { verdict: string; sha: string } | null {
  for (const comment of [...comments].reverse()) {
    if (!trustedLogins.includes(comment.author?.login ?? '')) continue;
    const header = /^##\s*review-pr-silk:\s*(PASS|FAIL)(?![\w-])[^\n]*/.exec(comment.body);
    if (header === null) continue;
    const sha = /@\s*`?([0-9a-f]{12,40})`?/i.exec(header[0]);
    return { verdict: header[1] ?? '', sha: sha?.[1]?.toLowerCase() ?? '' };
  }
  return null;
}

export function evaluateMerge(pr: PrSnapshot, context: GateContext): GateResult {
  const reasons: string[] = [];
  const head = pr.headRefOid.toLowerCase();

  if (pr.state !== 'OPEN') reasons.push(`the PR is ${pr.state.toLowerCase()}, not open`);
  if (pr.baseRefName !== 'main') {
    reasons.push(`the base is "${pr.baseRefName}"; every PR must target main (no stacking)`);
  }
  if (pr.isDraft) reasons.push('the PR is a draft');
  if (pr.mergeable === 'CONFLICTING') reasons.push('the PR has merge conflicts');
  else if (pr.mergeable !== 'MERGEABLE') {
    reasons.push(
      `mergeability is ${pr.mergeable.toLowerCase()}` +
        (pr.mergeable === 'UNKNOWN' ? ': GitHub is still computing it, retry in a minute' : ''),
    );
  }

  if (pr.files.length < pr.changedFiles) {
    reasons.push(
      `GitHub lists only ${String(pr.files.length)} of ${String(pr.changedFiles)} changed files, ` +
        'so the guard-rail paths cannot be checked',
    );
  }
  const guarded = protectedPathsTouched(pr.files.map((file) => file.path));
  if (guarded.length > 0) {
    reasons.push(
      `the PR changes the guard rails (${guarded.slice(0, 3).join(', ')}${guarded.length > 3 ? ', ...' : ''}): ` +
        'the owner merges those',
    );
  }

  if (context.requiredChecks.length === 0) {
    reasons.push('could not determine the required CI checks from the workflow file');
  }
  const byName = new Map<string, CheckEntry[]>();
  for (const entry of pr.statusCheckRollup) {
    byName.set(checkName(entry), [...(byName.get(checkName(entry)) ?? []), entry]);
  }
  const problems: string[] = [];
  for (const name of context.requiredChecks) {
    // Only real check runs count: a commit status with the same name cannot stand in.
    const runs = (byName.get(name) ?? []).filter((entry) => entry.state === undefined);
    if (runs.length === 0) problems.push(`${name}: has not reported`);
    // Every entry under the name must succeed: the order of the rollup is not chronological.
    for (const run of runs) if (!isSuccess(run)) problems.push(describe(run));
  }
  for (const [name, entries] of byName) {
    if (context.requiredChecks.includes(name)) continue;
    for (const entry of entries) if (!isPassing(entry)) problems.push(describe(entry));
  }
  if (problems.length > 0) reasons.push(`CI is not green: ${problems.join(', ')}`);

  const review = latestReview(pr.comments, context.trustedLogins);
  if (review === null) {
    reasons.push('no review-pr-silk report by a trusted author: run the skill first');
  } else if (review.verdict !== 'PASS') {
    reasons.push('the latest review-pr-silk verdict is FAIL: fix the findings and re-run it');
  } else if (review.sha === '') {
    reasons.push(
      'the review-pr-silk report does not name the head commit (12 or more hex characters)',
    );
  } else if (!head.startsWith(review.sha)) {
    reasons.push(
      `the review-pr-silk PASS is for ${review.sha}, but the PR head is ${head.slice(0, 12)}: ` +
        're-run the skill after the last push',
    );
  }

  if (context.matchHeadCommit === null) {
    reasons.push(
      'pass --match-head-commit <full head sha> so GitHub refuses the merge if the PR changes',
    );
  } else if (context.matchHeadCommit.toLowerCase() !== head) {
    reasons.push(
      `--match-head-commit ${context.matchHeadCommit} does not match the PR head ${head}`,
    );
  }

  return { ok: reasons.length === 0, reasons };
}

export type Classified =
  | { kind: 'merge'; ref: string | null; repo: string | null; matchHeadCommit: string | null }
  | { kind: 'refuse'; reason: string }
  /** A push whose target depends on the current branch: refuse it on `main`. */
  | { kind: 'push-check' };

export interface Word {
  text: string;
  /** The shell would compute this word: `$X`, backticks, globs, braces, `$'\\x..'`. */
  dynamic: boolean;
}

/**
 * Splits a shell command line into simple commands, each a list of words.
 * Quotes are removed (so `"mer"ge` reads as `merge`), `$'...'` quoting and line
 * continuations are understood, comments are dropped, and `;`, `&`, `|`, `(`,
 * `)` and newlines end a command only when unquoted. Words the shell would
 * expand are flagged `dynamic`, because their value cannot be known here.
 * Heredoc bodies are NOT skipped: each body line is read as a command, which
 * errs on the side of refusing text that merely mentions these commands.
 */
export function tokenize(input: string): Word[][] {
  const source = input.replace(/\\\r?\n/g, '');
  const commands: Word[][] = [];
  let words: Word[] = [];
  let text = '';
  let dynamic = false;
  let inWord = false;
  let quote: '"' | "'" | 'ansi' | null = null;

  const endWord = (): void => {
    if (inWord) words.push({ text, dynamic });
    text = '';
    dynamic = false;
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };

  for (let i = 0; i < source.length; i++) {
    const char = source.charAt(i);
    if (quote === "'") {
      if (char === "'") quote = null;
      else text += char;
    } else if (quote === 'ansi') {
      if (char === '\\') {
        dynamic = true;
        text += source.charAt(++i);
      } else if (char === "'") quote = null;
      else text += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '\\') text += source.charAt(++i);
      else {
        if (char === '$' || char === '`') dynamic = true;
        text += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === '$' && source.charAt(i + 1) === "'") {
      quote = 'ansi';
      inWord = true;
      i++;
    } else if (char === '\\') {
      text += source.charAt(++i);
      inWord = true;
    } else if (char === '#' && !inWord) {
      while (i + 1 < source.length && source.charAt(i + 1) !== '\n') i++;
    } else if (char === ' ' || char === '\t' || char === '\r') {
      endWord();
    } else if ('\n;&|()'.includes(char)) {
      endCommand();
    } else {
      if ('$`*?[{~'.includes(char)) dynamic = true;
      text += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

const programName = (word: Word | undefined): string => (word?.text ?? '').split('/').pop() ?? '';
const textAt = (words: Word[], index: number): string | undefined => words[index]?.text;

const SHELLS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'ash',
  'fish',
  'csh',
  'tcsh',
  'busybox',
  'eval',
  'xargs',
]);

// Top-level `gh` commands. Anything else is an alias or an extension, which can
// hide a merge, so it is refused.
const KNOWN_GH = new Set([
  'agent-task',
  'alias',
  'api',
  'attestation',
  'auth',
  'browse',
  'cache',
  'codespace',
  'completion',
  'config',
  'copilot',
  'extension',
  'gist',
  'gpg-key',
  'help',
  'issue',
  'label',
  'licenses',
  'org',
  'pr',
  'preview',
  'project',
  'release',
  'repo',
  'ruleset',
  'run',
  'search',
  'secret',
  'ssh-key',
  'status',
  'variable',
  'version',
  'workflow',
]);

// `gh pr merge` flags that take a value, so the value is not mistaken for the PR.
const MERGE_VALUE_FLAGS = new Set([
  '--body',
  '-b',
  '--body-file',
  '-F',
  '--subject',
  '-t',
  '--author-email',
  '-A',
]);

const MERGE_API_PATTERN =
  /\/pulls\/[^/\s]*\/merge\b|mergePullRequest|enablePullRequestAutoMerge|enableAutoMerge/;

const refuse = (reason: string): Classified => ({ kind: 'refuse', reason });

function classifyGh(words: Word[]): Classified | null {
  let i = 1;
  let repo: string | null = null;
  // Global flags may stand before the subcommand: gh --repo owner/name pr merge 5.
  while (i < words.length && (textAt(words, i) ?? '').startsWith('-')) {
    const flag = textAt(words, i) ?? '';
    if (flag === '--repo' || flag === '-R') {
      repo = textAt(words, i + 1) ?? null;
      i += 2;
    } else {
      if (flag.startsWith('--repo=')) repo = flag.slice('--repo='.length);
      else if (flag.startsWith('-R') && flag.length > 2) repo = flag.slice(2);
      i++;
    }
  }

  const top = words[i];
  if (top === undefined) return null;
  if (top.dynamic) return refuse('the gh subcommand is built by the shell; write it literally');
  if (!KNOWN_GH.has(top.text)) {
    return refuse(
      `unknown gh subcommand "${top.text}" (an alias can hide a merge); use the real command`,
    );
  }
  if (top.text === 'alias' || top.text === 'extension') {
    return refuse(`gh ${top.text} can hide a merge from the gate`);
  }

  if (top.text === 'pr') {
    const sub = words[i + 1];
    if (sub?.dynamic === true)
      return refuse('the gh pr subcommand is built by the shell; write it literally');
    if (sub?.text !== 'merge') return null;

    let ref: string | null = null;
    let matchHeadCommit: string | null = null;
    const rest = words.slice(i + 2);
    if (rest.some((word) => word.dynamic)) {
      return refuse(
        'an argument of the merge is built by the shell ($, backticks, globs); write it literally',
      );
    }
    for (let j = 0; j < rest.length; j++) {
      const word = rest[j];
      if (word === undefined) continue;
      if (word.dynamic) {
        return refuse(
          'an argument of the merge is built by the shell ($, backticks, globs); write it literally',
        );
      }
      const flag = word.text;
      if (flag === '--admin') return refuse('--admin bypasses the review gate');
      if (flag === '--auto') {
        return refuse('--auto merges later without re-checking; merge now, once the gate passes');
      }
      if (flag === '--repo' || flag === '-R') repo = rest[++j]?.text ?? null;
      else if (flag.startsWith('--repo=')) repo = flag.slice('--repo='.length);
      else if (flag.startsWith('-R') && flag.length > 2) repo = flag.slice(2);
      else if (flag === '--match-head-commit') matchHeadCommit = rest[++j]?.text ?? null;
      else if (flag.startsWith('--match-head-commit=')) {
        matchHeadCommit = flag.slice('--match-head-commit='.length);
      } else if (MERGE_VALUE_FLAGS.has(flag)) j++;
      else if (!flag.startsWith('-') && ref === null) ref = flag;
    }
    return { kind: 'merge', ref, repo, matchHeadCommit };
  }

  if (top.text === 'api') {
    const text = words
      .slice(i + 1)
      .map((word) => word.text)
      .join(' ');
    if (MERGE_API_PATTERN.test(text)) {
      return refuse('merging through `gh api` skips the gate; use `gh pr merge`');
    }
  }
  return null;
}

// git options that take a value and can redirect where or how git runs.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

interface GitCall {
  subcommand: string | undefined;
  redirected: boolean;
  args: Word[];
}

function parseGit(words: Word[]): { call: GitCall; problem: Classified | null } {
  let i = 1;
  let redirected = false;
  while (i < words.length && (textAt(words, i) ?? '').startsWith('-')) {
    const flag = textAt(words, i) ?? '';
    if (GIT_VALUE_OPTIONS.has(flag)) {
      redirected = true;
      if (flag === '-c' && /^alias\./i.test(textAt(words, i + 1) ?? '')) {
        return {
          call: { subcommand: undefined, redirected, args: [] },
          problem: refuse('a git alias can hide a push to main'),
        };
      }
      i += 2;
    } else {
      if (/^--(git-dir|work-tree|namespace)=/.test(flag)) redirected = true;
      i++;
    }
  }
  return {
    call: { subcommand: textAt(words, i), redirected, args: words.slice(i + 1) },
    problem: null,
  };
}

/** Does a push refspec put something on main? `main`, `HEAD:main`, `+main`, `:main`. */
function refspecTargetsMain(refspec: string): boolean {
  const spec = refspec.replace(/^\+/, '');
  const destination = spec.includes(':') ? spec.slice(spec.lastIndexOf(':') + 1) : spec;
  return destination === 'main' || destination === 'refs/heads/main';
}

function classifyGit(words: Word[]): { result: Classified | null; changesContext: boolean } {
  const { call, problem } = parseGit(words);
  if (problem !== null) return { result: problem, changesContext: false };
  const changesContext = call.subcommand === 'checkout' || call.subcommand === 'switch';

  if (call.subcommand === 'config') {
    if (call.args.some((arg) => /^alias\./i.test(arg.text))) {
      return { result: refuse('a git alias can hide a push to main'), changesContext };
    }
    return { result: null, changesContext };
  }
  if (call.subcommand !== 'push') return { result: null, changesContext };

  if (call.redirected) {
    return {
      result: refuse(
        'git push with -C, -c, --git-dir or --work-tree: run it from the repository directory',
      ),
      changesContext,
    };
  }
  if (call.args.some((arg) => arg.dynamic)) {
    return {
      result: refuse('an argument of git push is built by the shell; write it literally'),
      changesContext,
    };
  }
  const texts = call.args.map((arg) => arg.text);
  if (texts.includes('--all') || texts.includes('--mirror')) {
    return {
      result: refuse('pushing all branches could update main; open a PR instead'),
      changesContext,
    };
  }
  const refspecs = texts.filter((arg) => !arg.startsWith('-')).slice(1);
  if (refspecs.some((spec) => /[*?[]/.test(spec))) {
    return { result: refuse('a glob refspec could update main; name the branch'), changesContext };
  }
  if (refspecs.some(refspecTargetsMain)) {
    return {
      result: refuse('no direct push to main; open a PR (AGENTS.md section 6)'),
      changesContext,
    };
  }
  if (refspecs.length === 0 || refspecs.includes('HEAD')) {
    return { result: { kind: 'push-check' }, changesContext };
  }
  return { result: null, changesContext };
}

/** Everything in a command line that could merge a PR or push to main. */
export function classifyCommand(command: string): Classified[] {
  const found: Classified[] = [];
  let changesContext = false;

  for (const words of tokenize(command)) {
    const first = textAt(words, 0);
    if (first === 'cd' || first === 'pushd') changesContext = true;
    // Any position: this looks through every wrapper (time, timeout -s KILL 30,
    // env -u X, sudo -u root, if, then, ...) without a list of them.
    for (let k = 0; k < words.length; k++) {
      const program = programName(words[k]);
      const rest = words.slice(k);
      if (program === 'gh') {
        const result = classifyGh(rest);
        if (result !== null) found.push(result);
      } else if (program === 'git') {
        const git = classifyGit(rest);
        if (git.result !== null) found.push(git.result);
        if (git.changesContext) changesContext = true;
      } else if (SHELLS.has(program)) {
        const text = rest
          .slice(1)
          .map((word) => word.text)
          .join(' ');
        const merges =
          /\bgh\b/.test(text) && (/\bpr\s+merge\b/.test(text) || MERGE_API_PATTERN.test(text));
        const pushesMain = /\bgit\b[^;|&]*\bpush\b[^;|&]*\bmain\b/.test(text);
        if (merges || pushesMain) {
          found.push(
            refuse(
              `\`${program}\` hides a merge or a push to main from the gate; run the command directly`,
            ),
          );
        }
      }
    }
  }

  // A merge inside a command substitution: echo $(gh pr merge 5), `gh pr merge 5`.
  if (
    /\$\([^)]*\bgh\b[^)]*\bpr\s+merge\b/.test(command) ||
    /`[^`]*\bgh\b[^`]*\bpr\s+merge\b[^`]*`/.test(command)
  ) {
    found.push(refuse('a merge inside a command substitution skips the gate'));
  }

  const merges = found.filter((item) => item.kind === 'merge');
  if (merges.length > 0 && /\bGH_(REPO|HOST)\s*=/.test(command)) {
    found.push(
      refuse(
        'GH_REPO / GH_HOST would point the merge at a different repository than the gate checked',
      ),
    );
  }
  if (merges.length > 1) {
    return [refuse('one merge per command, so each one is gated')];
  }
  if (changesContext && found.some((item) => item.kind === 'push-check')) {
    found.push(
      refuse(
        'switching directory or branch in the same command as a push: the branch check would be wrong',
      ),
    );
  }
  return found;
}
