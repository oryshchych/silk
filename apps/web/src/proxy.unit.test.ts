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
    vi.stubEnv('MEDIA_PUBLIC_BASE_URL', 'https://media.shop.example');
  }
  return (await import('./proxy')).proxy;
}

const lookup = vi.hoisted(() =>
  vi.fn<(path: string) => Promise<{ to: string; status: 301 | 302 | 410 } | null>>(() =>
    Promise.resolve(null),
  ),
);
const noteHit = vi.hoisted(() => vi.fn<(path: string) => void>());
vi.mock('./lib/redirect-map', () => ({
  redirectMap: { lookup, invalidate: () => undefined, noteHit },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  lookup.mockReset();
  lookup.mockResolvedValue(null);
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

  it('does not touch other pages', async () => {
    const proxy = await loadProxy('local');
    has.mockReset();
    await proxy(new NextRequest('http://localhost:3000/category/bras'));
    expect(has).not.toHaveBeenCalled();
  });

  it('gates every method but OPTIONS: a POST to an unknown slug cannot fill the page cache', async () => {
    const proxy = await loadProxy('local');
    has.mockImplementation(async (slug) => await Promise.resolve(slug === 'aurora-1'));
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const unknown = await proxy(
        new NextRequest('http://localhost:3000/product/nope-1', { method }),
      );
      expect(rewriteOf(unknown), method).toBe('http://localhost:3000/uk/__missing__/product');
      expect(unknown.headers.get('cache-control'), method).toBe('no-store');
      // A server action posts to the page of a KNOWN product and must get through.
      const known = await proxy(
        new NextRequest('http://localhost:3000/product/aurora-1', { method }),
      );
      expect(rewriteOf(known), method).toBeNull();
    }
    has.mockReset();
    await proxy(new NextRequest('http://localhost:3000/product/nope-1', { method: 'OPTIONS' }));
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

describe('proxy: redirects and gone pages', () => {
  const asGone = { to: '/', status: 410 as const };

  it('answers 410 for a gone path, before the product gate, for GET and HEAD, and counts the hit', async () => {
    const proxy = await loadProxy('production');
    has.mockReset();
    lookup.mockResolvedValue(asGone);
    noteHit.mockClear();
    for (const method of ['GET', 'HEAD']) {
      const response = await proxy(
        new NextRequest('https://shop.example/product/discontinued-1', { method }),
      );
      expect(response.status, method).toBe(410);
      expect(response.headers.get('cache-control'), method).toBe('public, max-age=300');
      expect(response.headers.get('x-robots-tag'), method).toBeNull();
    }
    expect(noteHit).toHaveBeenCalledTimes(2);
    expect(has).not.toHaveBeenCalled();
  });

  it('marks a 410 noindex outside production and does not apply it to a POST', async () => {
    const proxy = await loadProxy('local');
    lookup.mockResolvedValue(asGone);
    const get = await proxy(new NextRequest('http://localhost:3000/product/discontinued-1'));
    expect(get.status).toBe(410);
    expect(get.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    has.mockResolvedValue(false);
    const post = await proxy(
      new NextRequest('http://localhost:3000/product/discontinued-1', { method: 'POST' }),
    );
    expect(post.status).not.toBe(410);
  });

  it('serves a 301 with a short public cache and counts it; a redirect to a hidden product is not served', async () => {
    const proxy = await loadProxy('production');
    noteHit.mockClear();
    lookup.mockResolvedValue({ to: '/product/new-1', status: 301 });
    has.mockResolvedValue(true);
    const moved = await proxy(new NextRequest('https://shop.example/product/old-1'));
    expect(moved.status).toBe(301);
    expect(moved.headers.get('location')).toBe('https://shop.example/product/new-1');
    expect(moved.headers.get('cache-control')).toBe('public, max-age=300');
    expect(noteHit).toHaveBeenCalledTimes(1);

    noteHit.mockClear();
    has.mockImplementation(async (slug) => await Promise.resolve(slug !== 'new-1'));
    const hidden = await proxy(new NextRequest('https://shop.example/product/old-1'));
    expect(hidden.status).not.toBe(301);
    expect(noteHit).not.toHaveBeenCalled();
  });

  it('checks 410 before the target-visibility rule (a 410 row never consults the slug set)', async () => {
    const proxy = await loadProxy('production');
    has.mockReset();
    lookup.mockResolvedValue({ to: '/product/whatever-1', status: 410 });
    const response = await proxy(new NextRequest('https://shop.example/product/x-1'));
    expect(response.status).toBe(410);
    expect(has).not.toHaveBeenCalled();
  });
});

describe('proxy: customer account limits and headers', () => {
  const account = (path: string, method = 'GET', ip = '203.0.113.50') =>
    new NextRequest(`http://localhost:3000${path}`, {
      method,
      headers: { 'x-forwarded-for': ip },
    });

  it('stamps no-store, noindex and no-referrer on every account answer, in either language', async () => {
    const proxy = await loadProxy('local');
    for (const path of ['/account', '/en/account/login', '/account/set-password?t=x']) {
      const response = await proxy(account(path));
      expect(response.headers.get('cache-control'), path).toBe('private, no-store');
      expect(response.headers.get('x-robots-tag'), path).toBe('noindex, nofollow');
      expect(response.headers.get('referrer-policy'), path).toBe('no-referrer');
    }
    // A page of the storefront is not an account page.
    expect((await proxy(account('/category/bras'))).headers.get('referrer-policy')).toBeNull();
  });

  it('sends the account root without a session cookie to the sign-in page (307), in either language', async () => {
    const proxy = await loadProxy('local');
    for (const [from, to] of [
      ['/account', '/account/login'],
      ['/en/account', '/en/account/login'],
      ['/en/account/', '/en/account/login'],
    ] as const) {
      const response = await proxy(account(from));
      expect(response.status, from).toBe(307);
      expect(new URL(response.headers.get('location') ?? '').pathname, from).toBe(to);
    }
    // With a cookie the page decides (the cookie proves nothing here), and POST is never redirected.
    const withCookie = new NextRequest('http://localhost:3000/account', {
      headers: { cookie: 'customer_session=x', 'x-forwarded-for': '203.0.113.60' },
    });
    expect((await proxy(withCookie)).status).not.toBe(307);
    expect((await proxy(account('/account', 'POST', '203.0.113.61'))).status).not.toBe(307);
  });

  it('in production the session cookie is the __Host- one: the plain name does not count', async () => {
    const proxy = await loadProxy('production');
    const withName = (name: string) =>
      new NextRequest('https://shop.example/account', {
        headers: { cookie: `${name}=x`, 'x-forwarded-for': '203.0.113.70' },
      });
    expect((await proxy(withName('customer_session'))).status).toBe(307);
    expect((await proxy(withName('__Host-customer_session'))).status).not.toBe(307);
  });

  it('limits the credential pages to 30 a minute per client, every method but OPTIONS, every spelling', async () => {
    const proxy = await loadProxy('local');
    const spellings = [
      '/account/login',
      '/en/account/login',
      '/%61ccount/login',
      '/ACCOUNT//login/',
    ];
    for (let i = 0; i < 30; i++) {
      const path = spellings[i % spellings.length] ?? '/account/login';
      expect((await proxy(account(path, i % 2 === 0 ? 'GET' : 'POST'))).status).not.toBe(429);
    }
    const blocked = await proxy(account('/account/forgot', 'PUT'));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('cache-control')).toBe('private, no-store');
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // OPTIONS is never counted; another client and the storefront are unaffected.
    expect((await proxy(account('/account/login', 'OPTIONS'))).status).not.toBe(429);
    expect((await proxy(account('/account/login', 'GET', '198.51.100.9'))).status).not.toBe(429);
    expect((await proxy(account('/category/bras'))).status).not.toBe(429);
  });

  it('caps the attempts of ALL clients on the credential pages (600 a minute)', async () => {
    const proxy = await loadProxy('local');
    let blocked = 0;
    for (let i = 0; i < 700; i++) {
      const ip = `10.${String(Math.floor(i / 250))}.${String(i % 250)}.1, 192.0.2.${String(i % 250)}`;
      const response = await proxy(account('/account/register', 'POST', ip));
      if (response.status === 429) blocked += 1;
    }
    expect(blocked).toBeGreaterThanOrEqual(90);
  });
});

describe('proxy: the unsubscribe link has its own limits', () => {
  const unsub = (ip: string, method = 'POST') =>
    new NextRequest('http://localhost:3000/unsubscribe?t=x', {
      method,
      headers: { 'x-forwarded-for': ip },
    });
  it("a flood of unsubscribe requests from many clients does not use up the credential forms' cap", async () => {
    const proxy = await loadProxy('local');
    for (let i = 0; i < 700; i++) {
      await proxy(
        unsub(`10.${String(Math.floor(i / 250))}.${String(i % 250)}.1, 192.0.2.${String(i % 250)}`),
      );
    }
    const login = await proxy(
      new NextRequest('http://localhost:3000/account/login', {
        method: 'POST',
        headers: { 'x-forwarded-for': '198.51.100.77' },
      }),
    );
    expect(login.status).not.toBe(429);
  });

  it('limits one client to 30 a minute, with the account headers', async () => {
    const proxy = await loadProxy('local');
    for (let i = 0; i < 30; i++) expect((await proxy(unsub('203.0.113.99'))).status).not.toBe(429);
    const blocked = await proxy(unsub('203.0.113.99'));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('cache-control')).toBe('private, no-store');
  });
});
