import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// next-intl's middleware ships ESM that Node cannot resolve outside Next; the
// redirect under test runs before it, so a pass-through stub is enough.
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return { default: () => () => NextResponse.next() };
});

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
      vi.stubEnv(key, 'x');
    }
    vi.stubEnv('SITE_URL', 'https://shop.example');
  }
  return (await import('./proxy')).proxy;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('proxy: /uk redirect', () => {
  it('answers 308 to the unprefixed URL and keeps the query string', async () => {
    const proxy = await loadProxy('local');
    const response = proxy(new NextRequest('http://localhost:3000/uk/category/bras?a=1&b=2'));
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('http://localhost:3000/category/bras?a=1&b=2');
  });

  it('marks the redirect noindex outside production only', async () => {
    const local = await loadProxy('local');
    expect(local(new NextRequest('http://localhost:3000/uk')).headers.get('x-robots-tag')).toBe(
      'noindex, nofollow',
    );
    const production = await loadProxy('production');
    expect(production(new NextRequest('https://shop.example/uk')).headers.get('x-robots-tag')).toBe(
      null,
    );
  });
});

describe('proxy: search rate limit', () => {
  const search = (forwardedFor: string | null, options: { path?: string; method?: string } = {}) =>
    new NextRequest(`http://localhost:3000${options.path ?? '/search'}?q=bra`, {
      method: options.method ?? 'GET',
      headers: forwardedFor === null ? {} : { 'x-forwarded-for': forwardedFor },
    });

  /** Sends `count` searches and returns how many were answered 429. */
  function blockedOf(
    proxy: Awaited<ReturnType<typeof loadProxy>>,
    count: number,
    make: (i: number) => NextRequest,
  ): number {
    let blocked = 0;
    for (let i = 0; i < count; i++) if (proxy(make(i)).status === 429) blocked += 1;
    return blocked;
  }

  it('answers 429 with Retry-After and no-store after 30 searches a minute from one address', async () => {
    const proxy = await loadProxy('local');
    for (let i = 0; i < 30; i++) expect(proxy(search('203.0.113.7')).status).not.toBe(429);
    const blocked = proxy(search('203.0.113.7', { path: '/en/search' }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(blocked.headers.get('cache-control')).toBe('no-store');
    expect(blocked.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('does not limit another address or other pages', async () => {
    const proxy = await loadProxy('local');
    blockedOf(proxy, 31, () => search('203.0.113.7'));
    expect(proxy(search('198.51.100.9')).status).not.toBe(429);
    const others = blockedOf(
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
    const blocked = blockedOf(proxy, 100, (i) => search(`9.9.9.${String(i)}, 203.0.113.7`));
    expect(blocked).toBe(70);
  });

  it("cannot be used to burn another client's bucket", async () => {
    const proxy = await loadProxy('local');
    // The attacker claims to be the victim; the key is the address the proxy appended.
    blockedOf(proxy, 40, () => search('5.5.5.5, 192.0.2.50'));
    expect(proxy(search('5.5.5.5, 10.0.0.1')).status).not.toBe(429);
    expect(proxy(search('5.5.5.5')).status).not.toBe(429);
  });

  it('limits HEAD and POST and every spelling of the path, but not OPTIONS', async () => {
    const proxy = await loadProxy('local');
    blockedOf(proxy, 30, () => search('203.0.113.7'));
    for (const request of [
      search('203.0.113.7', { method: 'HEAD' }),
      search('203.0.113.7', { method: 'POST' }),
      search('203.0.113.7', { path: '/%73earch' }),
      search('203.0.113.7', { path: '/%65n/search' }),
      search('203.0.113.7', { path: '/en/%73earch' }),
      search('203.0.113.7', { path: '/search/' }),
    ]) {
      expect(proxy(request).status).toBe(429);
    }
    expect(proxy(search('203.0.113.7', { method: 'OPTIONS' })).status).not.toBe(429);
  });

  it('puts requests without a trustworthy address in one shared bucket', async () => {
    const proxy = await loadProxy('local');
    expect(blockedOf(proxy, 35, () => search(null))).toBe(5);
    // A request that does have an address is not caught by the shared bucket.
    expect(proxy(search('203.0.113.7')).status).not.toBe(429);
    // A header that is not an address is treated as missing, not as a key chosen by the client.
    expect(proxy(search('not-an-ip')).status).toBe(429);
  });

  it('counts hops from the right as configured (Cloudflare then Traefik is two)', async () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '2');
    const proxy = await loadProxy('local');
    // client, Cloudflare edge: the key is the client, whatever the edge address is.
    const blocked = blockedOf(proxy, 35, (i) => search(`203.0.113.7, 172.70.1.${String(i)}`));
    expect(blocked).toBe(5);
  });
});
