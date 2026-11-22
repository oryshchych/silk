// PreToolUse(Bash): nothing reaches `main` except through the merge gate.
//
// Thin wrapper: the rules are in scripts/merge-gate.ts and the orchestration in
// scripts/guard-merge.ts (both tested). Every Bash command is classified; there
// is no cheap text prefilter, because a prefilter is a bypass (aliases, quoting).
//
// Fail closed: once anything goes wrong (the module fails to load, GitHub is
// unreachable, an unexpected answer), the command is refused.
import { execFileSync } from 'node:child_process';

import { block, projectDir, readInput } from './lib.mjs';

const input = readInput();
const command = input.tool_input?.command;
if (typeof command !== 'string') process.exit(0);

const refuse = (message) => block(`Blocked by guard-merge: ${message}`);

function failClosed(error) {
  const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
  refuse(
    `internal error (${detail}). Merging and pushing to main are refused when the gate cannot run.`,
  );
}
process.on('uncaughtException', failClosed);
process.on('unhandledRejection', failClosed);

// The directory the agent command runs in decides the current branch.
const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : projectDir;
const run = (program, args, directory) =>
  execFileSync(program, args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

try {
  const { guard } = await import('../../scripts/guard-merge.ts');
  const result = guard(command, {
    gh: (args) => run('gh', args, projectDir),
    git: (args) => run('git', args, cwd),
  });
  if (result.refusal !== null) refuse(result.refusal);
} catch (error) {
  failClosed(error);
}
