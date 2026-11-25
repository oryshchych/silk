/**
 * Phase 4 slice 2 on the BUILT app (called from smoke-web.ts): the admin's headers, limits,
 * redirects, theme without flash, sessions read from the database, and the guarantee that none of
 * it reaches the storefront. Sessions are minted with the same core functions the login uses, so
 * the cookie the server receives is a real one; forged, revoked and deactivated sessions are
 * tried against the real server too.
 */
import { actionIds } from './smoke-http.ts';
import { createDb } from '../packages/db/src/client.ts';
import {
  beginLogin,
  confirmTotpEnrolment,
  createAdminUser,
  resolveSession,
  revokeAllSessions,
  startTotpEnrolment,
} from '../packages/core/src/auth/service.ts';
import { productImages, products } from '../packages/db/src/schema.ts';
import { samplePhoto } from '../packages/media/test/sample-image.ts';
import type { FakeS3 } from '../packages/media/test/fake-s3.ts';
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
    await db.transaction(async (tx) => {
      await createAdminUser(tx, { email: manager, password: PASSWORD, role: 'manager' });
      await createAdminUser(tx, { email: owner, password: PASSWORD, role: 'owner' });
    });
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

    // A changed slug answers 301 at the old address, for both locales.
    const oldSlug = original?.slug ?? '';
    const newSlug = `renamed-${suffix}`;
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

    // The price change reaches the storefront within a revalidation, and touches only that product.
    await get(`/product/${oldSlug}`);
    await get(`/product/${bystander.slug}`);
    const bystanderBefore = await get(`/product/${bystander.slug}`);
    const priced = await form(
      'updateProductPricingAction',
      { productId: target.id, basePrice: '7777.77' },
      cookie(adminToken),
      '/admin/products',
    );
    let shown = false;
    for (let attempt = 0; attempt < 40 && !shown; attempt += 1) {
      shown = (await get(`/product/${oldSlug}`)).html.includes('777,77');
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
    const traversal = await upload(photo, contentToken, 'productId=../../etc/passwd');
    const missing = await upload(
      photo,
      contentToken,
      'productId=00000000-0000-4000-8000-000000000000',
    );
    check(
      'media: a path-like product id is 400 and an unknown product stores nothing',
      traversal.status === 400 &&
        missing.status !== 201 &&
        fakeS3.objects.size === storedBefore + 6,
    );
    check(
      'media: every key is made of the product id, the image id and a fixed name (no file name anywhere)',
      [...fakeS3.objects.keys()].every((key) =>
        /^products\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(thumb|card|full)\.(webp|avif)$/.test(key),
      ),
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
