/**
 * `/uk/...` duplicates `/...` (uk is the unprefixed default locale). next-intl
 * answers it with a temporary 307; search engines need a permanent redirect
 * so the prefixed URLs consolidate onto the canonical ones (RR6).
 *
 * Returns the unprefixed path, or null when the path is not under `/uk`.
 */
export function stripDefaultLocalePrefix(pathname: string): string | null {
  if (pathname === '/uk') return '/';
  if (pathname.startsWith('/uk/')) return pathname.slice('/uk'.length);
  return null;
}
