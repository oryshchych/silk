/**
 * Smoke test of the BUILT web app on a real server (run `pnpm --filter web
 * build` first): `pnpm smoke:web`. Unit tests mock next-intl and the Next
 * runtime, so locale routing, the redirect, the 404 pages and the runtime
 * `SITE_URL` are only provable here.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
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

/** Files under the build's runtime stores: rendered pages (server/) and data cache (cache/). */
function storedFiles(): number {
  let count = 0;
  for (const dir of ['apps/web/.next/server', 'apps/web/.next/cache']) {
    try {
      for (const entry of readdirSync(join(copy, dir), { recursive: true })) {
        if (statSync(join(copy, dir, String(entry))).isFile()) count += 1;
      }
    } catch {
      // The directory may not exist yet.
    }
  }
  return count;
}

const failures: string[] = [];
const check = (name: string, ok: boolean): void => {
  if (!ok) failures.push(name);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}\n`);
};

async function get(
  path: string,
): Promise<{ status: number; location: string | null; cache: string | null; html: string }> {
  const response = await fetch(base + path, { redirect: 'manual' });
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

  // The seed is deterministic: this product exists in the seeded dev database.
  const productPath = '/product/push-up-bra-aurora-1';
  const product = await get(productPath);
  const productLd = [
    ...product.html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g),
  ].map((match) => match[1] ?? '');
  check(
    'product page is 200 with a title',
    product.status === 200 && /<title>[^<]+<\/title>/.test(product.html),
  );
  check(
    'product page canonical is absolute on the runtime host',
    product.html.includes(`rel="canonical" href="${SITE}${productPath}"`),
  );
  check(
    'product page has hreflang uk, en and x-default',
    ['uk', 'en', 'x-default'].every((l) => product.html.includes(`hrefLang="${l}"`)),
  );
  check(
    'product page has Product (with offers) and BreadcrumbList JSON-LD in the primary HTML',
    productLd.some(
      (j) =>
        j.includes('"@type":"Product"') &&
        j.includes('"priceCurrency":"UAH"') &&
        j.includes('"availability":"https://schema.org/'),
    ) && productLd.some((j) => j.includes('"BreadcrumbList"')),
  );
  check(
    'product page renders an unavailable size as a disabled radio',
    /<input type="radio"[^>]*disabled=""[^>]*name="size"/.test(product.html),
  );
  check(
    'product page is served from the ISR cache on the second request (HIT)',
    (await get(productPath)).cache === 'HIT',
  );
  check('an unknown product is a real 404', (await get('/product/nope')).status === 404);
  check(
    'product JSON-LD has an absolute image on the runtime host and no rating markup',
    productLd.some((j) => j.includes(`"image":["${SITE}/placeholder.svg"]`)) &&
      !productLd.some((j) => j.includes('aggregateRating')),
  );

  // Unknown, malformed, hostile and over-long slugs are answered before any page
  // exists: they must not add files to the build's page or data caches.
  const storedBefore = storedFiles();
  const slugs = [
    ...Array.from({ length: 40 }, (_, i) => `random-${String(i)}-${String(Date.now() % 1000)}`),
    'x%00abc',
    'UPPER',
    'a--b',
    'a'.repeat(300),
    '%E0%A4%A',
    'Mixed-Case-1',
  ];
  let codes: number[] = [];
  for (const slug of slugs) {
    codes = [
      ...codes,
      (await get(`/product/${slug}`)).status,
      (await get(`/en/product/${slug}`)).status,
    ];
  }
  check(
    'unknown and malformed product slugs are 404s',
    codes.every((code) => code === 404),
  );
  check(
    'unknown and malformed product slugs add nothing to the page or data caches',
    storedFiles() === storedBefore,
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
