/**
 * Smoke test of the BUILT web app on a real server (run `pnpm --filter web
 * build` first): `pnpm smoke:web`. Unit tests mock next-intl and the Next
 * runtime, so locale routing, the redirect, the 404 pages and the runtime
 * `SITE_URL` are only provable here.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const port = 3917;
const base = `http://localhost:${String(port)}`;
const SITE = 'https://smoke.example';
// The catalog pages read the database: run against the local dev database
// (`pnpm dev:db`, `pnpm db:migrate`, `pnpm db:seed`) or pass --database-url=...
const databaseUrl =
  process.argv.find((arg) => arg.startsWith('--database-url='))?.slice('--database-url='.length) ??
  'postgres://store_app:store_app@localhost:54322/store';

// ISR writes its cache next to the build. Run from a throwaway copy so a run
// never reads pages cached by an earlier one (with another SITE_URL) and never
// leaves cached pages in the build.
const copy = mkdtempSync(join(tmpdir(), 'smoke-web-'));
cpSync(join(root, 'apps/web/.next/standalone'), copy, { recursive: true });

const server = spawn(process.execPath, [join(copy, 'apps/web/server.js')], {
  env: {
    PORT: String(port),
    APP_ENV: 'production',
    SITE_URL: SITE,
    DATABASE_URL: databaseUrl,
    // Production needs every secret; the values are never used by these pages.
    ...Object.fromEntries(
      [
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
      ].map((key) => [key, 'smoke']),
    ),
  },
  stdio: 'ignore',
});

const failures: string[] = [];
const check = (name: string, ok: boolean): void => {
  if (!ok) failures.push(name);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}\n`);
};

async function get(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; location: string | null; cache: string | null; html: string }> {
  const response = await fetch(base + path, { redirect: 'manual', ...init });
  return {
    status: response.status,
    location: response.headers.get('location'),
    cache: response.headers.get('x-nextjs-cache'),
    html: await response.text(),
  };
}

async function waitReady(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/api/health`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error('server did not start');
}

try {
  await waitReady();

  const uk = await get('/');
  check('/ is 200 with <html lang="uk">', uk.status === 200 && uk.html.includes('<html lang="uk"'));
  check('/ canonical uses the runtime SITE_URL', uk.html.includes(`rel="canonical" href="${SITE}`));

  const home = await get('/');
  check(
    'home shows the new arrivals and bestsellers sections with product links',
    home.html.includes('id="home-new"') &&
      home.html.includes('id="home-bestsellers"') &&
      (home.html.match(/href="\/product\//g) ?? []).length >= 2,
  );
  const icon = await fetch(`${base}/icon.svg`);
  check(
    'the favicon is served',
    icon.status === 200 && (icon.headers.get('content-type') ?? '').includes('svg'),
  );

  const en = await get('/en');
  check(
    '/en is 200 with <html lang="en">',
    en.status === 200 && en.html.includes('<html lang="en"'),
  );
  check(
    '/en has reciprocal hreflang and x-default',
    ['uk', 'en', 'x-default'].every((l) => en.html.includes(`hrefLang="${l}"`)),
  );

  const prefixed = await get('/uk/zzz?a=1');
  const target = prefixed.location === null ? null : new URL(prefixed.location, base).href;
  check(
    '/uk/zzz?a=1 redirects 308 to /zzz?a=1',
    prefixed.status === 308 && target === `${base}/zzz?a=1`,
  );

  const category = await get('/category/bras');
  const ld = [
    ...category.html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g),
  ].map((match) => match[1] ?? '');
  check(
    '/category/bras is 200 with the title in the primary HTML',
    category.status === 200 && /<title>[^<]+<\/title>/.test(category.html),
  );
  check(
    '/category/bras canonical is absolute on the runtime host',
    category.html.includes(`rel="canonical" href="${SITE}/category/bras"`),
  );
  check(
    '/category/bras has hreflang uk, en and x-default',
    ['uk', 'en', 'x-default'].every((l) => category.html.includes(`hrefLang="${l}"`)),
  );
  check(
    '/category/bras has BreadcrumbList and ItemList JSON-LD',
    ld.some((j) => j.includes('"BreadcrumbList"')) && ld.some((j) => j.includes('"ItemList"')),
  );
  check(
    '/category/bras lists products as links with images or placeholders',
    (category.html.match(/\/product\//g) ?? []).length >= 3,
  );

  const filtered = await get('/category/bras?band=75&cup=B&color=black');
  check(
    'three filters give 200, noindex and the clean canonical',
    filtered.status === 200 &&
      filtered.html.includes('content="noindex, follow"') &&
      filtered.html.includes(`rel="canonical" href="${SITE}/category/bras"`),
  );
  check(
    'the language switch keeps the page and the filters',
    filtered.html.includes('href="/en/category/bras?band=75&amp;cup=B&amp;color=black"'),
  );
  const oneBand = await get('/en/category/bras?band=75');
  check(
    'one band filter is indexable with its own canonical',
    oneBand.status === 200 &&
      !oneBand.html.includes('noindex') &&
      oneBand.html.includes(`rel="canonical" href="${SITE}/en/category/bras?band=75"`),
  );
  const bandTitle = (html: string): string => /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
  check(
    'an indexable band filter has its own title and h1',
    bandTitle(oneBand.html) !== bandTitle((await get('/en/category/bras')).html) &&
      /<h1[^>]*>[^<]*75/.test(oneBand.html),
  );

  // Hostile values stay bounded: they are dropped (200) or rejected (404), never crash or cache.
  const hostile = [
    `/category/bras?brand=${'x'.repeat(100)}&size=${'y'.repeat(30)}&color=%00&band=999&cup=zz`,
    '/category/bras?price_min=99999999999&price_max=-1',
    `/category/bras?brand=${encodeURIComponent("'; DROP TABLE products; --")}`,
  ];
  for (const path of hostile)
    check(
      `hostile filter values give a bounded 200: ${path.slice(0, 48)}`,
      (await get(path)).status === 200,
    );
  check(
    'the largest page number past the end is a real 404',
    (await get('/category/bras?page=1000')).status === 404,
  );
  check(
    'an invalid page number is page 1',
    (await get('/category/bras?page=99999')).status === 200,
  );

  // Nothing internal reaches the HTML or the RSC payload of the home page or a listing.
  const internal =
    /cost_price|costPrice|unit_cost|admin_note|stock_quantity|stockQuantity|reserved_quantity/i;
  check(
    'home and listing HTML carry no cost, stock or admin fields',
    !internal.test((await get('/')).html) && !internal.test(category.html),
  );

  check('an unknown category is a real 404', (await get('/category/nope')).status === 404);
  check('a page past the end is a real 404', (await get('/category/bras?page=99')).status === 404);

  const productLinks = (html: string): number =>
    (html.match(/href="\/(en\/)?product\//g) ?? []).length;
  const inflected = await get(`/search?q=${encodeURIComponent('бюстгальтери')}`);
  check(
    'search finds products for an inflected word and is noindex',
    inflected.status === 200 &&
      productLinks(inflected.html) > 0 &&
      inflected.html.includes('content="noindex, follow"'),
  );
  const typo = await get(`/search?q=${encodeURIComponent('бюстгалтер')}`);
  check('search finds products despite a typo', typo.status === 200 && productLinks(typo.html) > 0);
  const nothing = await get('/en/search?q=qzxwvk');
  check(
    'search with no match is a 200 empty state',
    nothing.status === 200 &&
      productLinks(nothing.html) === 0 &&
      nothing.html.includes('Nothing found'),
  );
  const short = await get('/search?q=a');
  check(
    'a one-character query shows the hint and no results',
    short.status === 200 && productLinks(short.html) === 0,
  );
  check(
    'a search page past the end is a real 404',
    (await get(`/search?q=${encodeURIComponent('бюстгальтер')}&page=99`)).status === 404,
  );

  // Hostile query text: a NUL byte must not be a server error, markup must come out escaped.
  check(
    'a NUL byte in the query is not a server error',
    (await get('/search?q=br%00a')).status === 200,
  );
  const hostileSearch = await get(`/search?q=${encodeURIComponent('<script>alert(1)</script>')}`);
  check(
    'a hostile query is escaped in the page',
    hostileSearch.status === 200 &&
      hostileSearch.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') &&
      !hostileSearch.html.includes('<script>alert(1)</script>'),
  );
  check(
    'a 500-character query is cut to 100 characters in the field',
    /value="a{100}"/.test((await get(`/search?q=${'a'.repeat(500)}`)).html),
  );

  // The search rate limit, on the built server. The client is the address the trusted
  // proxy appended (the last X-Forwarded-For entry); what the client sends before it
  // is ignored, and neither the method nor the spelling of the path escapes the limit.
  const spoofed = (i: number): RequestInit => ({
    headers: { 'x-forwarded-for': `9.9.9.${String(i)}, 203.0.113.99` },
  });
  let limited = 0;
  for (let i = 0; i < 35; i++) {
    if ((await get('/search?q=bra', spoofed(i))).status === 429) limited += 1;
  }
  check('rotating X-Forwarded-For entries does not escape the search limit', limited === 5);
  const stillLimited = async (path: string, method = 'GET'): Promise<boolean> =>
    (await get(path, { method, ...spoofed(0) })).status === 429;
  check(
    'HEAD, POST and an encoded path are limited too',
    (await stillLimited('/search?q=bra', 'HEAD')) &&
      (await stillLimited('/search?q=bra', 'POST')) &&
      (await stillLimited('/%73earch?q=bra')) &&
      (await stillLimited('/%65n/search?q=bra')),
  );
  const refused = await fetch(`${base}/search?q=bra`, { ...spoofed(0), redirect: 'manual' });
  check(
    'a refused search carries Retry-After and is not cacheable',
    refused.status === 429 &&
      Number(refused.headers.get('retry-after')) > 0 &&
      refused.headers.get('cache-control') === 'no-store',
  );

  for (const path of ['/nope', '/en/nope', '/en/a/b']) {
    const page = await get(path);
    check(
      `${path} is a real 404, noindex, server-rendered with lang and text`,
      page.status === 404 &&
        page.html.includes('name="robots" content="noindex"') &&
        page.html.includes('<html lang="uk"') &&
        !page.html.includes('__next_error__') &&
        page.html.includes('Сторінку не знайдено'),
    );
  }
} finally {
  server.kill();
  rmSync(copy, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stderr.write(`\n${String(failures.length)} check(s) failed\n`);
  process.exit(1);
}
