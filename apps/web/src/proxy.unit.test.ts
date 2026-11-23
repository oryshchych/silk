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
  const search = (ip: string, path = '/search') =>
    new NextRequest(`http://localhost:3000${path}?q=bra`, { headers: { 'x-forwarded-for': ip } });

  it('answers 429 with Retry-After after 30 searches a minute from one address', async () => {
    const proxy = await loadProxy('local');
    for (let i = 0; i < 30; i++) expect(proxy(search('203.0.113.7')).status).not.toBe(429);
    const blocked = proxy(search('203.0.113.7', '/en/search'));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(blocked.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('does not limit another address or other pages', async () => {
    const proxy = await loadProxy('local');
    for (let i = 0; i < 31; i++) proxy(search('203.0.113.7'));
    expect(proxy(search('198.51.100.9')).status).not.toBe(429);
    for (let i = 0; i < 40; i++) {
      const page = proxy(
        new NextRequest('http://localhost:3000/category/bras', {
          headers: { 'x-forwarded-for': '203.0.113.7' },
        }),
      );
      expect(page.status).not.toBe(429);
    }
  });
});
