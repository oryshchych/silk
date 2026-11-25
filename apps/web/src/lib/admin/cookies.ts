/**
 * The session cookie. `HttpOnly` (no script reads it), `SameSite=Strict`, `Secure` everywhere
 * except a local http server, and `Path=/admin`: the browser never sends it to the storefront, so
 * a public page can neither read nor vary on it (ADR-21).
 */
export const SESSION_COOKIE = 'admin_session';
const ADMIN_PATH = '/admin';

export function sessionCookieOptions(expires: Date, secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: ADMIN_PATH,
    expires,
  } as const;
}

export function preferenceCookieOptions(secure: boolean) {
  return {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: ADMIN_PATH,
    maxAge: 60 * 60 * 24 * 365,
  } as const;
}
