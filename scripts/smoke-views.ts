/**
 * Phase 10 on the BUILT server (called from smoke-web.ts): the product view counter. `POST /api/pv` is
 * public, so it is bounded: a same-site Origin, a small body, a per-client limit, and it answers an
 * empty 204 that says nothing about the product. The row it writes holds a product, an opaque hash and a
 * day, never an address; a repeat is the same row; another agent is another session.
 */
import { createDb } from '../packages/db/src/client.ts';
import { productViews, products } from '../packages/db/src/schema.ts';

interface Context {
  base: string;
  databaseUrl: string;
  siteOrigin: string;
  check: (name: string, ok: boolean) => void;
}

export async function runViewsSmoke({ base, databaseUrl, siteOrigin, check }: Context) {
  const { db, close } = createDb(databaseUrl, { max: 1 });
  try {
    const [product] = await db.select({ id: products.id }).from(products).limit(1);
    const productId = product?.id ?? '';
    const host = new URL(siteOrigin).host;
    let counter = 0;
    const post = async (
      body: string,
      headers: Record<string, string> = {},
      client = `198.51.100.${String(++counter + 100)}`,
    ) => {
      const response = await fetch(`${base}/api/pv`, {
        method: 'POST',
        body,
        redirect: 'manual',
        headers: {
          Origin: siteOrigin,
          'X-Forwarded-Host': host,
          'X-Forwarded-For': client,
          'User-Agent': 'smoke-views/1',
          'Content-Type': 'text/plain',
          ...headers,
        },
      });
      return {
        status: response.status,
        cache: response.headers.get('cache-control') ?? '',
        text: await response.text(),
        headers: response.headers,
      };
    };
    const rows = async () =>
      (await db.select({ hash: productViews.sessionHash }).from(productViews)).length;
    const good = JSON.stringify({ productId });

    const before = await rows();
    const first = await post(good, {}, '198.51.100.201');
    check(
      'views: a view is an empty 204, never cached, nosniff',
      first.status === 204 &&
        first.text === '' &&
        first.cache.includes('no-store') &&
        first.headers.get('x-content-type-options') === 'nosniff',
    );
    check('views: the first view writes one row', (await rows()) === before + 1);
    await post(good, {}, '198.51.100.201');
    check('views: the same visitor on the same day is the same row', (await rows()) === before + 1);
    await post(good, { 'User-Agent': 'smoke-views/2' }, '198.51.100.201');
    check('views: another agent is another session', (await rows()) === before + 2);
    const stored = (await db.select().from(productViews)).at(-1);
    check(
      'views: the row holds an opaque 64-character hash and a day, no address and no agent',
      stored !== undefined &&
        /^[0-9a-f]{64}$/.test(stored.sessionHash) &&
        !JSON.stringify(stored).includes('198.51.100') &&
        !JSON.stringify(stored).includes('smoke-views'),
    );

    const unknown = await post(
      JSON.stringify({ productId: '00000000-0000-4000-8000-0000000000ab' }),
    );
    check(
      'views: an unknown product gets the same 204 and no row',
      unknown.status === 204 && (await rows()) === before + 2,
    );
    check(
      'views: a body that is not an id is a 400',
      (await post('{"productId":"x"}')).status === 400 && (await post('not json')).status === 400,
    );
    check(
      'views: an extra field is a 400',
      (await post(JSON.stringify({ productId, extra: 1 }))).status === 400,
    );
    check(
      'views: a body over 256 bytes is refused (413)',
      (await post(JSON.stringify({ productId, pad: 'x'.repeat(400) }))).status === 413,
    );
    check(
      'views: another site cannot make a visitor count (403)',
      (await post(good, { Origin: 'https://evil.example' })).status === 403,
    );
    const noOrigin = await fetch(`${base}/api/pv`, {
      method: 'POST',
      body: good,
      headers: { 'X-Forwarded-For': '198.51.100.230' },
    });
    check('views: no Origin header is refused (403)', noOrigin.status === 403);
    const getResponse = await fetch(`${base}/api/pv`, {
      headers: { 'X-Forwarded-For': '198.51.100.231' },
    });
    check('views: a GET is not allowed (405)', getResponse.status === 405);

    let limited = 0;
    for (let i = 0; i < 70; i += 1) {
      if ((await post(good, {}, '198.51.100.240')).status === 429) limited += 1;
    }
    check('views: one client is limited (429 after 60 a minute)', limited >= 5);
  } finally {
    await close();
  }
}
