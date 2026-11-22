/**
 * Merge gate: the objective conditions under which an agent session may run
 * `gh pr merge`. Used by the `guard-merge` Claude Code hook and unit-tested
 * separately. Pure functions: no I/O, so every rule is easy to test.
 *
 * The hook imports this file directly (Node runs TypeScript with type
 * stripping), so keep it free of imports and non-erasable syntax.
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

export interface PrSnapshot {
  state: string;
  baseRefName: string;
  isDraft: boolean;
  mergeable: string;
  headRefOid: string;
  statusCheckRollup: CheckEntry[];
  comments: { body: string }[];
}

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

const PASSING_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

function checkProblem(entry: CheckEntry): string | null {
  const label = entry.name ?? entry.context ?? 'unnamed check';
  if (entry.state !== undefined) {
    return entry.state === 'SUCCESS' ? null : `${label}: ${entry.state.toLowerCase()}`;
  }
  if (entry.status !== 'COMPLETED') return `${label}: ${(entry.status ?? 'unknown').toLowerCase()}`;
  const conclusion = entry.conclusion ?? '';
  return PASSING_CONCLUSIONS.has(conclusion) ? null : `${label}: ${conclusion.toLowerCase()}`;
}

/** The latest review-pr-silk verdict comment, with the commit it reviewed. */
export function latestReview(
  comments: readonly { body: string }[],
): { verdict: string; sha: string } | null {
  for (const comment of [...comments].reverse()) {
    const header = /^##\s*review-pr-silk:\s*(PASS|FAIL)\b.*$/m.exec(comment.body);
    if (header === null) continue;
    const sha = /@\s*`?([0-9a-f]{7,40})`?/i.exec(header[0]);
    return { verdict: header[1] ?? '', sha: sha?.[1]?.toLowerCase() ?? '' };
  }
  return null;
}

export function evaluateMerge(pr: PrSnapshot): GateResult {
  const reasons: string[] = [];

  if (pr.state !== 'OPEN') reasons.push(`the PR is ${pr.state.toLowerCase()}, not open`);
  if (pr.baseRefName !== 'main') {
    reasons.push(`the base is "${pr.baseRefName}"; every PR must target main (no stacking)`);
  }
  if (pr.isDraft) reasons.push('the PR is a draft');
  if (pr.mergeable === 'CONFLICTING') reasons.push('the PR has merge conflicts');

  if (pr.statusCheckRollup.length === 0) {
    reasons.push('no CI checks reported yet');
  } else {
    const problems = pr.statusCheckRollup
      .map(checkProblem)
      .filter((problem): problem is string => problem !== null);
    if (problems.length > 0) reasons.push(`CI is not green: ${problems.join(', ')}`);
  }

  const review = latestReview(pr.comments);
  const head = pr.headRefOid.toLowerCase();
  if (review === null) {
    reasons.push('no review-pr-silk report on the PR: run the skill first');
  } else if (review.verdict !== 'PASS') {
    reasons.push('the latest review-pr-silk verdict is FAIL: fix the findings and re-run it');
  } else if (review.sha === '' || !head.startsWith(review.sha)) {
    reasons.push(
      `the review-pr-silk PASS is for ${review.sha === '' ? 'no commit' : review.sha}, ` +
        `but the PR head is ${head.slice(0, 7)}: re-run the skill after the last push`,
    );
  }

  return { ok: reasons.length === 0, reasons };
}

export interface MergeCommand {
  /** The PR number, URL or branch given on the command line, if any. */
  ref: string | null;
  admin: boolean;
  /** `--repo` / `-R` value, passed through to gh when looking the PR up. */
  repo: string | null;
}

// Flags of `gh pr merge` that take a value, so the value is not mistaken for the PR.
const VALUE_FLAGS = new Set([
  '--body',
  '-b',
  '--body-file',
  '-F',
  '--subject',
  '-t',
  '--match-head-commit',
  '--author-email',
]);

/**
 * Splits a shell command line into simple commands, each a list of words.
 * Quotes group words and hide operators (`;`, `&&`, `||`, `|`, `&`, newline),
 * which end a command only when they are unquoted. It is a deliberately small
 * tokenizer: enough to read a `gh pr merge` line, not a shell parser.
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
    } else if (char === '\n' || char === ';' || char === '&' || char === '|') {
      endCommand();
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/**
 * Finds a `gh pr merge` invocation in a shell command line. Only the first
 * word of each simple command counts, so text that merely mentions the
 * command (a commit message, `echo`) is not a merge.
 */
export function parseMergeCommand(command: string): MergeCommand | null {
  for (const words of splitCommands(command)) {
    if (words[0] !== 'gh' || words[1] !== 'pr' || words[2] !== 'merge') continue;

    let ref: string | null = null;
    let repo: string | null = null;
    let admin = false;
    const rest = words.slice(3);
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i] ?? '';
      if (word === '--admin') admin = true;
      else if (word === '--repo' || word === '-R') repo = rest[++i] ?? null;
      else if (word.startsWith('--repo=')) repo = word.slice('--repo='.length);
      else if (VALUE_FLAGS.has(word)) i++;
      else if (!word.startsWith('-') && ref === null) ref = word;
    }
    return { ref, admin, repo };
  }
  return null;
}
