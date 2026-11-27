/**
 * Phase 4 slice 2 on the BUILT app (called from smoke-web.ts): the admin's headers, limits,
 * redirects, theme without flash, sessions read from the database, and the guarantee that none of
 * it reaches the storefront. Sessions are minted with the same core functions the login uses, so
 * the cookie the server receives is a real one; forged, revoked and deactivated sessions are
 * tried against the real server too.
 */
import en from '../apps/web/messages/en.json' with { type: 'json' };
import uk from '../apps/web/messages/uk.json' with { type: 'json' };
import { actionIds } from './smoke-http.ts';
import { createDb } from '../packages/db/src/client.ts';
import { redirects } from '../packages/db/src/schema.ts';
import { recordGone } from '../packages/core/src/catalog-admin/redirects.ts';
import {
  beginLogin,
  confirmTotpEnrolment,
  createAdminUser,
  resolveSession,
  revokeAllSessions,
  startTotpEnrolment,
} from '../packages/core/src/auth/service.ts';
import { samplePhoto } from '../packages/media/test/sample-image.ts';
import type { FakeS3 } from '../packages/media/test/fake-s3.ts';
import {
  auditLog,
  categories,
  orderItems,
  orders,
  productImages,
  productVariants,
  products,
  returnRequestItems,
  returnRequests,
  reviews,
} from '../packages/db/src/schema.ts';
import net from 'node:net';

import { codeAt, stepOf } from '../packages/core/src/auth/totp.ts';

interface Context {
  base: string;
  databaseUrl: string;
  authSecret: string;
  buildRoot: string;
  fakeS3: FakeS3;
  /** The configured SITE_URL: an action's Origin must carry its host. */
  siteOrigin: string;
  check: (name: string, ok: boolean) => void;
  storedFiles: () => number;
}

const PASSWORD = 'smoke-admin-password-0123456789';
const client = { ip: '198.51.100.77', userAgent: 'smoke-admin' };

export async function runAdminSmoke({
  base,
  databaseUrl,
  authSecret,
  buildRoot,
  fakeS3,
  siteOrigin,
  check,
  storedFiles,
}: Context): Promise<void> {
  const config = { secret: authSecret };
  const { db, close } = createDb(databaseUrl, { max: 2 });
  const suffix = String(Date.now());
  let counter = 0;
  const nextClient = (): string => `203.0.113.${String(++counter + 10)}`;

  const get = async (path: string, headers: Record<string, string> = {}, method = 'GET') => {
    const response = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: { 'X-Forwarded-For': nextClient(), ...headers },
    });
    return {
      status: response.status,
      location: response.headers.get('location'),
      cache: response.headers.get('cache-control') ?? '',
      nextCache: response.headers.get('x-nextjs-cache') ?? '',
      robots: response.headers.get('x-robots-tag') ?? '',
      html: await response.text(),
    };
  };
  const cookie = (token: string): Record<string, string> => ({ Cookie: `admin_session=${token}` });

  const ids = actionIds(buildRoot);
  const origin = (): Record<string, string> => ({
    Origin: siteOrigin,
    // Next itself compares Origin with the forwarded host; behind a real proxy that is the site host.
    'X-Forwarded-Host': new URL(siteOrigin).host,
  });
  /** A server action with plain arguments, the way the forms post it. */
  const form = async (
    name: string,
    args: Record<string, unknown>,
    headers: Record<string, string> = {},
    path = '/admin/login',
  ) => {
    const response = await fetch(base + path, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Next-Action': ids[name] ?? '',
        'Content-Type': 'text/plain;charset=UTF-8',
        'X-Forwarded-For': nextClient(),
        ...origin(),
        ...headers,
      },
      body: JSON.stringify([args]),
    });
    return {
      status: response.status,
      redirect: response.headers.get('x-action-redirect'),
      cookies: response.headers.getSetCookie(),
      body: await response.text(),
    };
  };
  /** A no-argument-or-FormData action posted the progressive-enhancement way (a plain form). */
  const plainForm = async (
    name: string,
    fields: Record<string, string>,
    headers: Record<string, string> = {},
    path = '/admin',
  ) => {
    const body = new FormData();
    body.set(`$ACTION_ID_${ids[name] ?? ''}`, '');
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    const response = await fetch(base + path, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'X-Forwarded-For': nextClient(), ...origin(), ...headers },
      body,
    });
    return {
      status: response.status,
      location: response.headers.get('location'),
      cookies: response.headers.getSetCookie(),
    };
  };

  try {
    // A manager signs in with the password alone; an owner needs TOTP.
    const manager = `manager-${suffix}@example.test`;
    const owner = `owner-${suffix}@example.test`;
    const contentEmail = `messages-content-${suffix}@example.test`;
    await db.transaction(async (tx) => {
      await createAdminUser(tx, { email: manager, password: PASSWORD, role: 'manager' });
      await createAdminUser(tx, { email: owner, password: PASSWORD, role: 'owner' });
      await createAdminUser(tx, { email: contentEmail, password: PASSWORD, role: 'content' });
    });
    const contentLogin = await db.transaction(
      async (tx) =>
        await beginLogin(tx, config, { email: contentEmail, password: PASSWORD, client }),
    );
    if (!contentLogin.ok) throw new Error('smoke content account could not sign in');
    const managerLogin = await db.transaction(
      async (tx) => await beginLogin(tx, config, { email: manager, password: PASSWORD, client }),
    );
    const ownerPending = await db.transaction(
      async (tx) => await beginLogin(tx, config, { email: owner, password: PASSWORD, client }),
    );
    if (!managerLogin.ok || !ownerPending.ok) throw new Error('smoke accounts could not sign in');
    const enrol = await db.transaction(
      async (tx) => await startTotpEnrolment(tx, config, { token: ownerPending.token }),
    );
    if (enrol === null) throw new Error('smoke enrolment failed');
    const ownerFull = await db.transaction(
      async (tx) =>
        await confirmTotpEnrolment(tx, config, {
          token: ownerPending.token,
          code: codeAt(enrol.secret, stepOf(Date.now())),
          client,
        }),
    );
    if (!ownerFull.ok) throw new Error('smoke owner could not complete enrolment');

    // 1. Not signed in: a redirect to the login, never indexed or stored.
    const anonymous = await get('/admin');
    check(
      'admin: no cookie redirects to /admin/login, no-store and noindex',
      anonymous.status === 307 &&
        new URL(anonymous.location ?? 'x:', base).pathname === '/admin/login' &&
        anonymous.cache.includes('no-store') &&
        anonymous.robots.includes('noindex'),
    );
    const login = await get('/admin/login');
    check(
      'admin: the login page is 200, private no-store, noindex, with its own html and the system theme',
      login.status === 200 &&
        login.cache.includes('private') &&
        login.cache.includes('no-store') &&
        login.robots.includes('noindex') &&
        login.html.includes('data-theme="system"') &&
        login.html.includes('<html lang="uk"'),
    );
    const spelled = await get('/%61dmin/login');
    check(
      'admin: an encoded spelling gets the same headers',
      spelled.cache.includes('no-store') && spelled.robots.includes('noindex'),
    );

    // 2. Theme and language come from cookies, so the first paint is already right.
    const dark = await get('/admin/login', { Cookie: 'admin_theme=dark; admin_locale=en' });
    check(
      'admin: the theme cookie sets data-theme on the first HTML, no script needed',
      dark.html.includes('data-theme="dark"') && dark.html.includes('<html lang="en"'),
    );
    const junk = await get('/admin/login', { Cookie: 'admin_theme="><script>x</script>' });
    check(
      'admin: a junk theme cookie falls back to system and is never echoed',
      junk.html.includes('data-theme="system"') && !junk.html.includes('<script>x</script>'),
    );

    // 2b. Client message namespaces are per visitor (phase 11 review S1): the payload carries only what the
    // role may open. Promo text goes to nobody without `promo.view`, the import hint (it names the cost
    // column) to nobody without `catalog.import`, and an anonymous visitor gets the login flow only.
    const IMPORT_MARKER = 'cost_price, weight_grams';
    const promoMarkers = [
      'PROMO_LOCKED',
      'excludesGiftCards',
      uk.admin.promo.bulkDeactivate,
      en.admin.promo.capHint,
    ];
    const contentHome = await get('/admin', cookie(contentLogin.token));
    const managerPage = await get('/admin', cookie(managerLogin.token));
    const ownerPage = await get('/admin', cookie(ownerFull.token));
    check(
      'admin messages: anonymous and content get no promo text; manager no import hint; owner has both',
      contentHome.status === 200 &&
        promoMarkers.every(
          (marker) => !login.html.includes(marker) && !contentHome.html.includes(marker),
        ) &&
        !managerPage.html.includes(IMPORT_MARKER) &&
        managerPage.html.includes('PROMO_LOCKED') &&
        ownerPage.html.includes(IMPORT_MARKER),
    );

    // 3. Sessions are read from the database.
    const ok = await get('/admin', cookie(managerLogin.token));
    check(
      'admin: a real manager session sees the dashboard with email and role',
      ok.status === 200 &&
        ok.html.includes(manager) &&
        ok.cache.includes('no-store') &&
        ok.html.includes('Менеджер'),
    );
    const tampered = await get('/admin', cookie(`${managerLogin.token.slice(0, -2)}xx`));
    check(
      'admin: a tampered token is redirected to the login (the proxy lets it pass, the page refuses)',
      tampered.status === 307 &&
        new URL(tampered.location ?? 'x:', base).pathname === '/admin/login',
    );
    const pendingOnly = await get('/admin', cookie(ownerPending.token));
    check(
      'admin: a pending (password-only) owner session never reaches the dashboard',
      pendingOnly.status !== 200 || !pendingOnly.html.includes(owner),
    );
    const ownerOk = await get('/admin', cookie(ownerFull.token));
    check(
      'admin: an owner with a confirmed TOTP sees the dashboard',
      ownerOk.status === 200 && ownerOk.html.includes(owner),
    );

    // 3b. The login action itself: a real sign-in, a wrong password, and a foreign Origin.
    const good = await form('loginAction', { email: manager, password: PASSWORD });
    check(
      'admin login action: the right password redirects and sets an HttpOnly, SameSite=Strict, Path=/admin cookie',
      (good.redirect ?? '').includes('/admin') &&
        good.cookies.some(
          (c) =>
            c.startsWith('admin_session=') &&
            /HttpOnly/i.test(c) &&
            /SameSite=Strict/i.test(c) &&
            /Path=\/admin/i.test(c),
        ),
    );
    const bad = await form('loginAction', { email: manager, password: 'wrong-password-wrong' });
    check(
      'admin login action: a wrong password answers "invalid" and sets no cookie',
      bad.body.includes('"code":"invalid"') &&
        !bad.cookies.some((c) => c.startsWith('admin_session=')),
    );
    const unknown = await form('loginAction', {
      email: `nobody-${suffix}@example.test`,
      password: PASSWORD,
    });
    check(
      'admin login action: an unknown account is answered exactly like a wrong password',
      unknown.body.includes('"code":"invalid"') && unknown.body.length === bad.body.length,
    );
    const foreign = await form(
      'loginAction',
      { email: manager, password: PASSWORD },
      { Origin: 'https://evil.example' },
    );
    check(
      'admin login action: a foreign Origin is refused (no redirect, no cookie)',
      foreign.redirect === null && !foreign.cookies.some((c) => c.startsWith('admin_session=')),
    );

    // 3b2. "Sign out other devices" goes through adminAction: Origin, session, audit.
    const second = await db.transaction(
      async (tx) => await beginLogin(tx, config, { email: manager, password: PASSWORD, client }),
    );
    if (!second.ok) throw new Error('second manager session failed');
    const others = await form('signOutOtherSessionsAction', {}, cookie(managerLogin.token));
    check(
      'admin action: sign out other devices ends the other session and keeps this one',
      others.body.includes('"ok":true') &&
        (await get('/admin', cookie(second.token))).status === 307 &&
        (await get('/admin', cookie(managerLogin.token))).status === 200,
    );
    const anon = await form('signOutOtherSessionsAction', {});
    check(
      'admin action: without a session it answers UNAUTHENTICATED',
      anon.body.includes('UNAUTHENTICATED'),
    );
    const csrf = await form(
      'signOutOtherSessionsAction',
      {},
      {
        ...cookie(managerLogin.token),
        Origin: 'https://evil.example',
        'X-Forwarded-Host': 'evil.example',
      },
    );
    check(
      'admin action: a foreign Origin is refused and the session is untouched',
      !csrf.body.includes('"ok":true') &&
        (await get('/admin', cookie(managerLogin.token))).status === 200,
    );

    // 3c. The theme switch is a cookie set by a server action, checked for Origin and value.
    const themed = await plainForm('setThemeAction', { theme: 'dark' });
    check(
      'admin theme action: sets admin_theme=dark scoped to /admin',
      themed.cookies.some((c) => c.startsWith('admin_theme=dark') && /Path=\/admin/i.test(c)),
    );
    const themedBad = await plainForm('setThemeAction', { theme: '"><script>' });
    check(
      'admin theme action: a value outside the list is stored as the default, never as sent',
      themedBad.cookies.some((c) => c.startsWith('admin_theme=system')) &&
        !themedBad.cookies.some((c) => c.includes('script')),
    );
    const themedForeign = await plainForm(
      'setThemeAction',
      { theme: 'dark' },
      { Origin: 'https://evil.example', 'X-Forwarded-Host': 'evil.example' },
    );
    check(
      'admin theme action: a foreign Origin sets no cookie',
      !themedForeign.cookies.some((c) => c.startsWith('admin_theme=')),
    );

    // 4. Revocation and deactivation take effect at once.
    const live = await resolveSession(db, config, managerLogin.token);
    if (live === null) throw new Error('the manager session should still be live');
    await db.transaction(async (tx) => {
      await revokeAllSessions(tx, live.session.userId);
    });
    const revoked = await get('/admin', cookie(managerLogin.token));
    check(
      'admin: a revoked session is refused on the next request',
      revoked.status === 307 || !revoked.html.includes(manager),
    );

    // 5. Limits: every method but OPTIONS, every spelling, per client.
    const fixed = { 'X-Forwarded-For': '192.0.2.200' };
    let limited = 0;
    for (let i = 0; i < 40; i += 1) {
      const path = i % 2 === 0 ? '/admin/login' : '/%61dmin/login';
      const r = await get(path, fixed, i % 3 === 0 ? 'POST' : 'GET');
      if (r.status === 429) limited += 1;
    }
    check('admin: the credential pages are limited per client (429 after 30)', limited >= 8);
    const options = await get('/admin/login', fixed, 'OPTIONS');
    check('admin: OPTIONS is not counted against the limit', options.status !== 429);
    const other = await get('/admin/login');
    check('admin: another client is not affected by that limit', other.status === 200);

    // 5b. Catalog mutations: the role is checked INSIDE the action, on a direct POST.
    const roleUsers = new Map<string, string>();
    await db.transaction(async (tx) => {
      for (const role of ['content', 'admin'] as const) {
        const email = `${role}-${suffix}@example.test`;
        await createAdminUser(tx, { email, password: PASSWORD, role });
        roleUsers.set(role, email);
      }
    });
    const sessionOf = async (role: 'content' | 'admin' | 'manager'): Promise<string> => {
      const email = role === 'manager' ? manager : (roleUsers.get(role) ?? '');
      const result = await db.transaction(
        async (tx) => await beginLogin(tx, config, { email, password: PASSWORD, client }),
      );
      if (!result.ok) throw new Error(`no session for ${role}`);
      if (result.next !== 'done') {
        const started = await db.transaction(
          async (tx) => await startTotpEnrolment(tx, config, { token: result.token }),
        );
        if (started === null) throw new Error('enrolment failed');
        const full = await db.transaction(
          async (tx) =>
            await confirmTotpEnrolment(tx, config, {
              token: result.token,
              code: codeAt(started.secret, stepOf(Date.now())),
              client,
            }),
        );
        if (!full.ok) throw new Error('enrolment confirm failed');
        return full.token;
      }
      return result.token;
    };
    const contentToken = await sessionOf('content');
    const adminToken = await sessionOf('admin');
    const managerToken = await sessionOf('manager');
    // Read through the schema and filter in JS: the repository root has no drizzle-orm operators.
    const productRow = async (id: string) =>
      (await db.select().from(products)).find((row) => row.id === id);
    const active = (await db.select().from(products)).filter((row) => row.isActive);
    const target = active[0];
    const bystander = active[1];
    if (target === undefined || bystander === undefined)
      throw new Error('the seed has no products');
    const original = await productRow(target.id);

    const contentPrice = await form(
      'updateProductPricingAction',
      { productId: target.id, basePrice: '1.00' },
      cookie(contentToken),
      '/admin/products',
    );
    const afterContent = await productRow(target.id);
    check(
      'catalog: a content role POSTing a price directly is FORBIDDEN and the price is unchanged',
      contentPrice.body.includes('FORBIDDEN') && afterContent?.basePrice === original?.basePrice,
    );
    const managerEdit = await form(
      'updateProductContentAction',
      { productId: target.id, nameUk: 'Не повинно зберегтись' },
      cookie(managerToken),
      '/admin/products',
    );
    check(
      'catalog: a manager cannot edit product text either',
      managerEdit.body.includes('FORBIDDEN') &&
        (await productRow(target.id))?.nameUk === original?.nameUk,
    );
    const contentEdit = await form(
      'updateProductContentAction',
      { productId: target.id, nameEn: `Edited ${suffix}` },
      cookie(contentToken),
      '/admin/products',
    );
    check(
      'catalog: a content role may edit text',
      contentEdit.body.includes('"ok":true') &&
        (await productRow(target.id))?.nameEn === `Edited ${suffix}`,
    );
    const anonymousPrice = await form(
      'updateProductPricingAction',
      { productId: target.id, basePrice: '1.00' },
      {},
      '/admin/products',
    );
    check(
      'catalog: without a session the same POST is UNAUTHENTICATED',
      anonymousPrice.body.includes('UNAUTHENTICATED'),
    );

    // The serialized pages per role: the cost exists only for owner and admin.
    const costValue = '123.45';
    const adminSetsCost = await form(
      'updateProductPricingAction',
      { productId: target.id, costPrice: costValue },
      cookie(adminToken),
      '/admin/products',
    );
    check('catalog: an admin sets the cost', adminSetsCost.body.includes('"ok":true'));
    const pageFor = async (token: string) =>
      await get(`/admin/products/${target.id}`, cookie(token));
    const listFor = async (token: string) => await get('/admin/products', cookie(token));
    const adminPage = await pageFor(adminToken);
    const contentPage = await pageFor(contentToken);
    check(
      'catalog: the editor page of an admin carries the cost, that of a content role carries neither the key nor the value',
      adminPage.html.includes('123.45') &&
        !contentPage.html.includes('123.45') &&
        !contentPage.html.includes('costPrice'),
    );
    const costHeader = /<th[^>]*>Собівартість<\/th>/;
    const adminList = await listFor(adminToken);
    const managerList = await listFor(managerToken);
    check(
      'catalog: the product list shows the cost column to an admin and neither the column nor the value to a manager',
      costHeader.test(adminList.html) &&
        !costHeader.test(managerList.html) &&
        !managerList.html.includes('costPrice') &&
        !managerList.html.includes('123,45'),
    );

    // Orders: the same role rules on the real pages and the direct POSTs (phase 5).
    const orderNumber = `LS-2026-${suffix.slice(-6)}`;
    const [order] = await db
      .insert(orders)
      .values({
        orderNumber,
        customerEmail: 'smoke-buyer@example.test',
        customerPhone: '+380501112299',
        customerName: 'Smoke Buyer',
        deliveryMethod: 'pickup',
        subtotal: 100_000,
        total: 100_000,
        ip: '198.51.100.77',
      })
      .returning({ id: orders.id });
    if (order === undefined) throw new Error('smoke order was not inserted');
    await db.insert(orderItems).values({
      orderId: order.id,
      productUidSnapshot: target.id,
      variantUidSnapshot: target.id,
      nameSnapshot: 'Smoke item',
      skuSnapshot: 'SMOKE-1',
      sizeLabel: 'S',
      colorName: 'Black',
      unitPrice: 100_000,
      quantity: 1,
      lineTotal: 100_000,
      unitCostSnapshot: 987_654,
    });
    const orderList = async (token: string) => await get('/admin/orders', cookie(token));
    const orderCard = async (token: string) =>
      await get(`/admin/orders/${order.id}`, cookie(token));
    const ordersPage = await orderList(managerToken);
    const managerCard = await orderCard(managerToken);
    check(
      'orders: a manager lists and opens an order',
      ordersPage.status === 200 &&
        ordersPage.html.includes(orderNumber) &&
        managerCard.status === 200 &&
        managerCard.html.includes(orderNumber),
    );
    // The pages stream behind the loading boundary, so a `notFound()` may arrive as a 200 shell that
    // carries the not-found marker: what matters is that no order data is in the response.
    const hidden = (page: { status: number; html: string }): boolean =>
      !page.html.includes(orderNumber) &&
      !page.html.includes('Smoke Buyer') &&
      (page.status === 404 || page.html.includes('NEXT_HTTP_ERROR_FALLBACK;404'));
    check(
      'orders: a content role gets the not-found page, with no order data, for the list and the card',
      hidden(await orderList(contentToken)) && hidden(await orderCard(contentToken)),
    );
    const costHeading = /<th[^>]*>Собівартість<\/th>/;
    const managerOrder = managerCard;
    const adminOrder = await orderCard(adminToken);
    check(
      'orders: the card shows the unit cost to an admin and neither the column, the value nor the buyer IP to a manager',
      costHeading.test(adminOrder.html) &&
        !costHeading.test(managerOrder.html) &&
        !managerOrder.html.includes('987654') &&
        !managerOrder.html.includes('9876,54') &&
        !adminOrder.html.includes('198.51.100.77') &&
        !managerOrder.html.includes('198.51.100.77'),
    );
    const contentCancel = await form(
      'cancelOrderAction',
      { orderId: order.id, reason: 'content tries it' },
      cookie(contentToken),
      '/admin/orders',
    );
    const noReason = await form(
      'cancelOrderAction',
      { orderId: order.id },
      cookie(managerToken),
      '/admin/orders',
    );
    const statusNow = async () =>
      (await db.select().from(orders)).find((row) => row.id === order.id)?.status;
    check(
      'orders: a content POST is FORBIDDEN, a cancellation without a reason is refused, and the order is untouched',
      contentCancel.body.includes('FORBIDDEN') &&
        noReason.body.includes('INVALID_INPUT') &&
        (await statusNow()) === 'pending',
    );
    const cancelled = await form(
      'cancelOrderAction',
      { orderId: order.id, reason: 'smoke test cancellation' },
      cookie(managerToken),
      '/admin/orders',
    );
    check(
      'orders: a manager cancels with a reason; the order is cancelled',
      cancelled.body.includes('"ok":true') && (await statusNow()) === 'cancelled',
    );
    // Reviews (phase 7): who moderates, what a decision changes, and that the cached product page follows.
    const pendingReview = (await db.select().from(reviews)).find(
      (row) => !row.isApproved && row.rejectedAt === null,
    );
    if (pendingReview !== undefined) {
      const reviewProduct = (await db.select().from(products)).find(
        (row) => row.id === pendingReview.productId,
      );
      const reviewPath = `/product/${reviewProduct?.slug ?? ''}`;
      const before = await (await fetch(base + reviewPath)).text();
      const queue = await get('/admin/reviews', cookie(contentToken));
      const managerQueue = await get('/admin/reviews', cookie(managerToken));
      check(
        'reviews: a content role sees the queue; a manager gets the not-found page with no review data',
        queue.status === 200 &&
          queue.html.includes('type="button"') &&
          !managerQueue.html.includes(pendingReview.body ?? 'no-body-marker'),
      );
      const refusedDecision = await form(
        'decideReviewAction',
        { id: pendingReview.id, decision: 'approve' },
        cookie(managerToken),
        '/admin/reviews',
      );
      const stillPending = (await db.select().from(reviews)).find(
        (row) => row.id === pendingReview.id,
      );
      check(
        'reviews: a manager cannot approve (FORBIDDEN) and the review stays pending',
        refusedDecision.body.includes('FORBIDDEN') && stillPending?.isApproved === false,
      );
      const approved = await form(
        'decideReviewAction',
        { id: pendingReview.id, decision: 'approve' },
        cookie(contentToken),
        '/admin/reviews',
      );
      // `revalidateTag(tag, 'max')` serves the stale page once while it refreshes: fetch until it shows the text.
      let after = await (await fetch(base + reviewPath)).text();
      for (let i = 0; i < 20 && !after.includes(pendingReview.body ?? 'x-no-body'); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        after = await (await fetch(base + reviewPath)).text();
      }
      const nowApproved = (await db.select().from(reviews)).find(
        (row) => row.id === pendingReview.id,
      );
      check(
        'reviews: a content role approves; the product page shows the text after the commit and the counters moved',
        approved.body.includes('"ok":true') &&
          nowApproved?.isApproved === true &&
          !before.includes(pendingReview.body ?? 'x-no-body') &&
          after.includes(pendingReview.body ?? 'x-no-body') &&
          /data-review-count="\d+"/.test(after),
      );
      const ratingLd = [...after.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)]
        .map((match) => match[1] ?? '')
        .find((json) => json.includes('aggregateRating'));
      const visible = /data-review-count="(\d+)"/.exec(after)?.[1];
      check(
        'reviews: the AggregateRating markup equals the visible review count',
        ratingLd !== undefined && ratingLd.includes(`"reviewCount":${visible ?? 'none'}`),
      );
      const rejected = await form(
        'decideReviewAction',
        { id: pendingReview.id, decision: 'reject' },
        cookie(contentToken),
        '/admin/reviews',
      );
      let gone = await (await fetch(base + reviewPath)).text();
      for (let i = 0; i < 20 && gone.includes(pendingReview.body ?? 'x-no-body'); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        gone = await (await fetch(base + reviewPath)).text();
      }
      check(
        'reviews: refusing it again removes the text from the product page',
        rejected.body.includes('"ok":true') && !gone.includes(pendingReview.body ?? 'x-no-body'),
      );
    }
    // Returns (phase 7): the review needs `returns.manage`, the receipt is the only step that moves stock.
    const openReturn = (await db.select().from(returnRequests)).find(
      (row) => row.status === 'requested',
    );
    if (openReturn !== undefined) {
      const returnLine = (await db.select().from(returnRequestItems)).find(
        (row) => row.returnRequestId === openReturn.id,
      );
      const orderLine = (await db.select().from(orderItems)).find(
        (row) => row.id === returnLine?.orderItemId,
      );
      const variantNow = async (): Promise<number> =>
        (await db.select().from(productVariants)).find((row) => row.id === orderLine?.variantId)
          ?.stockQuantity ?? -1;
      const returnPath = `/admin/returns/${openReturn.id}`;
      const contentList = await get('/admin/returns', cookie(contentToken));
      const managerList = await get('/admin/returns', cookie(managerToken));
      check(
        'returns: a manager sees the queue; a content role gets the not-found page with no return data',
        managerList.status === 200 && !contentList.html.includes(openReturn.requestNumber),
      );
      const forbidden = await form(
        'approveReturnAction',
        { id: openReturn.id, restock: true },
        cookie(contentToken),
        returnPath,
      );
      check(
        'returns: a content role cannot approve (FORBIDDEN)',
        forbidden.body.includes('FORBIDDEN'),
      );
      const stockBefore = await variantNow();
      const approvedReturn = await form(
        'approveReturnAction',
        { id: openReturn.id, restock: true },
        cookie(managerToken),
        returnPath,
      );
      check(
        'returns: a manager approves; stock is unchanged by an approval',
        approvedReturn.body.includes('"ok":true') && (await variantNow()) === stockBefore,
      );
      const early = await form(
        'refundReturnAction',
        { id: openReturn.id },
        cookie(adminToken),
        returnPath,
      );
      check('returns: a refund before the receipt is refused', !early.body.includes('"ok":true'));
      const receipt = {
        id: openReturn.id,
        items: [{ itemId: returnLine?.id ?? '', receivedQuantity: returnLine?.quantity ?? 1 }],
      };
      const received = await form('receiveReturnAction', receipt, cookie(managerToken), returnPath);
      const stockAfter = await variantNow();
      check(
        'returns: the physical receipt puts the units back on the shelf, once',
        received.body.includes('"changed":true') &&
          stockAfter === stockBefore + (returnLine?.quantity ?? 1),
      );
      const again = await form('receiveReturnAction', receipt, cookie(managerToken), returnPath);
      check(
        'returns: the same receipt again changes nothing',
        again.body.includes('"changed":false') && (await variantNow()) === stockAfter,
      );
      const managerRefund = await form(
        'refundReturnAction',
        { id: openReturn.id },
        cookie(managerToken),
        returnPath,
      );
      check(
        'returns: a manager cannot refund (orders.refund needed)',
        managerRefund.body.includes('FORBIDDEN'),
      );
    }
    // Customers and the CSV routes (phase 5): the same role rules on the real pages and files.
    const customerList = await get('/admin/customers', cookie(managerToken));
    const contentCustomers = await get('/admin/customers', cookie(contentToken));
    check(
      'customers: a manager lists customers; a content role gets the not-found page with no customer data',
      customerList.status === 200 &&
        customerList.html.includes('Smoke Buyer') &&
        !contentCustomers.html.includes('Smoke Buyer') &&
        !contentCustomers.html.includes('smoke-buyer@example.test'),
    );
    const range = 'from=2020-01-01&to=2099-12-31';
    const managerOrdersCsv = await get(`/admin/export/orders?${range}`, cookie(managerToken));
    const managerCustomersCsv = await get('/admin/export/customers', cookie(managerToken));
    const adminOrdersCsv = await get(`/admin/export/orders?${range}`, cookie(adminToken));
    const adminCustomersCsv = await get('/admin/export/customers', cookie(adminToken));
    check(
      'exports: a manager is refused both files (403); an admin gets the orders CSV with no email or phone and the customers CSV with them',
      managerOrdersCsv.status === 403 &&
        managerCustomersCsv.status === 403 &&
        adminOrdersCsv.status === 200 &&
        adminOrdersCsv.html.includes(orderNumber) &&
        !adminOrdersCsv.html.includes('smoke-buyer@example.test') &&
        !adminOrdersCsv.html.includes('+380501112299') &&
        adminCustomersCsv.status === 200 &&
        adminCustomersCsv.html.includes('smoke-buyer@example.test'),
    );

    // The user screen is the owner's alone: every other role gets the not-found page and NO other
    // account's email. (The page carries the translation catalogue, so a label like "Two-step
    // sign-in" is not a signal; the shell shows the viewer's own email, so only the OTHERS count.)
    const knownEmails = [manager, ...[...roleUsers.values()]];
    for (const [role, token, own] of [
      ['admin', adminToken, roleUsers.get('admin') ?? ''],
      ['manager', managerToken, manager],
      ['content', contentToken, roleUsers.get('content') ?? ''],
    ] as const) {
      const usersPage = await get('/admin/users', cookie(token));
      const others = knownEmails.filter((email) => email !== own);
      check(
        `users: a ${role} role gets the not-found page on /admin/users, with no other account listed`,
        others.length >= 2 &&
          others.every((email) => !usersPage.html.includes(email)) &&
          (usersPage.status === 404 || usersPage.html.includes('NEXT_HTTP_ERROR_FALLBACK;404')),
      );
    }

    // The waybill print route: its own auth, checked before the carrier or the order is touched.
    const printPath = `/admin/print/waybill/${order.id}?kind=document`;
    const anonymousPrint = await get(printPath);
    const contentPrint = await get(printPath, cookie(contentToken));
    const noWaybillPrint = await get(printPath, cookie(managerToken));
    check(
      'orders: the print route refuses without a session (the proxy redirects; the route itself answers 401), 403 for a content role and 404 for an order with no waybill (and never carries a key)',
      (anonymousPrint.status === 401 || anonymousPrint.status === 307) &&
        contentPrint.status === 403 &&
        noWaybillPrint.status === 404 &&
        !noWaybillPrint.html.includes('apiKey'),
    );

    // A changed slug answers 301 at the old address, for both locales.
    const oldSlug = original?.slug ?? '';
    const newSlug = `renamed-${suffix}`;
    // A page that is gone for good (a 410 row written before the rename below, whose cache
    // invalidation makes this instance reload the table).
    const goneSlug = `gone-${suffix}`;
    await db.transaction(async (tx) => {
      await recordGone(tx, { kind: 'product', slug: goneSlug });
    });
    const renamed = await form(
      'updateProductContentAction',
      { productId: target.id, slug: newSlug },
      cookie(adminToken),
      '/admin/products',
    );
    const oldPage = await get(`/product/${oldSlug}`);
    const oldPageEn = await get(`/en/product/${oldSlug}`);
    check(
      'catalog: renaming a product answers 301 from the old address to the new one, in both locales',
      renamed.body.includes('"ok":true') &&
        oldPage.status === 301 &&
        new URL(oldPage.location ?? 'x:', base).pathname === `/product/${newSlug}` &&
        oldPageEn.status === 301 &&
        new URL(oldPageEn.location ?? 'x:', base).pathname === `/en/product/${newSlug}`,
    );
    // Put it back so the rest of the smoke sees the original address.
    await form(
      'updateProductContentAction',
      { productId: target.id, slug: oldSlug },
      cookie(adminToken),
      '/admin/products',
    );

    // A draft that is renamed must not reveal its new slug through the old address; a published
    // product's redirect is cacheable only briefly.
    const draftSlug = `draft-${suffix}`;
    const drafted = await form(
      'createProductAction',
      {
        sku: `DRAFT-${suffix}`,
        slug: draftSlug,
        brand: 'Smoke',
        categoryId: original?.categoryId ?? '',
        nameUk: 'Чернетка',
        nameEn: 'Draft',
        basePrice: '10.00',
        weightGrams: 100,
      },
      cookie(adminToken),
      '/admin/products',
    );
    const draftId = /"productId":"([0-9a-f-]{36})"/.exec(drafted.body)?.[1] ?? '';
    const draftRenamed = await form(
      'updateProductContentAction',
      { productId: draftId, slug: `secret-launch-${suffix}` },
      cookie(adminToken),
      '/admin/products',
    );
    const draftProbe = await get(`/product/${draftSlug}`);
    check(
      'catalog: renaming a DRAFT does not reveal the new slug: the old address is a 404, not a 301',
      drafted.body.includes('"ok":true') &&
        draftRenamed.body.includes('"ok":true') &&
        draftProbe.status === 404 &&
        draftProbe.location === null,
    );
    check(
      'catalog: the 301 of a published product is cacheable for a short time only',
      oldPage.cache.includes('max-age=300') && !oldPage.cache.includes('immutable'),
    );

    const gone = await get(`/product/${goneSlug}`);
    const goneEn = await get(`/en/product/${goneSlug}`);
    check(
      'redirects: a path recorded as gone answers 410 (not 404), in both locales, with a short cache',
      gone.status === 410 &&
        goneEn.status === 410 &&
        gone.html === 'Gone' &&
        gone.cache.includes('max-age=300'),
    );
    // Hits are counted in memory and written in batches: 250 requests make at least one full batch.
    // Fewer than the batch size (100 pending in all): nothing may be written yet, which an UPDATE per
    // request would have done at once.
    for (let i = 0; i < 90; i++) await get(`/product/${newSlug}`);
    const early = await db
      .select({ from: redirects.fromPath, n: redirects.hitCount })
      .from(redirects);
    check(
      'redirects: below the batch size nothing is written yet (counted in memory, not per request)',
      early.find((row) => row.from === `/product/${newSlug}`)?.n === 0,
    );
    for (let i = 0; i < 160; i++) await get(`/product/${newSlug}`);
    let counted = 0;
    for (let i = 0; i < 40 && counted < 100; i++) {
      const rows = await db
        .select({ from: redirects.fromPath, n: redirects.hitCount })
        .from(redirects);
      counted = rows.find((row) => row.from === `/product/${newSlug}`)?.n ?? 0;
      if (counted < 100) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    check(
      'redirects: hit_count counts served redirects (batched, not per request)',
      counted >= 100 && counted <= 250,
    );

    // The price change reaches the storefront within a revalidation, and touches only that product.
    await get(`/product/${oldSlug}`);
    await get(`/product/${bystander.slug}`);
    const bystanderBefore = await get(`/product/${bystander.slug}`);
    // A price just BELOW the current one: valid whatever old price (compare-at) the product has.
    const newBase = (original?.basePrice ?? 0) - 123;
    if (newBase < 100) throw new Error('the target price is too low for the revalidation check');
    const newBaseText = `${String(Math.floor(newBase / 100))}.${String(newBase % 100).padStart(2, '0')}`;
    const newBaseShown = new Intl.NumberFormat('uk-UA', {
      style: 'currency',
      currency: 'UAH',
    }).format(newBase / 100);
    const priced = await form(
      'updateProductPricingAction',
      { productId: target.id, basePrice: newBaseText },
      cookie(adminToken),
      '/admin/products',
    );
    let shown = false;
    for (let attempt = 0; attempt < 40 && !shown; attempt += 1) {
      shown = (await get(`/product/${oldSlug}`)).html.includes(newBaseShown);
      if (!shown) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    check(
      'catalog: a price change shows on the product page within a revalidation (tag invalidation)',
      priced.body.includes('"ok":true') && shown,
    );
    const bystanderAfter = await get(`/product/${bystander.slug}`);
    check(
      'catalog: changing one product leaves another product page in the cache',
      bystanderBefore.nextCache === 'HIT' && bystanderAfter.nextCache === 'HIT',
    );

    // 5f. CSV import and export: 100 rows with 3 broken, the cost only for a role that may see it.
    const importHeader = 'sku,slug,brand,category,name_uk,name_en,price,cost_price';
    const categorySlugOfTarget =
      (await db.select().from(categories)).find((c) => c.id === original?.categoryId)?.slug ?? '';
    const importRows = Array.from({ length: 100 }, (_, i) => {
      const n = i + 1;
      return `IMP${suffix}-${String(n)},imp${suffix}-${String(n)},Brand,${categorySlugOfTarget},Товар ${String(n)},Product ${String(n)},199.00,80.00`;
    });
    importRows[9] = `IMP${suffix}-10,imp${suffix}-10,Brand,${categorySlugOfTarget},Товар,Product,abc,80.00`;
    importRows[49] = `IMP${suffix}-50,imp${suffix}-50,Brand,no-such-category,Товар,Product,199.00,80.00`;
    importRows[89] = `,imp${suffix}-90,Brand,${categorySlugOfTarget},Товар,Product,199.00,80.00`;
    const csv = [importHeader, ...importRows].join('\n');
    /** The CSV goes to the import route (not a server action): the raw text as the body. */
    const csvPost = async (mode: 'preview' | 'commit', token: string) => {
      const response = await fetch(`${base}/admin/upload/products-csv?mode=${mode}`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'X-Forwarded-For': nextClient(),
          'Content-Type': 'text/csv',
          ...origin(),
          ...cookie(token),
        },
        body: csv,
      });
      return { status: response.status, body: await response.text() };
    };
    const contentImport = await csvPost('preview', contentToken);
    check(
      'import: a content role cannot import (FORBIDDEN)',
      contentImport.status === 403 && contentImport.body.includes('FORBIDDEN'),
    );
    const preview = await csvPost('preview', adminToken);
    const previewBad = [
      ...preview.body.matchAll(/"line":(\d+),"row":\d+,"sku":"[^"]*","action":"error"/g),
    ].map((m) => Number(m[1]));
    const countBefore = (await db.select().from(products)).filter((p) =>
      p.sku.startsWith(`IMP${suffix}-`),
    ).length;
    check(
      'import: the preview names the three broken lines (11, 51, 91) and writes nothing',
      JSON.stringify(previewBad) === JSON.stringify([11, 51, 91]) && countBefore === 0,
    );
    const committed = await csvPost('commit', adminToken);
    const imported = (await db.select().from(products)).filter((p) =>
      p.sku.startsWith(`IMP${suffix}-`),
    );
    check(
      'import: the commit imports 97 and reports 3 errors with their line numbers',
      committed.body.includes('"created":97') &&
        committed.body.includes('"failed":3') &&
        imported.length === 97,
    );
    const exportFor = async (token: string | null) => {
      const response = await fetch(`${base}/admin/export/products`, {
        redirect: 'manual',
        headers: { 'X-Forwarded-For': nextClient(), ...(token === null ? {} : cookie(token)) },
      });
      return {
        status: response.status,
        type: response.headers.get('content-type') ?? '',
        disposition: response.headers.get('content-disposition') ?? '',
        cache: response.headers.get('cache-control') ?? '',
        truncated: response.headers.get('x-export-truncated'),
        body: await response.text(),
      };
    };
    const exportAdmin = await exportFor(adminToken);
    const exportManager = await exportFor(managerToken);
    const exportAnon = await exportFor(null);
    const exportAudits = (await db.select().from(auditLog)).filter(
      (row) => row.action === 'export',
    );
    check(
      'export: every download is audited (who, rows, whether the cost was included)',
      exportAudits.some((row) => JSON.stringify(row.diff).includes('"includedCost":true')) &&
        exportAudits.every((row) => row.userId !== null),
    );
    check('export: a small catalogue is not marked truncated', exportAdmin.truncated === null);
    check(
      'export: an admin gets a CSV download (no-store) with the cost column; a manager is 403; no session is refused (the proxy redirects to the login; the route itself answers 401)',
      exportAdmin.status === 200 &&
        exportAdmin.type.includes('text/csv') &&
        exportAdmin.disposition.includes('attachment') &&
        exportAdmin.cache.includes('no-store') &&
        exportAdmin.body.includes('cost_price') &&
        exportManager.status === 403 &&
        !exportManager.body.includes('cost_price') &&
        (exportAnon.status === 401 || exportAnon.status === 307),
    );

    // 5c. Taxonomy: categories need categories.edit, dictionaries need dictionaries.edit.
    const slugOf = (name: string) => `${name}-${suffix}`;
    const managerCategory = await form(
      'createCategoryAction',
      { parentId: null, slug: slugOf('mgr-cat'), nameUk: 'x', nameEn: 'x' },
      cookie(managerToken),
      '/admin/categories',
    );
    check(
      'taxonomy: a manager cannot create a category',
      managerCategory.body.includes('FORBIDDEN'),
    );
    const contentCategory = await form(
      'createCategoryAction',
      { parentId: null, slug: slugOf('cnt-cat'), nameUk: 'Тест', nameEn: 'Test' },
      cookie(contentToken),
      '/admin/categories',
    );
    check(
      'taxonomy: a content role may create a category',
      contentCategory.body.includes('"ok":true'),
    );
    const contentColor = await form(
      'saveColorAction',
      { slug: slugOf('cnt-color'), nameUk: 'x', nameEn: 'x', hex: '#112233', sortOrder: 0 },
      cookie(contentToken),
      '/admin/dictionaries',
    );
    check(
      'taxonomy: a content role cannot save a colour (FORBIDDEN)',
      contentColor.body.includes('FORBIDDEN'),
    );
    const adminColor = await form(
      'saveColorAction',
      { slug: slugOf('adm-color'), nameUk: 'Тест', nameEn: 'Test', hex: '#112233', sortOrder: 0 },
      cookie(adminToken),
      '/admin/dictionaries',
    );
    check('taxonomy: an admin saves a colour', adminColor.body.includes('"ok":true'));
    const dictAdmin = await get('/admin/dictionaries', cookie(adminToken));
    const dictContent = await get('/admin/dictionaries', cookie(contentToken));
    check(
      'taxonomy: the dictionaries page has the add form for an admin and is read-only for a content role',
      dictAdmin.status === 200 &&
        dictAdmin.html.includes('>Додати<') &&
        dictContent.status === 200 &&
        !dictContent.html.includes('>Додати<'),
    );

    // 5d. Photo upload: its own route (the proxy buffers bodies at 64 KB; a photo is megabytes).
    const upload = async (
      body: Buffer | ReadableStream | null,
      token: string | null,
      query = `productId=${target.id}`,
      extra: Record<string, string> = {},
      init: RequestInit = {},
    ) => {
      const response = await fetch(`${base}/admin/upload/product-image?${query}`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Origin: siteOrigin,
          'X-Forwarded-For': nextClient(),
          ...(token === null ? {} : cookie(token)),
          ...extra,
        },
        body,
        ...init,
      });
      return {
        status: response.status,
        cache: response.headers.get('cache-control') ?? '',
        json: (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          code?: string;
          imageId?: string;
        },
      };
    };
    const photo = await samplePhoto(3000, 2000);
    check(
      'media: the sample photo is far larger than the proxy body limit (64 KB)',
      photo.length > 100 * 1024,
    );
    const storedBefore = fakeS3.objects.size;
    const noSession = await upload(photo, null);
    const managerUpload = await upload(photo, managerToken);
    const foreignOrigin = await upload(photo, contentToken, `productId=${target.id}`, {
      Origin: 'https://evil.example',
    });
    check(
      'media: no session is 401, a manager is 403, a foreign Origin is 403, and nothing was stored',
      noSession.status === 401 &&
        managerUpload.status === 403 &&
        foreignOrigin.status === 403 &&
        fakeS3.objects.size === storedBefore,
    );
    const uploaded = await upload(photo, contentToken);
    const keys = [...fakeS3.objects.keys()].filter((key) =>
      key.startsWith(`products/${target.id}/${uploaded.json.imageId ?? 'none'}/`),
    );
    const imageRows = (await db.select().from(productImages)).filter(
      (row) => row.id === uploaded.json.imageId,
    );
    check(
      'media: a content role uploads a 3000 px photo through the route (201, no-store), six signed objects in the bucket, one row on the media host',
      uploaded.status === 201 &&
        uploaded.cache.includes('no-store') &&
        keys.length === 6 &&
        fakeS3.rejected === 0 &&
        imageRows.length === 1 &&
        (imageRows[0]?.url ?? '').startsWith('https://media.smoke.example/products/'),
    );
    const full = fakeS3.objects.get(
      `products/${target.id}/${uploaded.json.imageId ?? 'none'}/full.webp`,
    );
    check(
      'media: the full-size WebP is 1600 px wide class and under 150 KB, the objects are immutable-cached',
      full !== undefined &&
        full.body.length < 150 * 1024 &&
        full.contentType === 'image/webp' &&
        full.cacheControl.includes('immutable'),
    );
    // The storefront serves the renditions: AVIF and WebP at three widths with `sizes`, a reserved
    // box, and the lead photo announced in the head (the LCP candidate). The seed product's first
    // photo is a placeholder, so the uploaded one is made the lead first, and the (ISR) page is
    // fetched until it shows the new lead.
    const placeholders = (await db.select().from(productImages)).filter(
      (row) => row.productId === target.id && row.url === '/placeholder.svg',
    );
    for (const placeholder of placeholders) {
      await form(
        'updateProductImageAction',
        { imageId: placeholder.id, sortOrder: 50 },
        cookie(contentToken),
        '/admin/products',
      );
    }
    let photoPage = await get(`/product/${oldSlug}`);
    for (let i = 0; i < 20 && !photoPage.html.includes('<picture>'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      photoPage = await get(`/product/${oldSlug}`);
    }
    check(
      'images: the product page serves the uploaded photo as <picture> (AVIF, WebP, three widths, sizes, width and height) and preloads the lead photo',
      photoPage.status === 200 &&
        photoPage.html.includes('<picture>') &&
        /<source type="image\/avif" srcSet="[^"]*thumb\.avif 320w[^"]*" sizes="[^"]+"/.test(
          photoPage.html,
        ) &&
        /<source type="image\/webp" srcSet="[^"]*card\.webp 800w[^"]*full\.webp \d+w" sizes="[^"]+"/.test(
          photoPage.html,
        ) &&
        /<img src="[^"]*\/full\.webp"[^>]*width="\d+" height="\d+"/.test(photoPage.html) &&
        /<link rel="preload" as="image"[^>]*\/full\.avif \d+w/.test(photoPage.html),
    );
    // Put the placeholder back where the seed had it.
    for (const placeholder of placeholders) {
      await form(
        'updateProductImageAction',
        { imageId: placeholder.id, sortOrder: placeholder.sortOrder },
        cookie(contentToken),
        '/admin/products',
      );
    }
    const svg = await upload(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      contentToken,
      `productId=${target.id}`,
      { 'Content-Type': 'image/jpeg' },
    );
    const html = await upload(
      Buffer.from('<!doctype html><html></html>'),
      contentToken,
      `productId=${target.id}`,
      { 'Content-Type': 'image/png' },
    );
    check(
      'media: an SVG or an HTML page sent as image/jpeg is refused by its bytes (415), nothing stored',
      svg.status === 415 && html.status === 415 && fakeS3.objects.size === storedBefore + 6,
    );
    const tooBig = await upload(Buffer.alloc(13 * 1024 * 1024, 1), contentToken);
    const chunked = await upload(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      }),
      contentToken,
      `productId=${target.id}`,
      {},
      { duplex: 'half' },
    );
    check(
      'media: a body over the cap is cut off with 413, declared or streamed without a length',
      tooBig.status === 413 && chunked.status === 413 && fakeS3.objects.size === storedBefore + 6,
    );
    const requestsAfterGood = fakeS3.requests;
    const traversal = await upload(photo, contentToken, 'productId=../../etc/passwd');
    const missing = await upload(
      photo,
      contentToken,
      'productId=00000000-0000-4000-8000-000000000000',
    );
    check(
      'media: a path-like product id is 400 and an unknown product is 404 BEFORE any conversion: the store saw no request',
      traversal.status === 400 &&
        missing.status === 404 &&
        fakeS3.objects.size === storedBefore + 6 &&
        fakeS3.requests === requestsAfterGood,
    );
    check(
      'media: every key is made of the product id, the image id and a fixed name (no file name anywhere)',
      [...fakeS3.objects.keys()].every((key) =>
        /^products\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(thumb|card|full)\.(webp|avif)$/.test(key),
      ),
    );
    // A refused role never gets its body read (an endless body is not consumed), and the store sees nothing.
    // The server answers 403 and closes the connection while the client is still writing, so the client may
    // see the 403 or a reset: both are a refusal. What must hold is that the server did NOT drain the body
    // (the producer stalls at the socket buffers, far below what a reading server would accept) and that the
    // store saw nothing. The producer is paced and stops as soon as the request ends, so it never spins.
    const requestsBefore = fakeS3.requests;
    const endlessEnd = new AbortController();
    let endlessChunks = 0;
    const endless = new ReadableStream({
      async pull(controller) {
        if (endlessEnd.signal.aborted || endlessChunks >= 4_000) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(64 * 1024));
        endlessChunks += 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    });
    const refusedFast = await upload(
      endless,
      managerToken,
      `productId=${target.id}`,
      {},
      {
        duplex: 'half',
        signal: AbortSignal.any([AbortSignal.timeout(8_000), endlessEnd.signal]),
      },
    ).then(
      (response) => ({ closed: false, status: response.status }),
      () => ({ closed: true, status: 0 }),
    );
    endlessEnd.abort();
    check(
      'media: a manager with an endless body is refused (403, or the connection is closed) and the body is never read: the server took far less than a reading server would, and the store saw no request',
      (refusedFast.closed || refusedFast.status === 403) &&
        endlessChunks < 1_000 &&
        fakeS3.requests === requestsBefore,
    );
    // Memory is bounded by slots taken BEFORE the body is read: parallel uploads of one user are refused at once.
    const burst = await Promise.all(
      Array.from({ length: 8 }, async () => await upload(photo, contentToken)),
    );
    check(
      'media: 8 parallel uploads from one user: one is admitted, the rest are 429 BUSY immediately (in-flight slots)',
      burst.filter((r) => r.status === 201).length >= 1 &&
        burst.filter((r) => r.status === 429 && r.json.code === 'BUSY').length >= 5,
    );
    const stale = 'v1.00000000-0000-4000-8000-000000000000.9999999999.AAAA';
    const flood = [];
    for (let i = 0; i < 130; i += 1) {
      flood.push(
        await upload(Buffer.from('x'), stale, `productId=${target.id}`, {
          'X-Forwarded-For': '192.0.2.77',
        }),
      );
    }
    check(
      'media: a flood of POSTs with a stale cookie from one client is cut by the pre-auth limit (429) after 120',
      flood.filter((r) => r.status === 401).length >= 100 && flood.some((r) => r.status === 429),
    );
    const mixed = await upload(photo, contentToken, `productId=${target.id.toUpperCase()}`);
    check(
      'media: an upper-case product id is accepted as the same product',
      mixed.status === 201 || mixed.status === 409,
    );

    // Two GLOBAL slots: four different users uploading at once are not all admitted.
    const extraTokens: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const email = `content-x${String(i)}-${suffix}@example.test`;
      await db.transaction(async (tx) => {
        await createAdminUser(tx, { email, password: PASSWORD, role: 'content' });
      });
      const session = await db.transaction(
        async (tx) => await beginLogin(tx, config, { email, password: PASSWORD, client }),
      );
      if (!session.ok) throw new Error('extra session failed');
      extraTokens.push(session.token);
    }
    // Let the earlier burst finish so its slots are free.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const fourUsers = await Promise.all(
      [contentToken, ...extraTokens].map(async (token) => await upload(photo, token)),
    );
    check(
      'media: four different users at once: at most TWO are admitted (global slots), the rest are 429 BUSY',
      fourUsers.filter((r) => r.status === 201 || r.status === 409).length <= 2 &&
        fourUsers.filter((r) => r.status === 429 && r.json.code === 'BUSY').length >= 2,
    );

    // A client that sends the headers and then NOTHING must not hold a slot past the read deadline.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const target_ = new URL(base);
    const stalled = net.connect(Number(target_.port), target_.hostname);
    stalled.write(
      [
        `POST /admin/upload/product-image?productId=${target.id} HTTP/1.1`,
        `Host: ${target_.host}`,
        `Origin: ${siteOrigin}`,
        `Cookie: admin_session=${contentToken}`,
        'X-Forwarded-For: 198.51.100.200',
        'Content-Type: image/jpeg',
        'Content-Length: 5000000',
        '',
        '',
      ].join('\r\n'),
    );
    stalled.on('error', () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const whileStalled = await upload(photo, contentToken);
    const stalledStart = Date.now();
    let freed: Awaited<ReturnType<typeof upload>> | null = null;
    while (Date.now() - stalledStart < 40_000) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const attempt = await upload(photo, contentToken);
      if (!(attempt.status === 429 && attempt.json.code === 'BUSY')) {
        freed = attempt;
        break;
      }
    }
    stalled.destroy();
    check(
      'media: a socket that sends headers and no body holds the user slot (429 BUSY) and frees it within the read deadline (well under 60 s)',
      whileStalled.status === 429 &&
        whileStalled.json.code === 'BUSY' &&
        freed !== null &&
        Date.now() - stalledStart < 45_000,
    );

    const editorPage = await get(`/admin/products/${target.id}`, cookie(adminToken));
    check(
      'media: the editor warns about a photo without alt text',
      editorPage.html.includes('Не заповнено alt-текст'),
    );
    const deleted = await form(
      'deleteProductImageAction',
      { imageId: uploaded.json.imageId ?? '' },
      cookie(contentToken),
      '/admin/products',
    );
    check(
      'media: deleting a photo removes its row and all six files',
      deleted.body.includes('"ok":true') &&
        [...fakeS3.objects.keys()].filter((key) => key.includes(uploaded.json.imageId ?? 'none'))
          .length === 0 &&
        (await db.select().from(productImages)).every((row) => row.id !== uploaded.json.imageId),
    );

    // 5e. Stock: manager and admin may adjust, content may not; below-reserved is refused; a repeat is harmless.
    const variantRow = (await db.select().from(productVariants)).find(
      (row) => row.productId === target.id,
    );
    if (variantRow === undefined) throw new Error('the target product has no variant');
    const stockBefore = variantRow.stockQuantity;
    const rid = (n: number) => `5e9d0c1a-7b2f-4c3d-8a4e-0000000000${String(10 + n)}`;
    const contentStock = await form(
      'adjustStockAction',
      { variantId: variantRow.id, mode: 'delta', amount: 1, reason: 'receipt', requestId: rid(1) },
      cookie(contentToken),
      '/admin/stock',
    );
    const managerStock = await form(
      'adjustStockAction',
      { variantId: variantRow.id, mode: 'delta', amount: 4, reason: 'receipt', requestId: rid(2) },
      cookie(managerToken),
      '/admin/stock',
    );
    const managerAgain = await form(
      'adjustStockAction',
      { variantId: variantRow.id, mode: 'delta', amount: 4, reason: 'receipt', requestId: rid(2) },
      cookie(managerToken),
      '/admin/stock',
    );
    const afterStock = (await db.select().from(productVariants)).find(
      (row) => row.id === variantRow.id,
    );
    check(
      'stock: content is FORBIDDEN, a manager adds 4, the same request id again adds nothing',
      contentStock.body.includes('FORBIDDEN') &&
        managerStock.body.includes('"ok":true') &&
        managerAgain.body.includes('"replayed":true') &&
        afterStock?.stockQuantity === stockBefore + 4,
    );
    const below = await form(
      'adjustStockAction',
      { variantId: variantRow.id, mode: 'set', amount: 0, reason: 'stocktake', requestId: rid(3) },
      cookie(adminToken),
      '/admin/stock',
    );
    const reservedNow = afterStock?.reservedQuantity ?? 0;
    check(
      'stock: a stocktake below the reserved quantity is refused (only when something is reserved), stock untouched',
      reservedNow === 0 ||
        (below.body.includes('STOCK_BELOW_RESERVED') &&
          (await db.select().from(productVariants)).find((row) => row.id === variantRow.id)
            ?.stockQuantity ===
            stockBefore + 4),
    );
    const stockPage = await get('/admin/stock', cookie(managerToken));
    const historyPage = await get(`/admin/stock/${variantRow.id}`, cookie(managerToken));
    check(
      'stock: the screens render for a manager (list with the adjust form, history with the change)',
      stockPage.status === 200 &&
        stockPage.html.includes('Склад') &&
        historyPage.status === 200 &&
        historyPage.html.includes('+4'),
    );

    // 6. The storefront is untouched.
    const store = await get('/');
    check(
      'storefront: no admin theme attribute, no admin cookie and no admin headers on the home page',
      !store.html.includes('data-theme') &&
        !store.html.includes('admin_') &&
        !store.html.includes('/admin'),
    );
    const before = storedFiles();
    for (let i = 0; i < 20; i += 1)
      await get(`/admin/zzz-${String(i)}`, cookie(managerLogin.token));
    check('admin: unknown admin paths do not grow the page cache', storedFiles() - before <= 2);
  } finally {
    await close();
  }
}
