import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '../lib/error-codes';

const load = (locale: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, `../../messages/${locale}.json`), 'utf8'),
  ) as Record<string, unknown>;

/** Dotted paths of every string leaf. */
function leaves(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leaves(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

describe('messages', () => {
  const uk = load('uk');
  const en = load('en');

  it('uk and en have exactly the same keys', () => {
    expect(leaves(uk).sort()).toEqual(leaves(en).sort());
  });

  it('every error code the actions can return has a message in both languages', () => {
    for (const messages of [uk, en]) {
      const codes = (messages['errors'] as { codes: Record<string, string> }).codes;
      for (const code of ERROR_CODES) expect(codes[code]).toBeTruthy();
    }
  });
});
