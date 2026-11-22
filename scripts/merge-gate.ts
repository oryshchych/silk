/**
 * Merge gate: the objective conditions under which an agent session may merge
 * a PR, plus the command classifier that finds every way a command could merge
 * or push to `main`. Used by the `guard-merge` Claude Code hook and unit-tested
 * separately. Pure functions, no I/O.
 *
 * The hook imports this file directly (Node runs TypeScript with type
 * stripping), so keep it free of imports and of non-erasable syntax.
 *
 * This guards against agent mistakes. It is not a sandbox: a script run by an
 * interpreter can still do anything. The real backstop is branch protection on
 * `main`, which the owner has to enable (see docs/plan/OWNER_QUEUE.md).
 */

export interface CheckEntry {
  name?: string;
  context?: string;
  /** GitHub Actions check run: QUEUED, IN_PROGRESS, COMPLETED. */
  status?: string;
  /** GitHub Actions check run result: SUCCESS, FAILURE, ... */
  conclusion?: string;
  /** Commit status context: SUCCESS, PENDING, FAILURE, ERROR. */
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
}

export interface GateContext {
  /** CI job names that must have succeeded (from ci.yml at the PR head). */
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
 * spaces, `name:` at four), not a YAML parser.
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
 * be the very first line of the comment, so a quote, a code block or a later
 * line cannot pass for a report. The sha must have at least 12 hex characters.
 */
export function latestReview(
  comments: readonly PrComment[],
  trustedLogins: readonly string[],
): { verdict: string; sha: string } | null {
  for (const comment of [...comments].reverse()) {
    if (!trustedLogins.includes(comment.author?.login ?? '')) continue;
    const header = /^\s*##\s*review-pr-silk:\s*(PASS|FAIL)\b[^\n]*/.exec(comment.body);
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

  // Latest entry per check name: a re-run replaces the earlier attempt.
  const latest = new Map<string, CheckEntry>();
  for (const entry of pr.statusCheckRollup) latest.set(checkName(entry), entry);

  if (context.requiredChecks.length === 0) {
    reasons.push('could not determine the required CI checks from the workflow file');
  }
  const problems: string[] = [];
  for (const name of context.requiredChecks) {
    const entry = latest.get(name);
    if (entry === undefined) problems.push(`${name}: has not reported`);
    else if (!isSuccess(entry)) problems.push(describe(entry));
  }
  for (const [name, entry] of latest) {
    if (!context.requiredChecks.includes(name) && !isPassing(entry)) problems.push(describe(entry));
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

/**
 * Splits a shell command line into simple commands, each a list of words.
 * Quotes group words and hide operators (`;`, `&&`, `||`, `|`, `&`, newline),
 * which end a command only when they are unquoted. A small tokenizer: enough
 * to read the commands we care about, not a shell parser.
 */
export function splitCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;

  const endWord = (): void => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };

  for (let i = 0; i < command.length; i++) {
    const char = command.charAt(i);
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"') word += command.charAt(++i);
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
    } else if (char === '\\') {
      word += command.charAt(++i);
      inWord = true;
    } else if (/\s/.test(char) && char !== '\n') {
      endWord();
    } else if ('\n;&|()'.includes(char)) {
      endCommand();
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PREFIX_COMMANDS = new Set([
  'time',
  'nohup',
  'command',
  'exec',
  'sudo',
  'env',
  'nice',
  'timeout',
  'stdbuf',
  'then',
  'do',
]);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'eval', 'xargs']);

/** Drops `FOO=1`, `time`, `timeout 30`, `nohup`, `sudo`, `(` and similar prefixes. */
function stripPrefix(input: string[]): string[] {
  const words = [...input];
  if (words[0] !== undefined) words[0] = words[0].replace(/^[({]+/, '');
  let i = 0;
  while (i < words.length) {
    const word = words[i] ?? '';
    if (word === '' || word === '!') {
      i++;
    } else if (ENV_ASSIGNMENT.test(word)) {
      i++;
    } else if (PREFIX_COMMANDS.has(word)) {
      i++;
      while (i < words.length) {
        const next = words[i] ?? '';
        if (next.startsWith('-') || ENV_ASSIGNMENT.test(next) || /^\d+(\.\d+)?[smhd]?$/.test(next))
          i++;
        else break;
      }
    } else {
      break;
    }
  }
  return words.slice(i);
}

const programName = (word: string | undefined): string => (word ?? '').split('/').pop() ?? '';

// `gh pr merge` flags that take a value, so the value is not mistaken for the PR.
const MERGE_VALUE_FLAGS = new Set([
  '--body',
  '-b',
  '--body-file',
  '-F',
  '--subject',
  '-t',
  '--author-email',
]);

function classifyGh(words: string[]): Classified | null {
  let i = 1;
  let repo: string | null = null;
  // Global flags may stand before the subcommand: gh --repo owner/name pr merge 5.
  while (i < words.length && (words[i] ?? '').startsWith('-')) {
    const flag = words[i] ?? '';
    if (flag === '--repo' || flag === '-R') {
      repo = words[i + 1] ?? null;
      i += 2;
    } else {
      if (flag.startsWith('--repo=')) repo = flag.slice('--repo='.length);
      i++;
    }
  }

  if (words[i] === 'pr' && words[i + 1] === 'merge') {
    let ref: string | null = null;
    let matchHeadCommit: string | null = null;
    const rest = words.slice(i + 2);
    for (let j = 0; j < rest.length; j++) {
      const word = rest[j] ?? '';
      if (word === '--admin') {
        return { kind: 'refuse', reason: '--admin bypasses the review gate' };
      }
      if (word === '--auto') {
        return {
          kind: 'refuse',
          reason: '--auto merges later without re-checking; merge now, once the gate passes',
        };
      }
      if (word === '--repo' || word === '-R') repo = rest[++j] ?? null;
      else if (word.startsWith('--repo=')) repo = word.slice('--repo='.length);
      else if (word === '--match-head-commit') matchHeadCommit = rest[++j] ?? null;
      else if (word.startsWith('--match-head-commit=')) {
        matchHeadCommit = word.slice('--match-head-commit='.length);
      } else if (MERGE_VALUE_FLAGS.has(word)) j++;
      else if (!word.startsWith('-') && ref === null) ref = word;
    }
    return { kind: 'merge', ref, repo, matchHeadCommit };
  }

  if (words[i] === 'api') {
    const text = words.slice(i + 1).join(' ');
    if (
      /\/pulls\/\d+\/merge\b/.test(text) ||
      /mergePullRequest|enablePullRequestAutoMerge|enableAutoMerge/.test(text)
    ) {
      return {
        kind: 'refuse',
        reason: 'merging through `gh api` skips the gate; use `gh pr merge`',
      };
    }
  }
  return null;
}

/** Does a push refspec put something on main? `main`, `HEAD:main`, `+main`, `:main`. */
function refspecTargetsMain(refspec: string): boolean {
  const spec = refspec.replace(/^\+/, '');
  const destination = spec.includes(':') ? spec.slice(spec.lastIndexOf(':') + 1) : spec;
  return destination === 'main' || destination === 'refs/heads/main';
}

function classifyGit(words: string[]): Classified | null {
  let i = 1;
  // Global options before the subcommand: git -C dir push, git -c key=value push.
  while (i < words.length && (words[i] ?? '').startsWith('-')) {
    i += words[i] === '-C' || words[i] === '-c' ? 2 : 1;
  }
  if (words[i] !== 'push') return null;

  const args = words.slice(i + 1);
  if (args.includes('--all') || args.includes('--mirror')) {
    return { kind: 'refuse', reason: 'pushing all branches could update main; open a PR instead' };
  }
  const positionals = args.filter((arg) => !arg.startsWith('-'));
  const refspecs = positionals.slice(1);
  if (refspecs.some(refspecTargetsMain)) {
    return { kind: 'refuse', reason: 'no direct push to main; open a PR (AGENTS.md section 6)' };
  }
  if (refspecs.length === 0 || refspecs.includes('HEAD')) return { kind: 'push-check' };
  return null;
}

/**
 * Removes the bodies of heredocs whose delimiter is quoted (`<<'EOF'`): the shell
 * does not expand them, so their text is data, not commands (documentation,
 * a script handed to python). Kept when the receiver is a shell, because
 * `bash <<'EOF'` runs the body as a script. An unquoted `<<EOF` body is kept too:
 * the shell expands substitutions in it.
 */
export function stripHeredocBodies(command: string): string {
  const lines = command.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    kept.push(line);
    const match = /<<-?\s*(?:'([A-Za-z_][\w-]*)'|"([A-Za-z_][\w-]*)"|\\([A-Za-z_][\w-]*))/.exec(
      line,
    );
    if (match === null) continue;
    const delimiter = match[1] ?? match[2] ?? match[3] ?? '';
    const receiverCommands = splitCommands(line.slice(0, match.index));
    const receiver = programName(
      stripPrefix(receiverCommands[receiverCommands.length - 1] ?? [])[0],
    );
    if (SHELLS.has(receiver) || receiver === 'source' || receiver === '.') continue;
    while (i + 1 < lines.length) {
      i++;
      if ((lines[i] ?? '').trim() === delimiter) break;
    }
  }
  return kept.join('\n');
}

/** Everything in a command line that could merge a PR or push to main. */
export function classifyCommand(input: string): Classified[] {
  const command = stripHeredocBodies(input);
  const found: Classified[] = [];
  for (const raw of splitCommands(command)) {
    const words = stripPrefix(raw);
    const program = programName(words[0]);
    let result: Classified | null = null;
    if (program === 'gh') result = classifyGh(words);
    else if (program === 'git') result = classifyGit(words);
    else if (SHELLS.has(program)) {
      const text = words.slice(1).join(' ');
      const merges =
        /\bgh\b/.test(text) &&
        (/\bpr\s+merge\b/.test(text) ||
          /mergePullRequest|enablePullRequestAutoMerge/.test(text) ||
          /\/pulls\/\d+\/merge\b/.test(text));
      const pushesMain = /\bgit\b[^;|&]*\bpush\b[^;|&]*\bmain\b/.test(text);
      if (merges || pushesMain) {
        result = {
          kind: 'refuse',
          reason: `\`${program}\` hides a merge or a push to main from the gate; run the command directly`,
        };
      }
    }
    if (result !== null) found.push(result);
  }

  // A merge inside a command substitution: echo $(gh pr merge 5), `gh pr merge 5`.
  if (
    /\$\([^)]*\bgh\b[^)]*\bpr\s+merge\b/.test(command) ||
    /`[^`]*\bgh\b[^`]*\bpr\s+merge\b[^`]*`/.test(command)
  ) {
    found.push({ kind: 'refuse', reason: 'a merge inside a command substitution skips the gate' });
  }

  if (found.filter((item) => item.kind === 'merge').length > 1) {
    return [{ kind: 'refuse', reason: 'one merge per command, so each one is gated' }];
  }
  return found;
}
