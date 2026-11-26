/**
 * Whether a request path belongs to the customer account, however it is spelled (percent-encoded,
 * doubled slashes, any case, with or without a language prefix). Deliberately broader than the
 * routes that exist: a path that merely LOOKS like the account gets its headers and limits.
 */
function normalise(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const path = decoded
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  return path.replace(/^\/(uk|en)(?=\/|$)/, '');
}

export function isAccountPath(pathname: string): boolean {
  const path = normalise(pathname);
  // An undecodable path is treated as account: the safe side.
  if (path === null) return pathname.toLowerCase().includes('account');
  return path === '/account' || path.startsWith('/account/');
}

/** The pages that take a credential or send a mail: limited hard, open without a session. */
const AUTH_PATHS = [
  '/account/login',
  '/account/register',
  '/account/forgot',
  '/account/set-password',
] as const;

export function isAccountAuthPath(pathname: string): boolean {
  const path = normalise(pathname);
  return path !== null && (AUTH_PATHS as readonly string[]).includes(path);
}
