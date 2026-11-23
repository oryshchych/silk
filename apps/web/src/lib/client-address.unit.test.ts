import { describe, expect, it } from 'vitest';

import { clientAddress, UNKNOWN_CLIENT } from './client-address';

describe('clientAddress', () => {
  it('takes the entry the trusted proxy appended: the last one for a single hop', () => {
    expect(clientAddress('203.0.113.7', 1)).toBe('203.0.113.7');
    expect(clientAddress('9.9.9.9, 203.0.113.7', 1)).toBe('203.0.113.7');
  });

  it('counts hops from the right: Cloudflare then Traefik is two', () => {
    // client (added by Cloudflare), Cloudflare edge (added by Traefik)
    expect(clientAddress('203.0.113.7, 172.70.1.1', 2)).toBe('203.0.113.7');
    expect(clientAddress('5.5.5.5, 203.0.113.7, 172.70.1.1', 2)).toBe('203.0.113.7');
  });

  it('ignores whatever the client put on the left (spoofing and rotating entries do not change the key)', () => {
    const keys = new Set(
      Array.from({ length: 50 }, (_, i) => clientAddress(`9.9.9.${String(i)}, 203.0.113.7`, 1)),
    );
    expect([...keys]).toEqual(['203.0.113.7']);
  });

  it("does not let a client choose another client's key", () => {
    // The attacker prefixes the victim\'s address; the key is still the attacker\'s own.
    expect(clientAddress('198.51.100.9, 192.0.2.50', 1)).toBe('192.0.2.50');
    expect(clientAddress('192.0.2.50', 1)).toBe('192.0.2.50');
  });

  it('shares one bucket when there is no trustworthy address', () => {
    expect(clientAddress(null, 1)).toBe(UNKNOWN_CLIENT);
    expect(clientAddress('', 1)).toBe(UNKNOWN_CLIENT);
    expect(clientAddress('203.0.113.7', 2)).toBe(UNKNOWN_CLIENT);
    expect(clientAddress('203.0.113.7', 0)).toBe(UNKNOWN_CLIENT);
    expect(clientAddress('not-an-ip', 1)).toBe(UNKNOWN_CLIENT);
    expect(clientAddress('a'.repeat(16_000), 1)).toBe(UNKNOWN_CLIENT);
  });

  it('keys an IPv6 client by its /64 network, so rotating the lower bits mints no new keys', () => {
    const keys = new Set([
      clientAddress('2001:db8:1:2::1', 1),
      clientAddress('2001:db8:1:2:ffff:ffff:ffff:ffff', 1),
      clientAddress('2001:DB8:1:2:abcd:ef01:2345:6789', 1),
      clientAddress('2001:db8:0001:0002:0:0:0:5', 1),
    ]);
    expect([...keys]).toEqual(['2001:db8:1:2::/64']);
  });

  it('gives different /64 networks different keys', () => {
    expect(clientAddress('2001:db8:1:2::1', 1)).not.toBe(clientAddress('2001:db8:1:3::1', 1));
    expect(clientAddress('2001:db8:1:2::1', 1)).not.toBe(clientAddress('2001:db9:1:2::1', 1));
  });

  it('maps an IPv4-mapped IPv6 address to the IPv4 key, removing the alias', () => {
    expect(clientAddress('::ffff:203.0.113.7', 1)).toBe('203.0.113.7');
    expect(clientAddress('::ffff:cb00:7107', 1)).toBe('203.0.113.7');
    expect(clientAddress('0:0:0:0:0:ffff:203.0.113.7', 1)).toBe('203.0.113.7');
    expect(clientAddress('::FFFF:203.0.113.7', 1)).toBe(clientAddress('203.0.113.7', 1));
  });

  it('handles :: at the start, the end and the middle, and ignores a zone id', () => {
    expect(clientAddress('::1', 1)).toBe('0:0:0:0::/64');
    expect(clientAddress('fe80::', 1)).toBe('fe80:0:0:0::/64');
    expect(clientAddress('2001:db8::1:0:0:1', 1)).toBe('2001:db8:0:0::/64');
    expect(clientAddress('fe80::1%eth0', 1)).toBe('fe80:0:0:0::/64');
  });

  it('rejects an IPv4 entry with a zone id instead of keeping the suffix in the key', () => {
    expect(clientAddress('1.2.3.4%eth0', 1)).toBe(UNKNOWN_CLIENT);
    expect(clientAddress('1.2.3.4%', 1)).toBe(UNKNOWN_CLIENT);
    expect(clientAddress('9.9.9.9, 1.2.3.4%x', 1)).toBe(UNKNOWN_CLIENT);
    // The same address without the suffix is a normal key.
    expect(clientAddress('1.2.3.4', 1)).toBe('1.2.3.4');
  });

  it('shares one bucket per loopback or link-local /64, as documented', () => {
    expect(clientAddress('::1', 1)).toBe(clientAddress('::2', 1));
    expect(clientAddress('fe80::1', 1)).toBe(clientAddress('fe80::abcd', 1));
    expect(clientAddress('fe80::1', 1)).not.toBe(clientAddress('::1', 1));
  });

  it('keeps every key short', () => {
    expect(clientAddress('1.1.1.1, 2001:db8:1:2:3:4:5:6', 1).length).toBeLessThanOrEqual(30);
  });
});
