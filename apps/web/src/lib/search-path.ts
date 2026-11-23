/**
 * Whether a request path is the search page, however it is spelled: with or
 * without a locale prefix, percent-encoded (`/%73earch`), with a trailing
 * slash. The check is on the decoded, normalised route, not on one string, so
 * an encoding cannot step around the rate limit.
 */
export function isSearchPath(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const path = decoded.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return path === '/search' || path === '/en/search' || path === '/uk/search';
}
