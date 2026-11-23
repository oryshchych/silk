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
