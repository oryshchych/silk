import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `allowUnquoted` is the core's opt-out of the quote guard (Q12) for code that creates orders
 * without a buyer looking at a total. No server action may ever set it: a buyer-facing order
 * without a confirmed total would defeat the guard.
 */
describe('server actions', () => {
  it('never opt out of the quote guard', () => {
    const dir = import.meta.dirname;
    const files = readdirSync(dir).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(/allowUnquoted/);
    }
  });
});
