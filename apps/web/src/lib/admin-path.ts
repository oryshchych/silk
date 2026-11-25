/**
 * Whether a request path belongs to the admin, however it is spelled: percent-encoded
 * (`/%61dmin`), with doubled or trailing slashes, in any case. Deliberately broader than the
 * routes that exist: a path that merely LOOKS like the admin gets the admin's headers and limits
 * (never the other way round), so no spelling steps around them.
 */
function normalise(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  return decoded
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function isAdminPath(pathname: string): boolean {
  const path = normalise(pathname);
  // An undecodable path is treated as admin: the safe side.
  if (path === null) return pathname.toLowerCase().includes('admin');
  return path === '/admin' || path.startsWith('/admin/');
}

/** The pages that take credentials: limited hard, and open without a session. */
const ADMIN_AUTH_PATHS = ['/admin/login', '/admin/verify', '/admin/enroll'] as const;

export function isAdminAuthPath(pathname: string): boolean {
  const path = normalise(pathname);
  return path !== null && (ADMIN_AUTH_PATHS as readonly string[]).includes(path);
}
