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

  it('accepts IPv6 and keeps the key short', () => {
    expect(clientAddress('2001:DB8::1', 1)).toBe('2001:db8::1');
    expect(clientAddress('1.1.1.1, 2001:db8::ffff:1', 1).length).toBeLessThanOrEqual(45);
  });
});
