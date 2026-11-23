import { isIP } from 'node:net';

/** Shared bucket for requests whose client address cannot be established. */
export const UNKNOWN_CLIENT = 'unknown';

/**
 * The client address from `X-Forwarded-For`, trusting exactly `hops` reverse
 * proxies. Each trusted proxy APPENDS the address it saw, so the client is the
 * entry `hops` places from the RIGHT; everything to its left is supplied by
 * whoever made the request and means nothing (a client can send any list).
 * Traefik alone is 1; Cloudflare then Traefik is 2.
 *
 * Returns `UNKNOWN_CLIENT` when there is no trustworthy address: no header,
 * fewer entries than hops, hops of 0, or an entry that is not an IP address.
 * Those requests share one bucket instead of getting a key a client chose.
 * The key is always a valid IP, so its length is bounded.
 */
export function clientAddress(forwardedFor: string | null, hops: number): string {
  if (forwardedFor === null || hops < 1) return UNKNOWN_CLIENT;
  const entries = forwardedFor.split(',').map((entry) => entry.trim());
  const entry = entries[entries.length - hops];
  return entry !== undefined && isIP(entry) !== 0 ? entry.toLowerCase() : UNKNOWN_CLIENT;
}
