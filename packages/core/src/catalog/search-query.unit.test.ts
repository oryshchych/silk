import { describe, expect, it } from 'vitest';

import { MAX_QUERY_LENGTH, normalizeSearchQuery } from './search';

describe('normalizeSearchQuery', () => {
  it('cuts the query at the limit', () => {
    expect(MAX_QUERY_LENGTH).toBe(100);
    expect(normalizeSearchQuery('a'.repeat(500))).toHaveLength(100);
  });

  it('turns control characters, including NUL, into spaces and collapses whitespace', () => {
    expect(normalizeSearchQuery('br\u0000a')).toBe('br a');
    expect(normalizeSearchQuery('\u0000\u0000')).toBe('');
    expect(normalizeSearchQuery('a\u0001\u007f\u001fb\t\nc')).toBe('a b c');
    expect(normalizeSearchQuery('  many   spaces  ')).toBe('many spaces');
  });

  it('keeps ordinary Ukrainian, English and punctuation text', () => {
    expect(normalizeSearchQuery('Бюстгальтер «Аврора» push-up')).toBe(
      'Бюстгальтер «Аврора» push-up',
    );
  });
});
