import { describe, expect, it } from 'vitest';

import { isAccountAuthPath, isAccountPath, isUnsubscribePath } from './account-path';

describe('isAccountPath', () => {
  it.each([
    '/account',
    '/en/account',
    '/uk/account/login',
    '/ACCOUNT/orders',
    '/%61ccount',
    '//account//login/',
    '/en/%41CCOUNT/set-password',
    '/%zzaccount',
    '/unsubscribe',
    '/en/UNSUBSCRIBE/',
  ])('%s is the account', (path) => {
    expect(isAccountPath(path)).toBe(true);
  });

  it.each(['/', '/category/account', '/accounts', '/en/product/my-account', '/search'])(
    '%s is not',
    (path) => {
      expect(isAccountPath(path)).toBe(false);
    },
  );

  it('knows the credential pages in both languages and every spelling', () => {
    for (const path of [
      '/account/login',
      '/en/account/register',
      '/%61ccount/forgot/',
      '/uk/account/set-password',
    ]) {
      expect(isAccountAuthPath(path), path).toBe(true);
    }
    for (const path of ['/account', '/account/orders', '/category/bras']) {
      expect(isAccountAuthPath(path), path).toBe(false);
    }
  });
});

describe('isUnsubscribePath', () => {
  it('is the mail link in either language, and NOT a credential page (it must not share their bucket)', () => {
    for (const path of ['/unsubscribe', '/en/unsubscribe', '/%75nsubscribe/', '/UNSUBSCRIBE/x']) {
      expect(isUnsubscribePath(path), path).toBe(true);
      expect(isAccountAuthPath(path), path).toBe(false);
    }
    expect(isUnsubscribePath('/account/login')).toBe(false);
  });
});
