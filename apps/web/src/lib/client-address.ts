import { isIP } from 'node:net';

/** Shared bucket for requests whose client address cannot be established. */
export const UNKNOWN_CLIENT = 'unknown';

/** Eight 16-bit groups of an IPv6 address, or null if it cannot be read. */
function ipv6Groups(address: string): number[] | null {
  let text = address.split('%')[0] ?? '';
  // A trailing dotted IPv4 (::ffff:203.0.113.7) is two more groups.
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted !== null) {
    const [, head = '', a = '0', b = '0', c = '0', d = '0'] = dotted;
    const high = (Number(a) << 8) | Number(b);
    const low = (Number(c) << 8) | Number(d);
    text = `${head}${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string | undefined): number[] =>
    part === undefined || part === ''
      ? []
      : part.split(':').map((group) => Number.parseInt(group, 16));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = [
    ...head,
    ...Array.from({ length: halves.length === 2 ? fill : 0 }, () => 0),
    ...tail,
  ];
  return groups.length === 8 &&
    groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : null;
}

/**
 * One key per client network. An IPv4 address is its own key. An IPv6 address
 * is reduced to its /64 prefix: a household or a host gets a whole /64, so
 * rotating the lower 64 bits would otherwise mint unlimited keys. An
 * IPv4-mapped IPv6 address (`::ffff:203.0.113.7`) is the same client as the
 * IPv4 address and shares its key. Loopback (`::1`) and link-local (`fe80::/64`)
 * clients each fall into their own /64 bucket, shared by everything on it: a
 * proxy-less or misconfigured deployment sees all its clients as one.
 */
function networkKey(address: string): string | null {
  const bare = address.split('%')[0] ?? '';
  const version = isIP(bare);
  // A zone id (`%eth0`) only exists on IPv6; on an IPv4 entry it is not an address at all.
  if (version === 4) return bare === address ? bare : null;
  if (version !== 6) return null;
  const groups = ipv6Groups(bare);
  if (groups === null) return null;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `${String(g6 >> 8)}.${String(g6 & 255)}.${String(g7 >> 8)}.${String(g7 & 255)}`;
  }
  return `${[g0, g1, g2, g3].map((group) => group.toString(16)).join(':')}::/64`;
}

/**
 * The client network from `X-Forwarded-For`, trusting exactly `hops` reverse
 * proxies. Each trusted proxy APPENDS the address it saw, so the client is the
 * entry `hops` places from the RIGHT; everything to its left is supplied by
 * whoever made the request and means nothing (a client can send any list).
 * Traefik alone is 1; Cloudflare then Traefik is 2.
 *
 * Returns `UNKNOWN_CLIENT` when there is no trustworthy address: no header,
 * fewer entries than hops, hops of 0, or an entry that is not an IP address.
 * Those requests share one bucket instead of getting a key a client chose.
 * The key is derived from a valid address (IPv6 by its /64), so its length is
 * bounded.
 */
export function clientAddress(forwardedFor: string | null, hops: number): string {
  if (forwardedFor === null || hops < 1) return UNKNOWN_CLIENT;
  const entries = forwardedFor.split(',').map((entry) => entry.trim());
  const entry = entries[entries.length - hops];
  return (entry === undefined ? null : networkKey(entry)) ?? UNKNOWN_CLIENT;
}
