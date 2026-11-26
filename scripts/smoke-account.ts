/**
 * The customer account on the BUILT app over real HTTP (called from smoke-web.ts): the credential
 * pages and their headers, registration by link, the one-time link, sign-in, the session cookie,
 * sign-out, enumeration-safe answers, the Origin check and the per-client limits. No browser: server
 * actions are POSTed with the `Next-Action` id from the build's manifest, as the page script does.
 * The mailed link is rebuilt from the token id in the database, exactly as the worker does (nothing
 * is sent anywhere).
 */
import { buildUnsubscribeToken } from '../packages/core/src/account/unsubscribe-token.ts';
import { parseSizesCookie } from '../apps/web/src/lib/my-sizes.ts';
import { buildEmailToken } from '../packages/core/src/customer-auth/tokens.ts';
import { createDb } from '../packages/db/src/client.ts';
import { absorb, actionIds, cookieHeader, type Jar } from './smoke-http.ts';

interface Context {
  base: string;
  databaseUrl: string;
  authSecret: string;
  buildRoot: string;
  siteOrigin: string;
  check: (name: string, ok: boolean) => void;
}

const PASSWORD = 'smoke-customer-password-91';

export async function runAccountSmoke(ctx: Context): Promise<void> {
  const { base, siteOrigin } = ctx;
  /** A failed check prints what the server answered, so a CI log is enough to see why. */
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    ctx.check(name, ok);
    if (!ok && detail !== undefined) {
      process.stdout.write(`     ${JSON.stringify(detail).slice(0, 700)}\n`);
    }
  };
  const brief = (r: {
    status?: number;
    location?: string | null;
    redirect?: string | null;
    cache?: string;
    setCookie?: string;
    body?: string;
    html?: string;
  }) => ({
    status: r.status,
    location: r.location,
    redirect: r.redirect,
    cache: r.cache,
    setCookie: r.setCookie,
    text: (r.body ?? r.html ?? '').slice(0, 300),
  });
  const ids = actionIds(ctx.buildRoot);
  const handle = createDb(ctx.databaseUrl, { max: 2 });
  let clientCounter = 0;
  const newClient = (): string => `203.0.113.${String(100 + ++clientCounter)}`;
  const stamp = String(Date.now()).slice(-8);

  const page = async (path: string, jar: Jar = new Map(), client = newClient()) => {
    const response = await fetch(base + path, {
      redirect: 'manual',
      headers: { Cookie: cookieHeader(jar), 'X-Forwarded-For': client },
    });
    return {
      status: response.status,
      location: response.headers.get('location'),
      cache: response.headers.get('cache-control') ?? '',
      robots: response.headers.get('x-robots-tag') ?? '',
      referrer: response.headers.get('referrer-policy') ?? '',
      html: await response.text(),
    };
  };

  async function act(
    name: string,
    args: Record<string, unknown>,
    jar: Jar,
    client: string,
    path = '/account/login',
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(base + path, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Next-Action': ids[name] ?? '',
        'Content-Type': 'text/plain;charset=UTF-8',
        'X-Forwarded-For': client,
        Origin: siteOrigin,
        'X-Forwarded-Host': new URL(siteOrigin).host,
        Cookie: cookieHeader(jar),
        ...headers,
      },
      body: JSON.stringify([args]),
    });
    absorb(jar, response);
    return {
      status: response.status,
      redirect: response.headers.get('x-action-redirect'),
      setCookie: response.headers.getSetCookie().join('\n'),
      body: await response.text(),
    };
  }

  /** The link the worker would mail: rebuilt from the newest open token of the address. */
  async function mailedToken(email: string): Promise<string> {
    const { rows } = await handle.pool.query<{ id: string }>(
      `SELECT t.id FROM auth_email_tokens t JOIN auth_users u ON u.id = t.user_id
        WHERE u.email = $1 ORDER BY t.created_at DESC LIMIT 1`,
      [email],
    );
    const row = rows[0];
    return buildEmailToken(ctx.authSecret, row?.id ?? '');
  }

  try {
    // 1. The pages: a person's answers are never stored, never indexed, and the link page sends no referrer.
    for (const path of ['/account/login', '/en/account/register', '/account/forgot']) {
      const response = await page(path);
      check(
        `${path} is 200 with no-store, noindex and a form`,
        response.status === 200 &&
          response.cache.includes('no-store') &&
          response.robots.includes('noindex') &&
          response.html.includes('<form'),
      );
    }
    const link = await page('/account/set-password?t=garbage');
    check(
      'the link page opens without using the token and sends no referrer',
      link.status === 200 && link.referrer === 'no-referrer' && link.html.includes('<form'),
    );
    const noToken = await page('/account/set-password');
    check(
      'the link page without a token shows the refusal and no form',
      noToken.status === 200 && !noToken.html.includes('type="password"'),
    );
    const anonymous = await page('/account');
    check(
      '/account without a session redirects to the sign-in page (no account data)',
      anonymous.status >= 300 &&
        anonymous.status < 400 &&
        (anonymous.location ?? '').includes('/account/login'),
      brief(anonymous),
    );
    const english = await page('/en/account');
    check(
      '/en/account redirects to the English sign-in page',
      (english.location ?? '').includes('/en/account/login'),
      brief(english),
    );
    const home = await page('/');
    check(
      'the storefront header links to the account with no per-visitor markup',
      home.status === 200 && home.html.includes('href="/account"'),
      brief(home),
    );

    // 2. Registration is the same answer for a new and an existing address (no enumeration).
    const email = `smoke-${stamp}@example.test`;
    const jar: Jar = new Map();
    const first = await act(
      'registerAction',
      { email, locale: 'uk' },
      jar,
      newClient(),
      '/account/register',
    );
    const again = await act(
      'registerAction',
      { email, locale: 'uk' },
      jar,
      newClient(),
      '/account/register',
    );
    const garbage = await act(
      'registerAction',
      { email: 'nope', locale: 'uk' },
      jar,
      newClient(),
      '/account/register',
    );
    check(
      'register: a new address and a repeated one answer "sent"',
      first.body.includes('"status":"sent"') && again.body.includes('"status":"sent"'),
    );
    check(
      'register: garbage is an invalid-input error, nothing is sent',
      garbage.body.includes('"code":"invalid"'),
      brief(garbage),
    );
    const foreign = await act(
      'registerAction',
      { email: `x-${stamp}@example.test`, locale: 'uk' },
      jar,
      newClient(),
      '/account/register',
      { Origin: 'https://evil.example', 'X-Forwarded-Host': 'evil.example' },
    );
    check('register: a foreign Origin is refused', foreign.body.includes('"status":"error"'));

    // 3. Nobody signs in before the link is used; a forged link and a weak password change nothing.
    const early = await act(
      'customerLoginAction',
      { email, password: PASSWORD, locale: 'uk' },
      new Map(),
      newClient(),
    );
    check(
      'sign-in before the link is used is refused',
      early.redirect === null && early.body.includes('"code":"invalid"'),
    );
    const token = await mailedToken(email);
    const forged = await act(
      'setPasswordAction',
      { token: `${token.slice(0, -2)}AA`, password: PASSWORD, locale: 'uk' },
      new Map(),
      newClient(),
      '/account/set-password',
    );
    check(
      'a forged link is refused',
      forged.redirect === null && forged.body.includes('"code":"invalid"'),
    );
    const weak = await act(
      'setPasswordAction',
      { token, password: 'short', locale: 'uk' },
      new Map(),
      newClient(),
      '/account/set-password',
    );
    check('a weak password is refused without using the link', weak.body.includes('"code":"weak"'));
    const done = await act(
      'setPasswordAction',
      { token, password: PASSWORD, locale: 'uk' },
      new Map(),
      newClient(),
      '/account/set-password',
    );
    check(
      'the link sets the password and sends the person to sign in',
      (done.redirect ?? '').includes('/account/login?done=1'),
    );
    const replay = await act(
      'setPasswordAction',
      { token, password: 'another-password-77', locale: 'uk' },
      new Map(),
      newClient(),
      '/account/set-password',
    );
    check(
      'REPLAY: the same link twice is refused',
      replay.redirect === null && replay.body.includes('"code":"invalid"'),
    );

    // 4. Sign in: the cookie is HttpOnly, Lax and Secure on the production-like server; the page shows the account.
    const session: Jar = new Map();
    const bad = await act(
      'customerLoginAction',
      { email, password: 'wrong-password-xx', locale: 'uk' },
      new Map(),
      newClient(),
    );
    check(
      'a wrong password is the generic refusal',
      bad.redirect === null && bad.body.includes('"code":"invalid"'),
    );
    const signedIn = await act(
      'customerLoginAction',
      { email, password: PASSWORD, locale: 'uk' },
      session,
      newClient(),
    );
    check(
      'sign-in redirects to the account and sets an HttpOnly, SameSite=Lax, Secure __Host- cookie',
      (signedIn.redirect ?? '').startsWith('/account') &&
        /__Host-customer_session=[^;]+;.*HttpOnly/i.test(signedIn.setCookie) &&
        /SameSite=lax/i.test(signedIn.setCookie) &&
        /Secure/i.test(signedIn.setCookie),
      brief(signedIn),
    );
    const shop = await page('/', session);
    check(
      'the storefront answers a signed-in visitor with the same page: no address, no account state',
      shop.status === 200 && !shop.html.includes(email),
      brief(shop),
    );
    const linkWhileSignedIn = await page('/account/set-password?t=garbage', session);
    check(
      'a mailed link page still opens (the form, no redirect) for a signed-in visitor',
      linkWhileSignedIn.status === 200 && linkWhileSignedIn.html.includes('type="password"'),
      brief(linkWhileSignedIn),
    );
    const mine = await page('/account', session);
    check(
      '/account shows the signed-in address, no-store and noindex',
      mine.status === 200 &&
        mine.html.includes(email) &&
        mine.cache.includes('no-store') &&
        mine.robots.includes('noindex'),
    );
    const forgedPage = await page(
      '/account',
      new Map([
        ['__Host-customer_session', 'v1.00000000-0000-4000-8000-000000000000.9999999999.AAAA'],
      ]),
    );
    check('a forged cookie is no session', forgedPage.status !== 200, brief(forgedPage));
    const crossed = await page(
      '/admin',
      new Map([['admin_session', session.get('__Host-customer_session') ?? '']]),
    );
    check(
      'WALL: the customer cookie as an admin cookie opens nothing of the admin',
      !crossed.html.includes('admin-shell') && crossed.status !== 200,
    );

    // 5. Sign out ends the session on the server, not only in the browser.
    const stale = new Map(session);
    await act('customerLogoutAction', { locale: 'uk' }, session, newClient(), '/account');
    const afterOut = await page('/account', stale);
    check(
      'after sign-out the old cookie is no session (no address on the page)',
      !afterOut.html.includes(email) && afterOut.html.includes('/account/login'),
      brief(afterOut),
    );

    // 5b. The account's own data, with TWO customers: orders, the 404 for someone else's order, saved
    // sizes that never reach the shared product page, addresses, the newsletter, ownership of an address.
    const signUp = async (address: string): Promise<Jar> => {
      await act(
        'registerAction',
        { email: address, locale: 'uk' },
        new Map(),
        newClient(),
        '/account/register',
      );
      await act(
        'setPasswordAction',
        { token: await mailedToken(address), password: PASSWORD, locale: 'uk' },
        new Map(),
        newClient(),
        '/account/set-password',
      );
      const jarOf: Jar = new Map();
      await act(
        'customerLoginAction',
        { email: address, password: PASSWORD, locale: 'uk' },
        jarOf,
        newClient(),
      );
      return jarOf;
    };
    const emailA = `own-a-${stamp}@example.test`;
    const emailB = `own-b-${stamp}@example.test`;
    // Two seeded guest orders: one placed with A's address, one with B's, BEFORE the accounts exist.
    const { rows: seeded } = await handle.pool.query<{ id: string; order_number: string }>(
      `SELECT id, order_number FROM orders WHERE customer_id IS NULL ORDER BY created_at LIMIT 2`,
    );
    const [orderOfA, orderOfB] = seeded;
    if (orderOfA === undefined || orderOfB === undefined)
      throw new Error('the seed has no guest orders');
    await handle.pool.query(`UPDATE orders SET customer_email = $1 WHERE id = $2`, [
      emailA,
      orderOfA.id,
    ]);
    await handle.pool.query(`UPDATE orders SET customer_email = $1 WHERE id = $2`, [
      emailB,
      orderOfB.id,
    ]);
    const jarA = await signUp(emailA);
    const jarB = await signUp(emailB);
    const listA = await page('/account/orders', jarA);
    check(
      "orders: A sees the order placed with A's verified address and not B's",
      listA.html.includes(orderOfA.order_number) && !listA.html.includes(orderOfB.order_number),
      brief(listA),
    );
    const detailA = await page(`/account/orders/${orderOfA.order_number}`, jarA);
    check(
      'orders: A opens their own order',
      detailA.status === 200 && detailA.html.includes(orderOfA.order_number),
      brief(detailA),
    );
    const idor = await page(`/account/orders/${orderOfB.order_number}`, jarA);
    const missing = await page('/account/orders/LS-2026-999999', jarA);
    check(
      "IDOR: B's order number gives A the same 404 as a number that does not exist",
      idor.status === 404 && missing.status === 404 && !idor.html.includes(emailB),
      { idor: idor.status, missing: missing.status },
    );
    check(
      'the order page has no cost, admin note or other customer data',
      !/unitCost|unit_cost|adminNote|admin_note|accessTokenHash/.test(detailA.html),
    );
    check('an anonymous visitor gets no order list', (await page('/account/orders')).status >= 300);

    // 5a. Every account page renders TEXT, not message keys, in both languages (a client component whose namespace
    // is missing from the provider shows `account.something` and has no accessible name).
    const rawKey = /\baccount\.[a-z][A-Za-z.]*/;
    const accountPages = [
      '/account/orders',
      '/account/profile',
      '/account/addresses',
      '/account/wishlist',
      '/account/reviews',
    ];
    for (const prefix of ['', '/en']) {
      for (const path of [
        ...accountPages,
        '/account/login',
        '/account/register',
        '/account/forgot',
        '/account/set-password?t=x',
        '/unsubscribe?t=x',
      ]) {
        const jarFor =
          path.startsWith('/account/login') ||
          path.startsWith('/account/register') ||
          path.startsWith('/account/forgot') ||
          path.startsWith('/account/set-password') ||
          path.startsWith('/unsubscribe')
            ? new Map<string, string>()
            : jarA;
        const rendered = await page(`${prefix}${path}`, jarFor);
        check(
          `${prefix}${path} renders text, not raw message keys`,
          rendered.status === 200 &&
            !rawKey.test(rendered.html) &&
            !rendered.html.includes('MISSING_MESSAGE'),
          { status: rendered.status, raw: rawKey.exec(rendered.html)?.[0] },
        );
      }
    }

    // Actions: no session, foreign Origin, ownership.
    const noSession = await act(
      'addAddressAction',
      { deliveryMethod: 'ukrposhta' },
      new Map(),
      newClient(),
      '/account/addresses',
    );
    check(
      'an address action without a session is refused before the body is read',
      noSession.body.includes('"code":"unauthorized"'),
      brief(noSession),
    );
    const foreignAct = await act(
      'setNewsletterAction',
      { subscribe: true },
      jarA,
      newClient(),
      '/account/profile',
      { Origin: 'https://evil.example', 'X-Forwarded-Host': 'evil.example' },
    );
    check(
      'a customer action with a foreign Origin is refused',
      foreignAct.body.includes('"code":"error"'),
      brief(foreignAct),
    );
    const address = {
      deliveryMethod: 'ukrposhta',
      recipientName: 'Тест Покупець',
      phone: '0501234567',
      street: 'Хрещатик',
      house: '1',
      postcode: '01001',
      isDefault: true,
    };
    const added = await act('addAddressAction', address, jarA, newClient(), '/account/addresses');
    check('A saves an address', added.body.includes('"ok":true'), brief(added));
    const idMatch = /"value":"([0-9a-f-]{36})"/.exec(added.body);
    const addressId = idMatch?.[1] ?? '';
    const foreignDelete = await act(
      'deleteAddressAction',
      { id: addressId },
      jarB,
      newClient(),
      '/account/addresses',
    );
    check(
      "IDOR: B cannot delete A's address (not found)",
      foreignDelete.body.includes('"code":"notFound"') && addressId !== '',
      brief(foreignDelete),
    );
    const listAddr = await page('/account/addresses', jarB);
    check("B's address book does not show A's street", !listAddr.html.includes('Хрещатик'));
    const ownDelete = await act(
      'deleteAddressAction',
      { id: addressId },
      jarA,
      newClient(),
      '/account/addresses',
    );
    check('A deletes their own address', ownDelete.body.includes('"ok":true'), brief(ownDelete));
    const subscribed = await act(
      'setNewsletterAction',
      { subscribe: true },
      jarA,
      newClient(),
      '/account/profile',
    );
    const { rows: consent } = await handle.pool.query<{
      source: string | null;
      confirmed: boolean;
    }>(
      `SELECT source, confirmed_at IS NOT NULL AS confirmed FROM newsletter_subscribers WHERE email = $1`,
      [emailA],
    );
    check(
      'newsletter: the consent row records the source and the time',
      subscribed.body.includes('"ok":true') &&
        consent[0]?.source === 'account' &&
        consent[0].confirmed,
      consent,
    );

    // Saved sizes: the cookie is set, the shared product page does not change.
    const { rows: sizeRows } = await handle.pool.query<{ id: string; label: string }>(
      `SELECT id, label FROM sizes WHERE system = 'apparel' ORDER BY sort_order LIMIT 1`,
    );
    const size = sizeRows[0];
    if (size !== undefined) {
      const saved = await act(
        'saveSizesAction',
        { braSizeId: null, apparelSizeId: size.id },
        jarA,
        newClient(),
        '/account/profile',
      );
      // The WIRE value of the real Set-Cookie must read back as the saved size (it was once double-encoded).
      const wire = /silk_sizes=([^;]+)/.exec(saved.setCookie)?.[1];
      check(
        'saving sizes sets a silk_sizes cookie that the browser-side parser reads back as the saved size',
        saved.body.includes('"ok":true') && parseSizesCookie(wire).apparel === size.label,
        { wire, label: size.label },
      );
      const refused = await act(
        'reorderAction',
        { orderNumber: orderOfA.order_number },
        new Map(),
        newClient(),
        '/account/orders',
        { Origin: 'https://evil.example', 'X-Forwarded-Host': 'evil.example' },
      );
      check(
        'reorder: a refused call (foreign Origin) sets no cart cookie',
        !/silk_cart/.test(refused.setCookie),
        brief(refused),
      );
      const homeHtml = await (await fetch(`${base}/`)).text();
      const productPath = /href="(\/product\/[^"]+)"/.exec(homeHtml)?.[1] ?? '/';
      const anon = await fetch(base + productPath);
      const signed = await fetch(base + productPath, {
        headers: { Cookie: cookieHeader(jarA) },
      });
      const [anonHtml, signedHtml] = [await anon.text(), await signed.text()];
      check(
        'CACHE: the product page is byte-identical for a signed-in visitor with saved sizes (no personal markup)',
        anonHtml === signedHtml && !signedHtml.includes(emailA),
        { same: anonHtml === signedHtml, signedCache: signed.headers.get('x-nextjs-cache') },
      );
    }

    // 5c. Wishlist and back-in-stock alerts, again with two customers.
    const { rows: products } = await handle.pool.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM products WHERE is_active AND published_at <= now() ORDER BY created_at LIMIT 1`,
    );
    const product = products[0];
    // Next only accepts an action id on a page whose bundle holds it: the product page has the buttons.
    const actionPath = product === undefined ? '/' : `/product/${product.slug}`;
    if (product !== undefined) {
      const added2 = await act(
        'addToWishlistAction',
        { productId: product.id },
        jarA,
        newClient(),
        actionPath,
      );
      check('wishlist: A adds a product', added2.body.includes('"ok":true'), brief(added2));
      const wishA = await page('/account/wishlist', jarA);
      const wishB = await page('/account/wishlist', jarB);
      check(
        'wishlist: A sees it, B does not',
        wishA.html.includes(product.slug) && !wishB.html.includes(`/product/${product.slug}`),
      );
      const bad = await act(
        'addToWishlistAction',
        { productId: '00000000-0000-4000-8000-000000000000' },
        jarA,
        newClient(),
        actionPath,
      );
      check(
        'wishlist: an unknown product is "not found"',
        bad.body.includes('"code":"notFound"'),
        brief(bad),
      );
      const anon = await act(
        'addToWishlistAction',
        { productId: product.id },
        new Map(),
        newClient(),
        actionPath,
      );
      check(
        'wishlist: no session gives "unauthorized"',
        anon.body.includes('"code":"unauthorized"'),
      );
    }
    const { rows: soldOut } = await handle.pool.query<{ id: string }>(
      `SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE v.is_active AND v.stock_quantity - v.reserved_quantity <= 0 AND p.is_active
          AND p.kind = 'physical' AND p.published_at <= now() LIMIT 1`,
    );
    const soldOutId = soldOut[0]?.id;
    if (soldOutId !== undefined) {
      const sub = await act(
        'subscribeStockAlertAction',
        { variantId: soldOutId },
        jarA,
        newClient(),
        actionPath,
      );
      const alertId = /"value":"([0-9a-f-]{36})"/.exec(sub.body)?.[1] ?? '';
      check(
        'alerts: A follows a sold-out size',
        sub.body.includes('"ok":true') && alertId !== '',
        brief(sub),
      );
      const { rows: stored } = await handle.pool.query<{ email: string }>(
        `SELECT email FROM stock_notifications WHERE id = $1`,
        [alertId],
      );
      check(
        'alerts: the alert belongs to the signed-in address, never one from the request',
        stored[0]?.email === emailA,
        stored,
      );
      const stranger = await act(
        'cancelStockAlertAction',
        { id: alertId },
        jarB,
        newClient(),
        '/account/wishlist',
      );
      const { rows: still } = await handle.pool.query(
        `SELECT 1 FROM stock_notifications WHERE id = $1`,
        [alertId],
      );
      check(
        "IDOR: B cannot remove A's alert (nothing deleted)",
        stranger.body.includes('"value":false') && still.length === 1,
        brief(stranger),
      );
      const link = await page(
        `/unsubscribe?t=${encodeURIComponent(buildUnsubscribeToken(ctx.authSecret, alertId))}`,
      );
      check(
        'unsubscribe page: opening the link deletes nothing, is no-store, sends no referrer',
        link.status === 200 && link.cache.includes('no-store') && link.referrer === 'no-referrer',
        brief(link),
      );
      const { rows: afterOpen } = await handle.pool.query(
        `SELECT 1 FROM stock_notifications WHERE id = $1`,
        [alertId],
      );
      check('unsubscribe: a GET changed nothing', afterOpen.length === 1);
      const forged = await act(
        'unsubscribeStockAlertAction',
        { token: `${alertId}.${'A'.repeat(43)}` },
        new Map(),
        newClient(),
        '/unsubscribe',
      );
      check(
        'unsubscribe: a forged token does nothing',
        forged.body.includes('"code":"invalid"'),
        brief(forged),
      );
      const real = await act(
        'unsubscribeStockAlertAction',
        { token: buildUnsubscribeToken(ctx.authSecret, alertId) },
        new Map(),
        newClient(),
        '/unsubscribe',
      );
      const { rows: gone } = await handle.pool.query(
        `SELECT 1 FROM stock_notifications WHERE id = $1`,
        [alertId],
      );
      check(
        'unsubscribe: the signed link removes the alert without a session',
        real.body.includes('"status":"done"') && gone.length === 0,
        brief(real),
      );
    }

    // 6. Limits: mails and sign-in attempts from one client run out.
    const hammer = newClient();
    let mailLimited = false;
    for (let i = 0; i < 12; i += 1) {
      const result = await act(
        'forgotPasswordAction',
        { email: `limit-${stamp}-${String(i)}@example.test`, locale: 'uk' },
        new Map(),
        hammer,
        '/account/forgot',
      );
      if (result.body.includes('"code":"rateLimited"') || result.status === 429) mailLimited = true;
    }
    check('mail requests from one client are rate limited', mailLimited);
    const guesser = newClient();
    let loginLimited = false;
    for (let i = 0; i < 14; i += 1) {
      const result = await act(
        'customerLoginAction',
        { email: `nobody-${stamp}@example.test`, password: 'wrong-password-xx', locale: 'uk' },
        new Map(),
        guesser,
      );
      if (result.body.includes('"code":"rateLimited"') || result.status === 429)
        loginLimited = true;
    }
    check('sign-in attempts from one client are rate limited', loginLimited);
  } finally {
    await handle.close();
  }
}
