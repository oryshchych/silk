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
  /** Files under the build's page and data caches. */
  storedFiles: () => number;
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

export async function runCheckoutSmoke({
  base,
  buildRoot,
  check,
  storedFiles,
}: Context): Promise<void> {
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

  /** The order page renders the order (a number in its details table), not the "no order" notice. */
  const showsOrder = (html: string): boolean =>
    /<dd class="font-medium">LS-\d{4}-\d{6}<\/dd>/.test(html);

  // Variants from the first product pages: one with plenty of stock, one with few or none.
  // A re-used local database may have run low on one product, so look across several.
  const home = await (await fetch(base + '/')).text();
  const slugs = [
    ...new Set([...home.matchAll(/href="(\/product\/[^"]+)"/g)].map((m) => m[1] ?? '')),
  ];
  const variants: { id: string; plenty: boolean }[] = [];
  const variantPattern = new RegExp(
    `\\\\"id\\\\":\\\\"(${UUID})\\\\",\\\\"sizeLabel\\\\":[^}]*?\\\\"available\\\\":(true|false),\\\\"lastUnits\\\\":(true|false)`,
    'g',
  );
  for (const path of slugs.slice(0, 8)) {
    const html = await (await fetch(base + path)).text();
    for (const match of html.matchAll(variantPattern)) {
      variants.push({ id: match[1] ?? '', plenty: match[2] === 'true' && match[3] === 'false' });
    }
  }
  const slug = slugs[0] ?? '';
  // Product pages are ISR and cache on first read; everything after this point is dynamic.
  const storedBefore = storedFiles();
  const plentyList = variants.filter((variant) => variant.plenty).map((variant) => variant.id);
  const plenty = plentyList[0] ?? '';
  // Spread the series over several variants so a re-used database does not run one dry.
  const spread = (i: number): string => plentyList[i % Math.max(plentyList.length, 1)] ?? '';
  let drawn = 0;
  /** Each step takes the next well-stocked variant, so no single one is drained by one run. */
  const nextPlenty = (): string => spread(drawn++);
  const scarce = variants.find((variant) => !variant.plenty)?.id ?? '';
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
    terms: true,
    ...over,
  });

  // 1. Add to cart, cookie attributes, cart page.
  const jar: Jar = new Map();
  const client = newClient();
  const added = await call(
    'addToCartAction',
    { variantId: nextPlenty(), quantity: 2 },
    jar,
    client,
    slug,
  );
  const cartCookie = added.response.headers
    .getSetCookie()
    .find((line) => line.startsWith('__Host-silk_cart='));
  check(
    'the cart cookie is __Host-prefixed, httpOnly, Secure, SameSite and path-wide',
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
  const number = /<dd class="font-medium">(LS-\d{4}-\d{6})<\/dd>/.exec(success)?.[1] ?? '';
  check('the order page shows the order from the access cookie', number !== '');
  const orderCookie = first.response.headers
    .getSetCookie()
    .find((line) => line.startsWith('__Host-silk_order='));
  check('the order cookie lives one day', /Max-Age=86400(;|$)/.test(orderCookie ?? ''));
  check(
    'a tampered price changes nothing: the order total is the quoted one',
    typeof summary['total'] === 'string' && success.includes(summary['total']),
  );
  check(
    'the order page without the cookie opens nothing',
    !showsOrder(await page('/order/success', new Map())),
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
  await call('addToCartAction', { variantId: nextPlenty(), quantity: 1 }, dbl, dblClient, slug);
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
    'two simultaneous submits both end on the order page or on tracking with a notice',
    [a, b].every(
      (r) =>
        r.redirect?.startsWith('/order/success') === true ||
        r.redirect?.startsWith('/order/track?placed=1') === true,
    ) && [a, b].some((r) => r.redirect?.startsWith('/order/success') === true),
  );
  const accessA = twinA.get('__Host-silk_order');
  const accessB = twinB.get('__Host-silk_order');
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
    await call(
      'addToCartAction',
      { variantId: spread(i), quantity: 1 },
      buyerJar,
      buyerClient,
      slug,
    );
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
    await call(
      'addToCartAction',
      { variantId: spread(i), quantity: 1 },
      repeatJar,
      sameClient,
      slug,
    );
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

  check('the shopper path adds nothing to the page or data caches', storedFiles() === storedBefore);

  // Messages: every namespace a client component uses must reach the browser.
  for (const path of ['/', '/cart', '/checkout', '/order/track', '/en/order/track']) {
    const html = await page(path, jar);
    check(
      `${path} shows no raw message keys`,
      !/>(nav|order|cart|checkout|product|errors)\.[A-Za-z_.]+</.test(html),
    );
  }

  // A forged or foreign order cookie opens nothing.
  const forged: Jar = new Map([['__Host-silk_order', `${number}.not-the-token`]]);
  check(
    'an order cookie with a wrong token opens nothing',
    !showsOrder(await page('/order/success', forged)),
  );

  // Directory routes are limited per client, HEAD included, and answer 429 without caching.
  const npClient = newClient();
  let npStatus = 0;
  let npRetry: string | null = null;
  let npCache: string | null = null;
  for (let i = 0; i < 130; i += 1) {
    const response = await fetch(`${base}/api/np/cities?q=%D0%9A%D0%B8`, {
      headers: { 'X-Forwarded-For': npClient },
    });
    if (response.status === 429) {
      npStatus = 429;
      npRetry = response.headers.get('retry-after');
      npCache = response.headers.get('cache-control');
      break;
    }
  }
  check(
    'the directory is rate limited per client (429, Retry-After, no-store)',
    npStatus === 429 && npRetry !== null && (npCache ?? '').includes('no-store'),
  );
  const head = await fetch(`${base}/api/np/cities?q=%D0%9A%D0%B8`, {
    method: 'HEAD',
    headers: { 'X-Forwarded-For': npClient },
  });
  check('HEAD counts against the same limit', head.status === 429);

  // Promo guessing is limited harder than plain quotes.
  const guessJar: Jar = new Map();
  const guessClient = newClient();
  await call(
    'addToCartAction',
    { variantId: nextPlenty(), quantity: 1 },
    guessJar,
    guessClient,
    slug,
  );
  let promoLimited = false;
  for (let i = 0; i < 14; i += 1) {
    const attempt = await call(
      'quoteAction',
      { locale: 'uk', delivery: 'pickup', promoCode: `GUESS${String(i)}` },
      guessJar,
      guessClient,
    );
    if (resultOf(attempt.body)['code'] === 'RATE_LIMITED') promoLimited = true;
  }
  check('quotes with a promo code are limited harder (a guessing guard)', promoLimited);

  // The guard of Q12 end to end: an order without a shown total is refused, and after the
  // server refuses a stale total the next press (with the new total held) goes through.
  const quoteJar: Jar = new Map();
  const quoteClient = newClient();
  await call(
    'addToCartAction',
    { variantId: nextPlenty(), quantity: 1 },
    quoteJar,
    quoteClient,
    slug,
  );
  const unquoted = await call(
    'placeOrderAction',
    buyer(phoneOf('006'), {
      delivery: 'pickup',
      settlementRef: undefined,
      warehouseRef: undefined,
      payment: 'bank_transfer',
    }),
    quoteJar,
    quoteClient,
  );
  check(
    'placing an order without a prior quote is refused (CHECKOUT_QUOTE_REQUIRED)',
    unquoted.redirect === null && resultOf(unquoted.body)['code'] === 'CHECKOUT_QUOTE_REQUIRED',
  );
  await call(
    'quoteAction',
    { locale: 'uk', delivery: 'pickup', promoCode: '' },
    quoteJar,
    quoteClient,
  );
  const changed = buyer(phoneOf('006'), { payment: 'bank_transfer' });
  const stale = await call('placeOrderAction', changed, quoteJar, quoteClient);
  check(
    'a total that no longer matches the quote is refused with the new total',
    resultOf(stale.body)['kind'] === 'priceChanged' && stale.redirect === null,
  );
  const beforeConfirm: Jar = new Map(quoteJar);
  const confirmed = await call('placeOrderAction', changed, quoteJar, quoteClient);
  check(
    'pressing again after the refusal confirms the new total and places the order',
    confirmed.redirect?.startsWith('/order/success') === true,
  );

  // A replay without the order cookie goes to tracking with a notice, not to an empty page.
  const replayJar: Jar = new Map(beforeConfirm);
  replayJar.delete('__Host-silk_order');
  const replay = await call('placeOrderAction', changed, replayJar, quoteClient);
  check(
    'a replayed submit without the order cookie is sent to tracking',
    replay.redirect?.startsWith('/order/track?placed=1') === true,
  );

  // A NUL byte must not be a server error anywhere a visitor can type.
  for (const path of [
    '/api/np/cities?q=%00%00abc',
    '/api/np/warehouses?city=%00',
    '/api/np/warehouses?city=x&q=%00',
  ]) {
    const response = await fetch(base + path, { headers: { 'X-Forwarded-For': newClient() } });
    check(`a NUL byte in ${path.slice(0, 32)} is not a server error`, response.status < 500);
  }
  const nulJar: Jar = new Map();
  const nulClient = newClient();
  await call('addToCartAction', { variantId: nextPlenty(), quantity: 1 }, nulJar, nulClient, slug);
  await call('quoteAction', { locale: 'uk', delivery: 'pickup', promoCode: '' }, nulJar, nulClient);
  const nul = await call(
    'placeOrderAction',
    buyer(phoneOf('007'), {
      name: 'Іван\u0000',
      delivery: 'pickup',
      settlementRef: undefined,
      warehouseRef: undefined,
    }),
    nulJar,
    nulClient,
  );
  check(
    'a NUL byte in a form field is a validation answer, not a server error',
    nul.status === 200 && resultOf(nul.body)['code'] === 'INVALID_FIELDS',
  );

  // The terms must be accepted: refused with its own message, and nothing is created.
  const termsJar: Jar = new Map();
  const termsClient = newClient();
  await call(
    'addToCartAction',
    { variantId: nextPlenty(), quantity: 1 },
    termsJar,
    termsClient,
    slug,
  );
  await call(
    'quoteAction',
    { locale: 'uk', delivery: 'pickup', promoCode: '' },
    termsJar,
    termsClient,
  );
  for (const terms of [false, undefined]) {
    const refused = await call(
      'placeOrderAction',
      buyer(phoneOf('008'), {
        delivery: 'pickup',
        settlementRef: undefined,
        warehouseRef: undefined,
        terms,
      }),
      termsJar,
      termsClient,
    );
    check(
      `placing without accepting the terms (${String(terms)}) is refused`,
      refused.redirect === null && resultOf(refused.body)['code'] === 'CHECKOUT_TERMS_REQUIRED',
    );
  }
}
