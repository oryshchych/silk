/**
 * Regression tests for the project commitlint rules (commitlint.config.js).
 * They run the real CLI, the same way the lefthook commit-msg hook does.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

function lint(message: string): { status: number | null; output: string } {
  const result = spawnSync('pnpm', ['exec', 'commitlint'], {
    cwd: root,
    input: message,
    encoding: 'utf8',
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe('commitlint project rules', () => {
  it('accepts an English conventional commit', () => {
    expect(lint('feat(db): add a seed for local development\n').status).toBe(0);
  });

  it('rejects Cyrillic in the subject', () => {
    const result = lint('feat(db): додати seed\n');
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-cyrillic/);
  });

  it('rejects Cyrillic in the body', () => {
    const result = lint('feat(db): add a seed\n\nОпис українською.\n');
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-cyrillic/);
  });

  it('rejects an AI co-author trailer', () => {
    const result = lint('feat(db): add a seed\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/no-ai-attribution/);
  });

  it('allows a human co-author', () => {
    expect(
      lint('feat(db): add a seed\n\nCo-Authored-By: Jane Doe <jane@example.com>\n').status,
    ).toBe(0);
  });
});
