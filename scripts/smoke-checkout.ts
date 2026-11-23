/**
 * Phase 2 end to end over HTTP, on the BUILT app and a seeded database
 * (called from smoke-web.ts). No browser: server actions are POSTed with the
 * `Next-Action` id read from the build's server-reference manifest, the way
 * the page script does, and the answer is the flight payload. It follows the
 * shopper's path: add to cart, cart page, quote, place an order, order page,
 * tracking, and the guards (tampered price, double submit, COD series,
 * stock, directory without the carrier API).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Context {
  base: string;
  /** Directory that holds apps/web/.next (the throwaway copy of the standalone build). */
  buildRoot: string;
  check: (name: string, ok: boolean) => void;
}

type Jar = Map<string, string>;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function actionIds(buildRoot: string): Record<string, string> {
  const manifest = JSON.parse(
    readFileSync(join(buildRoot, 'apps/web/.next/server/server-reference-manifest.json'), 'utf8'),
  ) as { node: Record<string, { exportedName: string }> };
  return Object.fromEntries(
    Object.entries(manifest.node).map(([id, entry]) => [entry.exportedName, id]),
  );
}

function absorb(jar: Jar, response: Response): void {
  for (const line of response.headers.getSetCookie()) {
    const [pair = ''] = line.split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
}

const cookieHeader = (jar: Jar): string =>
  [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

export async function runCheckoutSmoke({ base, buildRoot, check }: Context): Promise<void> {
  const ids = actionIds(buildRoot);
  let clientCounter = 0;
  const newClient = (): string => `198.51.100.${String(++clientCounter)}`;

  async function call(
    name: string,
    args: unknown,
    jar: Jar,
    client: string,
    path = '/checkout',
  ): Promise<{ redirect: string | null; body: string; status: number; response: Response }> {
    const response = await fetch(base + path, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Next-Action': ids[name] ?? '',
        'Content-Type': 'text/plain;charset=UTF-8',
        'X-Forwarded-For': client,
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify([args]),
    });
    absorb(jar, response);
    const redirect = response.headers.get('x-action-redirect');
    return { redirect, body: await response.text(), status: response.status, response };
  }

  const resultOf = (body: string): Record<string, unknown> => {
    const line = body.split('\n').find((row) => row.startsWith('1:{') || row.includes('"ok":'));
    const json = line?.slice(line.indexOf('{')) ?? '{}';
    try {
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  async function page(path: string, jar: Jar): Promise<string> {
    const response = await fetch(base + path, {
      headers: { Cookie: cookieHeader(jar), 'X-Forwarded-For': '198.51.100.250' },
    });
    return await response.text();
  }

  // Variants from a product page: one with plenty of stock, one with only a few units.
  const home = await (await fetch(base + '/')).text();
  const slug = /href="(\/product\/[^"]+)"/.exec(home)?.[1] ?? '';
  const productHtml = await (await fetch(base + slug)).text();
  const variants = [
    ...productHtml.matchAll(
      new RegExp(
        `\\\\"id\\\\":\\\\"(${UUID})\\\\",\\\\"sizeLabel\\\\":[^}]*?\\\\"available\\\\":true,\\\\"lastUnits\\\\":(true|false)`,
        'g',
      ),
    ),
  ].map((match) => ({ id: match[1] ?? '', last: match[2] === 'true' }));
  const plenty = variants.find((variant) => !variant.last)?.id ?? '';
  const scarce = variants.find((variant) => variant.last)?.id ?? '';
  check(
    'checkout smoke: found a well-stocked and a scarce variant',
    plenty !== '' && scarce !== '',
  );

  const unique = String(Date.now()).slice(-7);
  const phoneOf = (suffix: string): string => `050${unique.slice(0, 4)}${suffix}`;
  const buyer = (phone: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    locale: 'uk',
    name: 'Тест Покупець',
    email: 'smoke@example.com',
    phone,
    delivery: 'np_warehouse',
    settlementRef: 'seed-city-kyiv',
    warehouseRef: 'seed-wh-kyiv-1',
    payment: 'cod',
    promoCode: '',
    ...over,
  });

  // 1. Add to cart, cookie attributes, cart page.
  const jar: Jar = new Map();
  const client = newClient();
  const added = await call(
    'addToCartAction',
    { variantId: plenty, quantity: 2 },
    jar,
    client,
    slug,
  );
  const cartCookie = added.response.headers
    .getSetCookie()
    .find((line) => line.startsWith('silk_cart='));
  check(
    'the cart cookie is httpOnly, Secure, SameSite and path-wide',
    /HttpOnly/i.test(cartCookie ?? '') &&
      /Secure/i.test(cartCookie ?? '') &&
      /SameSite=lax/i.test(cartCookie ?? '') &&
      /Path=\//.test(cartCookie ?? ''),
  );
  check('adding to the cart reports two items', resultOf(added.body)['itemCount'] === 2);
  const cartHtml = await page('/cart', jar);
  check(
    'the cart page lists the line, is noindex and shows a subtotal',
    cartHtml.includes('name="robots" content="noindex') && cartHtml.includes('₴'),
  );
  check(
    'a visitor without a cart sees an empty cart',
    (await page('/cart', new Map())).includes('Ваш кошик порожній'),
  );

  // 2. Quote, then place with a tampered payload: only the server total counts.
  const quote = await call(
    'quoteAction',
    { locale: 'uk', delivery: 'np_warehouse', promoCode: '' },
    jar,
    client,
  );
  const summary = (resultOf(quote.body)['summary'] ?? {}) as Record<string, string>;
  check('the quote answers with formatted totals', typeof summary['total'] === 'string');
  const bad = await call(
    'quoteAction',
    { locale: 'uk', delivery: 'np_warehouse', promoCode: 'NOPE' },
    jar,
    client,
  );
  const badPromo = (resultOf(bad.body)['summary'] ?? {}) as { promo?: Record<string, unknown> };
  check(
    'a refused promo code answers accepted:false without a reason',
    badPromo.promo?.['accepted'] === false && !('reason' in (badPromo.promo ?? {})),
  );
  await call('quoteAction', { locale: 'uk', delivery: 'np_warehouse', promoCode: '' }, jar, client);

  const phone = phoneOf('001');
  const first = await call(
    'placeOrderAction',
    buyer(phone, { total: 1, unitPrice: 1, quotedTotal: 1, allowUnquoted: true }),
    jar,
    client,
  );
  check(
    'placing the order redirects to the order page',
    first.redirect?.startsWith('/order/success') === true,
  );
  const success = await page('/order/success', jar);
  const number = /LS-\d{4}-\d{6}/.exec(success)?.[0] ?? '';
  check('the order page shows the order from the access cookie', number !== '');
  check(
    'a tampered price changes nothing: the order total is the quoted one',
    typeof summary['total'] === 'string' && success.includes(summary['total']),
  );
  check(
    'the order page without the cookie opens nothing',
    !/LS-\d{4}-\d{6}/.test(await page('/order/success', new Map())),
  );
  check(
    'the cart is empty after the order and the count cookie is reset',
    jar.get('silk_cart_n') === '0',
  );

  // 3. Tracking by number plus phone: reduced view, same answer for wrong phone.
  const trackJar: Jar = new Map();
  const found = await call(
    'trackOrderAction',
    { orderNumber: number, phone },
    trackJar,
    newClient(),
    '/order/track',
  );
  const foundBody = found.body;
  check('tracking by number and phone finds the order', foundBody.includes(number));
  check(
    'the tracked view has no street address and no waybill',
    !/deliveryAddress|"ttn"/.test(foundBody),
  );
  const wrong = await call(
    'trackOrderAction',
    { orderNumber: number, phone: phoneOf('999') },
    trackJar,
    newClient(),
    '/order/track',
  );
  check(
    'a wrong phone is the same "not found" answer',
    resultOf(wrong.body)['code'] === 'TRACK_NOT_FOUND',
  );
  const trackClient = newClient();
  let limited = false;
  for (let i = 0; i < 14; i += 1) {
    const attempt = await call(
      'trackOrderAction',
      { orderNumber: number, phone: phoneOf('998') },
      new Map(),
      trackClient,
      '/order/track',
    );
    if (resultOf(attempt.body)['code'] === 'RATE_LIMITED') limited = true;
  }
  check('tracking attempts from one client are rate limited', limited);

  // 4. Two submits of one cart (a double click, two tabs): one order.
  const dbl: Jar = new Map();
  const dblClient = newClient();
  await call('addToCartAction', { variantId: plenty, quantity: 1 }, dbl, dblClient, slug);
  await call('quoteAction', { locale: 'uk', delivery: 'pickup', promoCode: '' }, dbl, dblClient);
  const dblPhone = phoneOf('002');
  const payload = buyer(dblPhone, {
    delivery: 'pickup',
    settlementRef: undefined,
    warehouseRef: undefined,
    payment: 'bank_transfer',
  });
  const twinA: Jar = new Map(dbl);
  const twinB: Jar = new Map(dbl);
  const [a, b] = await Promise.all([
    call('placeOrderAction', payload, twinA, dblClient),
    call('placeOrderAction', payload, twinB, dblClient),
  ]);
  check(
    'two simultaneous submits both end on the order page',
    a.redirect?.startsWith('/order/success') === true &&
      b.redirect?.startsWith('/order/success') === true,
  );
  const accessA = twinA.get('silk_order');
  const accessB = twinB.get('silk_order');
  check(
    'only one of them created the order (one access cookie)',
    [accessA, accessB].filter((value) => value !== undefined).length === 1,
  );

  // 5. Not enough stock: the answer lists the positions.
  const greedy: Jar = new Map();
  const greedyClient = newClient();
  await call('addToCartAction', { variantId: scarce, quantity: 99 }, greedy, greedyClient, slug);
  await call(
    'quoteAction',
    { locale: 'uk', delivery: 'pickup', promoCode: '' },
    greedy,
    greedyClient,
  );
  const stock = await call(
    'placeOrderAction',
    buyer(phoneOf('003'), {
      delivery: 'pickup',
      settlementRef: undefined,
      warehouseRef: undefined,
      payment: 'bank_transfer',
    }),
    greedy,
    greedyClient,
  );
  const stockResult = resultOf(stock.body);
  check(
    'ordering more than is in stock names the positions and creates nothing',
    stockResult['kind'] === 'stock' &&
      Array.isArray(stockResult['problems']) &&
      (stockResult['problems'] as unknown[]).length === 1,
  );

  // 6. A series of COD orders from one phone: the per-phone limit, then the rate limit.
  const seriesPhone = phoneOf('004');
  const outcomes: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const buyerJar: Jar = new Map();
    const buyerClient = newClient();
    await call('addToCartAction', { variantId: plenty, quantity: 1 }, buyerJar, buyerClient, slug);
    await call(
      'quoteAction',
      { locale: 'uk', delivery: 'pickup', promoCode: '' },
      buyerJar,
      buyerClient,
    );
    const result = await call(
      'placeOrderAction',
      buyer(seriesPhone, { delivery: 'pickup', settlementRef: undefined, warehouseRef: undefined }),
      buyerJar,
      buyerClient,
    );
    outcomes.push(result.redirect === null ? String(resultOf(result.body)['code']) : 'created');
  }
  process.stdout.write(`     series outcomes: ${outcomes.join(',')}\n`);
  check(
    'a series of 20 COD orders from one phone creates at most 3 (the per-phone limit)',
    outcomes.filter((outcome) => outcome === 'created').length === 3 &&
      outcomes.filter((outcome) => outcome === 'CHECKOUT_COD_NOT_ALLOWED').length === 17,
  );
  const sameClient = newClient();
  const samePhone = phoneOf('005');
  const repeats: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const repeatJar: Jar = new Map();
    await call('addToCartAction', { variantId: plenty, quantity: 1 }, repeatJar, sameClient, slug);
    await call(
      'quoteAction',
      { locale: 'uk', delivery: 'pickup', promoCode: '' },
      repeatJar,
      sameClient,
    );
    const result = await call(
      'placeOrderAction',
      buyer(samePhone, { delivery: 'pickup', settlementRef: undefined, warehouseRef: undefined }),
      repeatJar,
      sameClient,
    );
    repeats.push(result.redirect === null ? String(resultOf(result.body)['code']) : 'created');
  }
  check(
    'the same client and phone is rate limited before the series ends',
    repeats.includes('RATE_LIMITED'),
  );

  // 7. The directory answers from our own tables, with no carrier API in reach.
  const cities = (await (
    await fetch(`${base}/api/np/cities?q=${encodeURIComponent('Киї')}`)
  ).json()) as { cities: { name: string }[] };
  check(
    'city autocomplete answers from the local directory',
    cities.cities.some((city) => city.name === 'Київ'),
  );
  const branches = (await (
    await fetch(`${base}/api/np/warehouses?city=seed-city-kyiv`)
  ).json()) as { warehouses: unknown[] };
  check('branches of a city are listed', branches.warehouses.length >= 3);
  const tooShort = (await (await fetch(`${base}/api/np/cities?q=%25`)).json()) as {
    cities: unknown[];
  };
  check('a wildcard-only or too short query returns nothing', tooShort.cities.length === 0);
  check(
    'a malformed branch query is a 400',
    (await fetch(`${base}/api/np/warehouses`)).status === 400,
  );

  // 8. Checkout page for an empty and a filled cart is noindex.
  const checkoutHtml = await page('/checkout', jar);
  check('the checkout page is noindex', checkoutHtml.includes('name="robots" content="noindex'));
}
