/**
 * Phase 10 on the BUILT server (called from smoke-web.ts): the reports as every role gets them.
 * Real sessions: manager and content (no second factor) and an owner (TOTP enrolment). One order with
 * a cost snapshot of 4 242 424 kopiykas and a hostile product name is written into the database.
 *
 * The cost must be ABSENT from what a role without `catalog.cost.view` receives, in the rendered
 * HTML (both languages), in the RSC payload (`RSC: 1`) and in the CSV; the margin report answers a
 * manager with the same 404 as an unknown address; a content editor sees no report at all; the
 * export route refuses a manager before any query; the owner's CSV equals the screen, neutralises a
 * formula name and carries `private, no-store` and `nosniff`; a download writes an audit row.
 */
import {
  beginLogin,
  confirmTotpEnrolment,
  createAdminUser,
  startTotpEnrolment,
} from '../packages/core/src/auth/service.ts';
import { codeAt, stepOf } from '../packages/core/src/auth/totp.ts';
import { createDb } from '../packages/db/src/client.ts';
import { auditLog, products } from '../packages/db/src/schema.ts';
import { insertOrder } from '../packages/core/test/reports-fixture.ts';

interface Context {
  base: string;
  databaseUrl: string;
  authSecret: string;
  check: (name: string, ok: boolean) => void;
}

const PASSWORD = 'smoke-reports-password-0123456789';
const COST_KOPIYKAS = 4_242_424;
const COST_MARKERS = ['4242424', '42 424', '42 424', '42,424', 'costOfGoods', 'stockValueAtCost'];
const HOSTILE = '=HYPERLINK("http://evil.example","x")';
const RANGE = 'from=2031-01-01&to=2031-12-31';

export async function runReportsSmoke({ base, databaseUrl, authSecret, check }: Context) {
  const { db, close } = createDb(databaseUrl, { max: 2 });
  const suffix = String(Date.now());
  let counter = 0;
  const nextClient = (): string => `203.0.113.${String(++counter + 20)}`;
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, {
      redirect: 'manual',
      headers: { 'X-Forwarded-For': nextClient(), ...headers },
    });
    return {
      status: response.status,
      location: response.headers.get('location'),
      headers: response.headers,
      cache: response.headers.get('cache-control') ?? '',
      text: await response.text(),
    };
  };
  const leaksCost = (text: string): boolean => COST_MARKERS.some((marker) => text.includes(marker));
  try {
    // The orders are dated in 2031 on purpose: other smoke scripts take the OLDEST guest orders of the seed.
    // No new category or product: the storefront caches its category list, and a category created behind
    // its back would be listed by the sitemap and 404 on its page. The seeded products carry the cost marker.
    await db.update(products).set({ costPrice: COST_KOPIYKAS });
    const [existing] = await db.select({ id: products.id }).from(products).limit(1);
    const productId = existing?.id ?? '';
    await db.transaction(async (tx) => {
      await insertOrder(tx, {
        createdAt: '2031-06-10T10:00:00Z',
        lines: [
          {
            uid: productId,
            name: 'Smoke product',
            quantity: 1,
            price: 5_000_000,
            cost: COST_KOPIYKAS,
          },
        ],
        captures: [{ at: '2031-06-10T10:05:00Z', amount: 5_000_000 }],
      });
      await insertOrder(tx, {
        createdAt: '2031-06-11T10:00:00Z',
        lines: [{ name: HOSTILE, quantity: 1, price: 1_000, cost: 500 }],
        captures: [{ at: '2031-06-11T10:05:00Z', amount: 1_000 }],
      });
    });
    check('reports: the fixture product exists', productId.length > 0);

    const config = { secret: authSecret };
    const client = { ip: '198.51.100.89', userAgent: 'smoke-reports' };
    const tokens: Record<string, string> = {};
    for (const role of ['manager', 'content'] as const) {
      const email = `${role}-reports-${suffix}@example.test`;
      await db.transaction(async (tx) => {
        await createAdminUser(tx, { email, password: PASSWORD, role });
      });
      const login = await db.transaction(
        async (tx) => await beginLogin(tx, config, { email, password: PASSWORD, client }),
      );
      if (!login.ok) throw new Error('smoke reports account could not sign in');
      tokens[role] = login.token;
    }
    const ownerEmail = `owner-reports-${suffix}@example.test`;
    await db.transaction(async (tx) => {
      await createAdminUser(tx, { email: ownerEmail, password: PASSWORD, role: 'owner' });
    });
    const pending = await db.transaction(
      async (tx) => await beginLogin(tx, config, { email: ownerEmail, password: PASSWORD, client }),
    );
    if (!pending.ok) throw new Error('smoke reports owner could not sign in');
    const enrol = await db.transaction(
      async (tx) => await startTotpEnrolment(tx, config, { token: pending.token }),
    );
    if (enrol === null) throw new Error('smoke reports owner enrolment failed');
    const ownerFull = await db.transaction(
      async (tx) =>
        await confirmTotpEnrolment(tx, config, {
          token: pending.token,
          code: codeAt(enrol.secret, stepOf(Date.now())),
          client,
        }),
    );
    if (!ownerFull.ok) throw new Error('smoke reports owner could not finish enrolment');
    const cookie = (
      role: 'manager' | 'content' | 'owner',
      locale = 'en',
    ): Record<string, string> => ({
      Cookie: `admin_session=${role === 'owner' ? ownerFull.token : (tokens[role] ?? '')}; admin_locale=${locale}`,
    });

    // Anonymous.
    const anonymous = await get(`/admin/reports/revenue?${RANGE}`);
    check(
      'reports: anonymous is sent to the login',
      anonymous.status === 307 &&
        new URL(anonymous.location ?? 'x:', base).pathname === '/admin/login',
    );

    // Manager: every report but the margin, in both languages, no cost anywhere.
    for (const locale of ['en', 'uk'] as const) {
      const index = await get('/admin/reports', cookie('manager', locale));
      check(
        `reports: the manager's list (${locale}) is real text, private no-store, and has no margin link`,
        index.status === 200 &&
          index.cache.includes('no-store') &&
          index.text.includes('/admin/reports/revenue') &&
          !index.text.includes('/admin/reports/margin') &&
          !index.text.includes('admin.reports.'),
      );
    }
    for (const name of [
      'revenue',
      'orders',
      'top-products',
      'stock',
      'returns',
      'promos',
      'customers',
      'providers',
      'viewed-not-bought',
    ]) {
      for (const locale of ['en', 'uk'] as const) {
        const page = await get(
          `/admin/reports/${name}?${RANGE}&threshold=1000`,
          cookie('manager', locale),
        );
        const rsc = await get(`/admin/reports/${name}?${RANGE}&threshold=1000`, {
          ...cookie('manager', locale),
          RSC: '1',
        });
        const ok =
          page.status === 200 &&
          page.cache.includes('no-store') &&
          !page.text.includes('admin.reports.') &&
          !leaksCost(page.text) &&
          !leaksCost(rsc.text);
        const why = `status ${String(page.status)} cache ${page.cache} rawkeys ${String(page.text.includes('admin.reports.'))} leakHtml ${String(COST_MARKERS.find((m) => page.text.includes(m)))} leakRsc ${String(COST_MARKERS.find((m) => rsc.text.includes(m)))}`;
        check(
          `reports: ${name} (${locale}) for the manager renders, no raw keys, no cost in HTML or RSC${ok ? '' : ` :: ${why}`}`,
          ok,
        );
      }
    }
    const revenue = await get(
      `/admin/reports/revenue?${RANGE}&granularity=month`,
      cookie('manager', 'en'),
    );
    check(
      'reports: the revenue screen shows the gross receipts of the fixture (50 010.00 in the English format)',
      revenue.text.includes('Gross receipts') && revenue.text.includes('50,010.00'),
    );
    const marginManager = await get(`/admin/reports/margin?${RANGE}`, cookie('manager'));
    // A forbidden or unknown report answers like a missing page: the status may already be sent when the
    // shell streams, so the proof is that no report content is in the body (a page, never a table).
    const showsNoReport = (page: { text: string }): boolean =>
      !page.text.includes('<table') &&
      !page.text.includes('Cost of goods') &&
      !page.text.includes('Goods revenue') &&
      !page.text.includes('Gross receipts');
    const nonsense = await get(`/admin/reports/nonsense?${RANGE}`, cookie('manager'));
    check(
      `reports: the margin report is not given to a manager, exactly like an unknown report :: ${String(marginManager.status)} ${String(nonsense.status)}`,
      showsNoReport(marginManager) &&
        showsNoReport(nonsense) &&
        marginManager.status === nonsense.status &&
        !leaksCost(marginManager.text),
    );
    const exportManager = await get(`/admin/export/reports/revenue?${RANGE}`, cookie('manager'));
    check(
      'reports: the export refuses a manager before any query (403 JSON, no-store, nosniff)',
      exportManager.status === 403 &&
        exportManager.cache.includes('no-store') &&
        exportManager.headers.get('x-content-type-options') === 'nosniff' &&
        !exportManager.text.includes('gross'),
    );

    // The dashboard, by role (both languages for the manager).
    for (const locale of ['en', 'uk'] as const) {
      const overview = await get('/admin', cookie('manager', locale));
      check(
        `reports: the manager's overview (${locale}) has key figures and alerts, no margin, no cost (HTML and RSC)`,
        overview.status === 200 &&
          !overview.text.includes('admin.dashboardReports.') &&
          (locale === 'en'
            ? overview.text.includes('Gross receipts') && overview.text.includes('Needs attention')
            : overview.text.includes('Валові надходження') &&
              overview.text.includes('Потребує уваги')) &&
          !/>(Margin|Маржа)</.test(overview.text) &&
          !leaksCost(overview.text) &&
          !leaksCost((await get('/admin', { ...cookie('manager', locale), RSC: '1' })).text),
      );
    }
    const contentOverview = await get('/admin', cookie('content'));
    check(
      'reports: a content editor sees the plain welcome: no figure, no alert',
      contentOverview.status === 200 &&
        !contentOverview.text.includes('Gross receipts') &&
        !contentOverview.text.includes('Needs attention'),
    );

    // Content editor: no report at all.
    const contentIndex = await get('/admin/reports', cookie('content'));
    const contentRevenue = await get(`/admin/reports/revenue?${RANGE}`, cookie('content'));
    const contentExport = await get(`/admin/export/reports/revenue?${RANGE}`, cookie('content'));
    check(
      'reports: a content editor gets no list, no report and a 403 on the export',
      showsNoReport(contentIndex) &&
        !contentIndex.text.includes('/admin/reports/') &&
        showsNoReport(contentRevenue) &&
        contentExport.status === 403,
    );

    // Owner: margin, cost columns, the export.
    const ownerOverview = await get('/admin', cookie('owner'));
    check(
      'reports: the owner overview has the margin key figure',
      ownerOverview.status === 200 && />Margin</.test(ownerOverview.text),
    );
    const margin = await get(`/admin/reports/margin?${RANGE}`, cookie('owner'));
    check(
      'reports: the owner reads the margin report with the cost columns',
      margin.status === 200 &&
        margin.text.includes('Cost of goods') &&
        margin.text.includes('Margin'),
    );
    const ownerStock = await get('/admin/reports/stock?threshold=1000', cookie('owner'));
    check(
      'reports: the owner sees the stock cost column, the manager does not',
      ownerStock.text.includes('Stock value at cost') &&
        !(await get('/admin/reports/stock?threshold=1000', cookie('manager'))).text.includes(
          'Stock value at cost',
        ),
    );
    const csv = await get(
      `/admin/export/reports/revenue?${RANGE}&granularity=month`,
      cookie('owner'),
    );
    check(
      'reports: the owner CSV is a download, private no-store, nosniff, with the data time',
      csv.status === 200 &&
        (csv.headers.get('content-type') ?? '').startsWith('text/csv') &&
        csv.cache.includes('no-store') &&
        csv.headers.get('x-content-type-options') === 'nosniff' &&
        (csv.headers.get('content-disposition') ?? '').includes('attachment') &&
        csv.headers.has('x-report-as-of') &&
        csv.text.includes('bucket,gross,refunds,net') &&
        csv.text.includes('50010.00'),
    );
    const top = await get(`/admin/export/reports/top-products?${RANGE}`, cookie('owner'));
    check(
      'reports: a product name that starts like a formula is text in the file',
      top.status === 200 && top.text.includes(`'=HYPERLINK`) && !/(^|,)=HYPERLINK/m.test(top.text),
    );
    const marginCsv = await get(`/admin/export/reports/margin?${RANGE}`, cookie('owner'));
    check(
      'reports: the margin CSV (owner) carries the cost columns',
      marginCsv.status === 200 && marginCsv.text.includes('costOfGoods'),
    );
    const bad = await get(
      '/admin/export/reports/revenue?from=2026-02-30&to=2026-03-01',
      cookie('owner'),
    );
    const huge = await get(
      '/admin/export/reports/revenue?from=2000-01-01&to=2026-12-31',
      cookie('owner'),
    );
    check(
      'reports: an impossible and a huge period are a 400, never a 500',
      bad.status === 400 && huge.status === 400,
    );
    const rows = await db.select({ entity: auditLog.entity, diff: auditLog.diff }).from(auditLog);
    check(
      'reports: every download is audited with report, period, rows and cost inclusion',
      rows.some(
        (row) =>
          row.entity === 'report' &&
          typeof row.diff === 'object' &&
          row.diff !== null &&
          'report' in row.diff &&
          'includedCost' in row.diff,
      ),
    );
    const forged = await get('/admin/export/reports/revenue?from=2026-01-01&to=2026-02-01', {
      Cookie: 'admin_session=forged',
    });
    check(
      'reports: a forged cookie gets no report file',
      forged.status === 401 && !forged.text.includes('gross'),
    );
  } finally {
    await close();
  }
}
