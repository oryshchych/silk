import { describe, expect, it } from 'vitest';

import { isAdminAuthPath, isAdminPath } from './admin-path';

describe('isAdminPath: every spelling of the admin counts', () => {
  it('matches the plain, encoded, cased and slashed spellings', () => {
    for (const path of [
      '/admin',
      '/admin/',
      '/admin/login',
      '/ADMIN/login',
      '/%61dmin/login',
      '/admin//login',
      '//admin',
      '/admin/products/1/edit',
    ]) {
      expect(isAdminPath(path), path).toBe(true);
    }
  });

  it('leaves the storefront alone, and treats an undecodable path that mentions admin as admin', () => {
    for (const path of ['/', '/search', '/administrator-shoes', '/product/admin-bra', '/en/cart']) {
      expect(isAdminPath(path), path).toBe(false);
    }
    expect(isAdminPath('/%E0%A4%A/admin')).toBe(true);
  });
});

describe('isAdminAuthPath', () => {
  it('matches the credential pages in any spelling and not the rest of the admin', () => {
    for (const path of ['/admin/login', '/admin/login/', '/%61dmin/verify', '/ADMIN/enroll']) {
      expect(isAdminAuthPath(path), path).toBe(true);
    }
    for (const path of ['/admin', '/admin/products', '/login']) {
      expect(isAdminAuthPath(path), path).toBe(false);
    }
  });
});
