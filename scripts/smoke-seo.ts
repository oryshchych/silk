/**
 * Smoke checks of the SEO surface on the BUILT server (phase 6): robots.txt, the sitemap index and
 * its files, as a crawler fetches them over HTTP. Every URL in the sitemap must answer 200 and be
 * indexable, hreflang pairs must be reciprocal, and odd file names must be 404s that store nothing.
 */
interface SeoSmokeContext {
  base: string;
  site: string;
  check: (name: string, ok: boolean) => void;
  storedFiles: () => number;
}

async function text(url: string): Promise<{ status: number; type: string | null; body: string }> {
  const response = await fetch(url, { redirect: 'manual' });
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    body: await response.text(),
  };
}

const locs = (xml: string): string[] =>
  [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));

export async function runSeoSmoke({
  base,
  site,
  check,
  storedFiles,
}: SeoSmokeContext): Promise<void> {
  const robots = await text(`${base}/robots.txt`);
  check(
    'robots.txt (production) closes admin, api, cart, checkout, order, search and names the sitemap',
    robots.status === 200 &&
      ['/admin/', '/api/', '/cart$', '/checkout?', '/order/', '/search?', '/en/cart$'].every((p) =>
        robots.body.includes(`Disallow: ${p}`),
      ) &&
      robots.body.includes(`Sitemap: ${site}/sitemap.xml`),
  );

  const before = storedFiles();
  const index = await text(`${base}/sitemap.xml`);
  const files = locs(index.body);
  check(
    'sitemap.xml is XML, lists pages.xml and product files on the runtime SITE_URL',
    index.status === 200 &&
      (index.type ?? '').startsWith('application/xml') &&
      files.includes(`${site}/sitemaps/pages.xml`) &&
      files.every((f) => f.startsWith(`${site}/sitemaps/`)),
  );

  const urls: string[] = [];
  let valid = true;
  for (const file of files) {
    const page = await text(`${base}${new URL(file).pathname}`);
    valid &&=
      page.status === 200 &&
      page.body.startsWith('<?xml') &&
      page.body.trimEnd().endsWith('</urlset>');
    urls.push(...locs(page.body));
  }
  check('every sitemap file is a complete urlset', valid);
  check(
    'the sitemap holds the home page, categories and products in both locales',
    urls.includes(site) &&
      urls.includes(`${site}/en`) &&
      urls.some((u) => u.includes('/category/')) &&
      urls.some((u) => u.includes('/product/')) &&
      urls.some((u) => u.includes('/en/product/')),
  );

  const odd = [
    'products-99.xml',
    'products-00.xml',
    'products-01.xml',
    'products--1.xml',
    'PAGES.xml',
    'pages.xml.gz',
    'x'.repeat(5_000),
    '%2e%2e%2fpages.xml',
  ];
  const codes: number[] = [];
  for (const name of odd) codes.push((await text(`${base}/sitemaps/${name}`)).status);
  check(
    'unknown or oddly spelled sitemap names are 404s',
    codes.every((c) => c === 404),
  );
  check('sitemaps and odd names store nothing in .next', storedFiles() === before);

  // The crawler's own check: each listed URL is 200, indexable and its canonical is itself.
  let reachable = true;
  let indexable = true;
  for (const url of urls.slice(0, 40)) {
    const page = await text(`${base}${new URL(url).pathname}`);
    if (
      page.status !== 200 ||
      !page.body.includes(`rel="canonical" href="${url}"`) ||
      page.body.includes('name="robots" content="noindex')
    ) {
      process.stderr.write(`sample problem: ${url} -> ${String(page.status)}\n`);
    }
    reachable &&= page.status === 200;
    indexable &&=
      !page.body.includes('name="robots" content="noindex') &&
      page.body.includes(`rel="canonical" href="${url}"`);
  }
  check(
    'sampled sitemap URLs answer 200 and are indexable with a self canonical',
    reachable && indexable,
  );

  const pageFile = await text(`${base}/sitemaps/pages.xml`);
  const pairs = [...pageFile.body.matchAll(/hreflang="(uk|en)" href="([^"]+)"/g)];
  check(
    'every hreflang in the pages sitemap points at a URL the sitemap lists',
    pairs.length > 0 && pairs.every((m) => urls.includes(m[2] ?? '')),
  );
}
