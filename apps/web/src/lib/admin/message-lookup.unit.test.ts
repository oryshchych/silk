import { describe, expect, it } from 'vitest';

import { makeTranslator } from './message-lookup';

const messages = { admin: { x: { a: 'Hello {name}, {n} left', nested: { b: 'B' } } } };

describe('makeTranslator', () => {
  const t = makeTranslator(messages, 'admin.x');
  it('reads nested keys and fills placeholders', () => {
    expect(t('a', { name: 'Ann', n: 2 })).toBe('Hello Ann, 2 left');
    expect(t('nested.b')).toBe('B');
  });
  it('shows the path of a missing key and ignores prototype keys', () => {
    expect(t('nope')).toBe('admin.x.nope');
    expect(t('constructor')).toBe('admin.x.constructor');
    expect(t('a.length')).toBe('admin.x.a.length');
  });
});
