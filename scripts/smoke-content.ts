/**
 * Phase 9 on the BUILT server (called from smoke-web.ts): the readiness report agrees with what a
 * visitor gets. One READY and one INCOMPLETE product are written straight into the database; the
 * report must call the first ready and the second not, and the real storefront HTML in BOTH
 * languages must show the first one's title, description, name, composition and photo alt text,
 * and the second one's fallbacks without a photo. The category text is saved the way the editor does
 * (a real server action through a content editor's session) and must then appear on the category page.
 */
import { beginLogin, createAdminUser } from '../packages/core/src/auth/service.ts';
import { readContentReadiness } from '../packages/core/src/content-readiness/read.ts';
import { createDb } from '../packages/db/src/client.ts';
import { categories } from '../packages/db/src/schema.ts';
import { actionIds } from './smoke-http.ts';
import {
  addProduct,
  filler,
  GOOD_ALT,
  seedDictionaries,
} from '../packages/core/test/content-fixture.ts';

interface Context {
  base: string;
  databaseUrl: string;
  authSecret: string;
  buildRoot: string;
  siteOrigin: string;
  check: (name: string, ok: boolean) => void;
}

const PASSWORD = 'smoke-content-password-0123456789';
const HOSTILE = '<script>alert("smoke")</script>';

export async function runContentSmoke({
  base,
  databaseUrl,
  authSecret,
  buildRoot,
  siteOrigin,
  check,
}: Context) {
  const { db, close } = createDb(databaseUrl, { max: 2 });
  const suffix = String(Date.now());
  let counter = 0;
  const nextClient = (): string => `203.0.113.${String(++counter + 150)}`;
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, {
      redirect: 'manual',
      headers: { 'X-Forwarded-For': nextClient(), ...headers },
    });
    return {
      status: response.status,
      location: response.headers.get('location'),
      cache: response.headers.get('cache-control') ?? '',
      robots: response.headers.get('x-robots-tag') ?? '',
      html: await response.text(),
    };
  };
  try {
    const { good, bad, goodSlug, badSlug, category } = await db.transaction(async (tx) => {
      // Fixed slugs get this run's suffix so the script can run again on the same database.
      const dict = await seedDictionaries(tx, `-${suffix}`);
      const goodId = await addProduct(tx, dict, {
        key: `smoke-ready-${suffix}`,
        categoryId: dict.categoryId,
        product: { slug: `smoke-ready-${suffix}`, sku: `SMOKE-R-${suffix}` },
      });
      const badId = await addProduct(tx, dict, {
        key: `smoke-bad-${suffix}`,
        categoryId: dict.categoryId,
        images: [],
        product: {
          slug: `smoke-bad-${suffix}`,
          sku: `SMOKE-B-${suffix}`,
          nameUk: HOSTILE,
          nameEn: HOSTILE,
          metaTitleUk: null,
          metaTitleEn: null,
          metaDescriptionUk: null,
          metaDescriptionEn: null,
        },
      });
      return {
        good: goodId,
        bad: badId,
        goodSlug: `smoke-ready-${suffix}`,
        badSlug: `smoke-bad-${suffix}`,
        category: `ready-cat-${suffix}`,
      };
    });

    // 1. The report's verdict.
    const report = await db.transaction(async (tx) => await readContentReadiness(tx), {
      accessMode: 'read only',
    });
    const goodRow = report.products.find((row) => row.id === good);
    const badRow = report.products.find((row) => row.id === bad);
    check(
      'content: the report calls the complete product ready and live',
      goodRow?.ready === true && goodRow.live,
    );
    check(
      'content: the report calls the product without photo and meta not ready',
      badRow?.ready === false &&
        badRow.findings.some((f) => f.code === 'no_photo') &&
        badRow.findings.some((f) => f.code === 'missing' && f.field === 'meta_description'),
    );

    const config = { secret: authSecret };
    const client = { ip: '198.51.100.88', userAgent: 'smoke-content' };
    const tokens: Record<string, string> = {};
    for (const role of ['content'] as const) {
      const email = `${role}-content-${suffix}@example.test`;
      await db.transaction(async (tx) => {
        await createAdminUser(tx, { email, password: PASSWORD, role });
      });
      const login = await db.transaction(
        async (tx) => await beginLogin(tx, config, { email, password: PASSWORD, client }),
      );
      if (!login.ok) throw new Error('smoke content account could not sign in');
      tokens[role] = login.token;
    }
    // The category text is written the way the editor does it (a server action, which also drops the
    // storefront's cached category list): the page must then show exactly what the report measured.
    const rows = await db.select({ id: categories.id, slug: categories.slug }).from(categories);
    const categoryId = rows.find((row) => row.slug === category)?.id ?? '';
    const ids = actionIds(buildRoot);
    const updated = await fetch(base + '/admin/categories', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Next-Action': ids['updateCategoryAction'] ?? '',
        'Content-Type': 'text/plain;charset=UTF-8',
        'X-Forwarded-For': nextClient(),
        Origin: siteOrigin,
        'X-Forwarded-Host': new URL(siteOrigin).host,
        Cookie: `admin_session=${tokens['content'] ?? ''}`,
      },
      body: JSON.stringify([
        {
          categoryId,
          seoTextUk: `<p>${filler('Smoke uk text', 260)}</p>`,
          seoTextEn: `<p>${filler('Smoke en text', 260)}</p>`,
        },
      ]),
    });
    check(
      'content: a content editor saves the category text through the real action',
      updated.status === 200,
    );

    // 2. The storefront agrees, in both languages. The proxy's set of visible product slugs reloads
    // once a minute (a row written around the server is a 404 until then), so wait for it.
    for (let waited = 0; waited < 80_000; waited += 3_000) {
      if ((await get(`/product/${badSlug}`)).status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    for (const locale of ['uk', 'en'] as const) {
      const prefix = locale === 'uk' ? '' : '/en';
      const key = `smoke-ready-${suffix}`;
      const titleBase = locale === 'uk' ? 'Заголовок' : 'Title';
      const page = await get(`${prefix}/product/${goodSlug}`);
      check(
        `content: the ready product page (${locale}) shows its meta title, description, name, composition and photo alt`,
        page.status === 200 &&
          page.html.includes(filler(`${titleBase} ${key}`, 45)) &&
          page.html.includes(
            filler(`${locale === 'uk' ? 'Опис для пошуку' : 'Search description'} ${key}`, 120),
          ) &&
          page.html.includes(locale === 'uk' ? `Бюстгальтер ${key}` : `Bra ${key}`) &&
          page.html.includes(locale === 'uk' ? 'Бавовна 95%' : 'Cotton 95%') &&
          page.html.includes(locale === 'uk' ? GOOD_ALT.uk : GOOD_ALT.en),
      );
      const incomplete = await get(`${prefix}/product/${badSlug}`);
      check(
        `content: the incomplete product page (${locale}) falls back, has no photo alt and never carries raw markup from its name`,
        incomplete.status === 200 &&
          !incomplete.html.includes(locale === 'uk' ? GOOD_ALT.uk : GOOD_ALT.en) &&
          !incomplete.html.includes(HOSTILE) &&
          !incomplete.html.includes('MISSING_MESSAGE'),
      );
      const cat = await get(`${prefix}/category/${category}`);
      check(
        `content: the category page (${locale}) shows the SEO text the report counted`,
        cat.status === 200 &&
          cat.html.includes(filler(locale === 'uk' ? 'Smoke uk text' : 'Smoke en text', 260)),
      );
    }

    // 3. The admin screen, by role.
  } finally {
    await close();
  }
}
