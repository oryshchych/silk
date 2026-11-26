import { describe, expect, it } from 'vitest';

import { customerCookieName, customerCookieOptions } from './cookies';

describe('customer cookie', () => {
  it('carries the __Host- prefix exactly when it is Secure (the browser then pins Path=/ and no Domain)', () => {
    expect(customerCookieName(true)).toBe('__Host-customer_session');
    expect(customerCookieName(false)).toBe('customer_session');
    const secure = customerCookieOptions(new Date(0), true);
    expect(secure).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    expect(secure).not.toHaveProperty('domain');
  });
});
