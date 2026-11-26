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

/**
 * A POST (a server action posts to the page URL) to a slug that does not exist must not render and
 * cache a page per slug, as a GET would not: the disk must not grow with what a client invents.
 */
export async function runPostFloodSmoke({
  base,
  check,
  storedFiles,
}: SeoSmokeContext): Promise<void> {
  const before = storedFiles();
  const statuses = new Set<number>();
  for (let i = 0; i < 150; i++) {
    for (const path of [
      `/product/postnope-${String(i)}`,
      `/en/product/postnope-${String(i)}`,
      `/category/postnope-${String(i)}`,
    ]) {
      const response = await fetch(`${base}${path}`, { method: 'POST', redirect: 'manual' });
      await response.arrayBuffer();
      statuses.add(response.status);
    }
  }
  check(
    'POSTs to 450 invented product and category paths store nothing in .next',
    storedFiles() === before,
  );
  check(
    'and they answer 404 or 405, never a page',
    [...statuses].every((s) => s === 404 || s === 405),
  );
}

/**
 * Trackers and consent, as the server sends them: the primary HTML of every public page names no
 * tracker host and carries no script for one (the scripts are added by the browser only after the
 * visitor accepts), while the identifiers do reach the page as runtime data.
 */
export async function runAnalyticsSmoke({
  base,
  check,
}: Pick<SeoSmokeContext, 'base' | 'check'>): Promise<void> {
  const HOSTS =
    /googletagmanager\.com|google-analytics\.com|connect\.facebook\.net|fbevents|gtag\/js|gtm\.js/i;
  const pages = ['/', '/en', '/category/bras', '/cart', '/checkout', '/order/success'];
  let clean = true;
  let identified = false;
  for (const path of pages) {
    const page = await text(`${base}${path}`);
    if (HOSTS.test(page.body)) {
      process.stderr.write(`tracker host in the HTML of ${path}\n`);
      clean = false;
    }
    identified ||= page.body.includes('G-SMOKE1234');
  }
  check('analytics: no page names a tracker host or loads a tracker script before consent', clean);
  check(
    'analytics: the identifiers reach the page as runtime data (ADR-10), not baked into the build',
    identified,
  );
}
