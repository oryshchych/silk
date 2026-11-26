/**
 * The customer session cookie: `HttpOnly` (no script reads it), `SameSite=Lax` (a link in a mail
 * must open the account signed in; every mutation also checks `Origin`), `Secure` outside a local
 * http server. Nothing is kept in `localStorage`. No storefront page reads it, so the public pages
 * stay one cached copy for everyone (ADR-8, ADR-21).
 */
export const CUSTOMER_COOKIE = 'customer_session';

export function customerCookieOptions(expires: Date, secure: boolean) {
  return { httpOnly: true, secure, sameSite: 'lax', path: '/', expires } as const;
}
