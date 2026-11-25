/**
 * CSRF check for admin actions, on top of Next's own Origin/Host comparison and the
 * `SameSite=Strict` cookie: the request must carry an `Origin` whose host is the site's host.
 * A request with no Origin (a script, a stripped header) is refused: the browser always sends one
 * on a cross-site or same-site POST.
 */
export function isSameOrigin(
  origin: string | null,
  expectedHost: string | null | undefined,
): boolean {
  if (
    origin === null ||
    expectedHost === null ||
    expectedHost === undefined ||
    expectedHost === ''
  ) {
    return false;
  }
  try {
    return new URL(origin).host.toLowerCase() === expectedHost.toLowerCase();
  } catch {
    return false;
  }
}
