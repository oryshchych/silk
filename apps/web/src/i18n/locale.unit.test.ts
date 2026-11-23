import { describe, expect, it } from 'vitest';

import en from '../../messages/en.json';
import uk from '../../messages/uk.json';
import { resolveLocale } from './locale';

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

describe('resolveLocale', () => {
  it('keeps a known locale and falls back to uk for an unknown segment', () => {
    expect(resolveLocale('en')).toEqual({ locale: 'en', known: true });
    expect(resolveLocale('uk')).toEqual({ locale: 'uk', known: true });
    expect(resolveLocale('nope')).toEqual({ locale: 'uk', known: false });
    expect(resolveLocale('EN')).toEqual({ locale: 'uk', known: false });
  });
});

describe('messages', () => {
  it('have the same keys in uk.json and en.json', () => {
    expect(keys(en).sort()).toEqual(keys(uk).sort());
  });
});
