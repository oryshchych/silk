import { describe, expect, it } from 'vitest';

import { isProductSlug } from './slug';

describe('isProductSlug', () => {
  it('accepts lowercase hyphenated slugs up to 200 characters', () => {
    for (const ok of ['a', 'push-up-bra-aurora-1', '1-2-3', 'a'.repeat(200)]) {
      expect(isProductSlug(ok)).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const bad of [
      '',
      'Aurora',
      'a_b',
      'a--b',
      '-a',
      'a-',
      'a b',
      'a.b',
      'a/b',
      'a\u0000b',
      'a'.repeat(201),
      'бра',
    ]) {
      expect(isProductSlug(bad)).toBe(false);
    }
  });
});
