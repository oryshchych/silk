import { describe, expect, it } from 'vitest';

import { isSameOrigin } from './origin';
import { parseAdminLocale, parseTheme } from './preferences';
import { tokenFromAuthorization } from './session';

describe('isSameOrigin', () => {
  it('accepts the site host only', () => {
    expect(isSameOrigin('https://shop.example', 'shop.example')).toBe(true);
    expect(isSameOrigin('https://SHOP.example', 'shop.example')).toBe(true);
    expect(isSameOrigin('https://evil.example', 'shop.example')).toBe(false);
    expect(isSameOrigin('https://shop.example.evil.example', 'shop.example')).toBe(false);
    expect(isSameOrigin('https://shop.example:8443', 'shop.example')).toBe(false);
  });

  it('refuses a missing Origin, an unparsable one and a missing expected host', () => {
    expect(isSameOrigin(null, 'shop.example')).toBe(false);
    expect(isSameOrigin('null', 'shop.example')).toBe(false);
    expect(isSameOrigin('not a url', 'shop.example')).toBe(false);
    expect(isSameOrigin('https://shop.example', null)).toBe(false);
    expect(isSameOrigin('https://shop.example', '')).toBe(false);
  });
});

describe('preferences', () => {
  it('fall back to the defaults for anything unknown', () => {
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('<script>')).toBe('system');
    expect(parseTheme(undefined)).toBe('system');
    expect(parseAdminLocale('en')).toBe('en');
    expect(parseAdminLocale('fr')).toBe('uk');
  });
});

describe('tokenFromAuthorization', () => {
  it('reads a bearer token and nothing else', () => {
    expect(tokenFromAuthorization('Bearer v1.abc.123.sig')).toBe('v1.abc.123.sig');
    for (const bad of [
      null,
      '',
      'Basic abc',
      'Bearer',
      'Bearer a b',
      `Bearer ${'x'.repeat(300)}`,
    ]) {
      expect(tokenFromAuthorization(bad), String(bad)).toBeNull();
    }
  });
});
