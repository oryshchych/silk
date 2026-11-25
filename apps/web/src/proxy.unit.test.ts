import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// next-intl's middleware ships ESM that Node cannot resolve outside Next; the
// redirect under test runs before it, so a pass-through stub is enough.
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return { default: () => () => NextResponse.next() };
});

// The visible-slug set comes from the database; here it is controlled by the test.
const has = vi.hoisted(() => vi.fn<(slug: string) => Promise<boolean | null>>());
vi.mock('./lib/product-slugs', () => ({ knownProductSlugs: { has } }));

async function loadProxy(appEnv: 'local' | 'production') {
  vi.resetModules();
  vi.stubEnv('APP_ENV', appEnv);
  vi.stubEnv('DATABASE_URL', 'postgres://u:p@localhost:5432/d');
  vi.stubEnv('EMAIL_TO_OVERRIDE', 'dev@example.com');
  if (appEnv === 'production') {
    for (const key of [
      'AUTH_SECRET',
      'MONO_PLATA_TOKEN',
      'WAYFORPAY_MERCHANT_ACCOUNT',
      'WAYFORPAY_SECRET_KEY',
      'NOVA_POSHTA_API_KEY',
      'RESEND_API_KEY',
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET_MEDIA',
    ]) {
      vi.stubEnv(key, 'x'.repeat(32));
    }
    vi.stubEnv('SITE_URL', 'https://shop.example');
  }
  return (await import('./proxy')).proxy;
}

vi.mock('./lib/redirect-map', () => ({
  redirectMap: { lookup: () => Promise.resolve(null), invalidate: () => undefined },
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('proxy: /uk redirect', () => {
  it('answers 308 to the unprefixed URL and keeps the query string', async () => {
    const proxy = await loadProxy('local');
    const response = await proxy(new NextRequest('http://localhost:3000/uk/category/bras?a=1&b=2'));
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('http://localhost:3000/category/bras?a=1&b=2');
  });

  it('marks the redirect noindex outside production only', async () => {
    const local = await loadProxy('local');
    expect(
      (await local(new NextRequest('http://localhost:3000/uk'))).headers.get('x-robots-tag'),
    ).toBe('noindex, nofollow');
    const production = await loadProxy('production');
    expect(
      (await production(new NextRequest('https://shop.example/uk'))).headers.get('x-robots-tag'),
    ).toBe(null);
  });
});

describe('proxy: product URL gate', () => {
  const rewriteOf = (response: Response): string | null =>
    response.headers.get('x-middleware-rewrite');

  it('lets a known product through and rewrites an unknown well-formed slug to the 404 page', async () => {
    const proxy = await loadProxy('local');
    has.mockImplementation(async (slug) => await Promise.resolve(slug === 'aurora-1'));

    const known = await proxy(new NextRequest('http://localhost:3000/product/aurora-1'));
    expect(rewriteOf(known)).toBeNull();

    const unknown = await proxy(new NextRequest('http://localhost:3000/product/nope-1'));
    expect(rewriteOf(unknown)).toBe('http://localhost:3000/uk/__missing__/product');
    expect(unknown.headers.get('cache-control')).toBe('no-store');

    const english = await proxy(new NextRequest('http://localhost:3000/en/product/nope-1?x=1'));
    expect(rewriteOf(english)).toBe('http://localhost:3000/en/__missing__/product');
  });

  it('rejects a malformed slug without asking the database', async () => {
    const proxy = await loadProxy('local');
    has.mockReset();
    for (const path of [
      '/product/x%00abc',
      '/product/Aurora',
      `/product/${'a'.repeat(201)}`,
      '/en/product/a--b',
    ]) {
      const response = await proxy(new NextRequest(`http://localhost:3000${path}`));
      expect(rewriteOf(response)).toMatch(/__missing__\/product$/);
    }
    expect(has).not.toHaveBeenCalled();
  });

  it('lets the request through when the slug set cannot be loaded at all', async () => {
    const proxy = await loadProxy('local');
    has.mockResolvedValue(null);
    const response = await proxy(new NextRequest('http://localhost:3000/product/anything-1'));
    expect(rewriteOf(response)).toBeNull();
  });

  it('does not touch other pages or methods other than GET and HEAD', async () => {
    const proxy = await loadProxy('local');
    has.mockReset();
    await proxy(new NextRequest('http://localhost:3000/category/bras'));
    await proxy(new NextRequest('http://localhost:3000/product/nope-1', { method: 'POST' }));
    expect(has).not.toHaveBeenCalled();
  });
});

describe('proxy: search rate limit', () => {
  const search = (forwardedFor: string | null, options: { path?: string; method?: string } = {}) =>
    new NextRequest(`http://localhost:3000${options.path ?? '/search'}?q=bra`, {
      method: options.method ?? 'GET',
      headers: forwardedFor === null ? {} : { 'x-forwarded-for': forwardedFor },
    });

  /** Sends `count` searches and returns how many were answered 429. */
  async function blockedOf(
    proxy: Awaited<ReturnType<typeof loadProxy>>,
    count: number,
    make: (i: number) => NextRequest,
  ): Promise<number> {
    let blocked = 0;
    for (let i = 0; i < count; i++) if ((await proxy(make(i))).status === 429) blocked += 1;
    return blocked;
  }

  it('answers 429 with Retry-After and no-store after 30 searches a minute from one address', async () => {
    const proxy = await loadProxy('local');
    for (let i = 0; i < 30; i++) expect((await proxy(search('203.0.113.7'))).status).not.toBe(429);
    const blocked = await proxy(search('203.0.113.7', { path: '/en/search' }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(blocked.headers.get('cache-control')).toBe('no-store');
    expect(blocked.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('does not limit another address or other pages', async () => {
    const proxy = await loadProxy('local');
    await blockedOf(proxy, 31, () => search('203.0.113.7'));
    expect((await proxy(search('198.51.100.9'))).status).not.toBe(429);
    const others = await blockedOf(
      proxy,
      40,
      () =>
        new NextRequest('http://localhost:3000/category/bras', {
          headers: { 'x-forwarded-for': '203.0.113.7' },
        }),
    );
    expect(others).toBe(0);
  });

  it('cannot be escaped by rotating X-Forwarded-For entries the client controls', async () => {
    const proxy = await loadProxy('local');
    // The trusted proxy appends the real address (203.0.113.7); the client rotates what it sends before it.
    const blocked = await blockedOf(proxy, 100, (i) => search(`9.9.9.${String(i)}, 203.0.113.7`));
    expect(blocked).toBe(70);
  });

  it("cannot be used to burn another client's bucket", async () => {
    const proxy = await loadProxy('local');
    // The attacker claims to be the victim; the key is the address the proxy appended.
    await blockedOf(proxy, 40, () => search('5.5.5.5, 192.0.2.50'));
    expect((await proxy(search('5.5.5.5, 10.0.0.1'))).status).not.toBe(429);
    expect((await proxy(search('5.5.5.5'))).status).not.toBe(429);
  });

  it('limits HEAD and POST and every spelling of the path, but not OPTIONS', async () => {
    const proxy = await loadProxy('local');
    await blockedOf(proxy, 30, () => search('203.0.113.7'));
    for (const request of [
      search('203.0.113.7', { method: 'HEAD' }),
      search('203.0.113.7', { method: 'POST' }),
      search('203.0.113.7', { path: '/%73earch' }),
      search('203.0.113.7', { path: '/%65n/search' }),
      search('203.0.113.7', { path: '/en/%73earch' }),
      search('203.0.113.7', { path: '/search/' }),
    ]) {
      expect((await proxy(request)).status).toBe(429);
    }
    expect((await proxy(search('203.0.113.7', { method: 'OPTIONS' }))).status).not.toBe(429);
  });

  it('puts requests without a trustworthy address in one shared bucket', async () => {
    const proxy = await loadProxy('local');
    expect(await blockedOf(proxy, 35, () => search(null))).toBe(5);
    // A request that does have an address is not caught by the shared bucket.
    expect((await proxy(search('203.0.113.7'))).status).not.toBe(429);
    // A header that is not an address is treated as missing, not as a key chosen by the client.
    expect((await proxy(search('not-an-ip'))).status).toBe(429);
  });

  it('keys an IPv6 client by its /64: rotating the lower bits does not mint new keys', async () => {
    const proxy = await loadProxy('local');
    const blocked = await blockedOf(proxy, 40, (i) => search(`2001:db8:1:2::${i.toString(16)}`));
    expect(blocked).toBe(10);
    // Another /64 is another client.
    expect((await proxy(search('2001:db8:1:3::1'))).status).not.toBe(429);
  });

  it('treats an IPv4-mapped IPv6 address as the same client as the IPv4 address', async () => {
    const proxy = await loadProxy('local');
    await blockedOf(proxy, 30, () => search('203.0.113.7'));
    expect((await proxy(search('::ffff:203.0.113.7'))).status).toBe(429);
    expect((await proxy(search('::ffff:cb00:7107'))).status).toBe(429);
  });

  it('caps all searches together, so many networks cannot sum to unlimited database work', async () => {
    const proxy = await loadProxy('local');
    // 20 clients x 30 searches = 600: all allowed, each within its own limit.
    for (let client = 0; client < 20; client++) {
      expect(await blockedOf(proxy, 30, () => search(`10.0.0.${String(client)}`))).toBe(0);
    }
    // The shared cap is spent: a client that never searched before is refused too.
    const refused = await proxy(search('10.0.1.1'));
    expect(refused.status).toBe(429);
    expect(refused.headers.get('cache-control')).toBe('no-store');
    // A client already over its own limit does not consume the shared cap further.
    expect((await proxy(new NextRequest('http://localhost:3000/category/bras'))).status).not.toBe(
      429,
    );
  });

  it('does not count a request its own client limit refused toward the global cap', async () => {
    const proxy = await loadProxy('local');
    // One client far over its own limit: 30 allowed, 500 refused. Only the 30 may use the shared cap.
    expect(await blockedOf(proxy, 530, () => search('192.0.2.50'))).toBe(500);
    // 19 other clients x 30 = 570; with the 30 above that is exactly the 600 of the cap.
    for (let client = 0; client < 19; client++) {
      expect(await blockedOf(proxy, 30, () => search(`10.0.0.${String(client)}`))).toBe(0);
    }
    // The cap is now spent, so the next new client is refused.
    expect((await proxy(search('10.0.1.1'))).status).toBe(429);
  });

  it('counts hops from the right as configured (Cloudflare then Traefik is two)', async () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '2');
    const proxy = await loadProxy('local');
    // client, Cloudflare edge: the key is the client, whatever the edge address is.
    const blocked = await blockedOf(proxy, 35, (i) => search(`203.0.113.7, 172.70.1.${String(i)}`));
    expect(blocked).toBe(5);
  });
});
