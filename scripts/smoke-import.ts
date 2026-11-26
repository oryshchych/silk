/**
 * Phase 9: the CSV import ROUTE and the content template on the BUILT server (called from
 * smoke-web.ts). Real sessions of an owner (may import), a content editor and a manager (may not),
 * and the real proxy in front: an upload far over the proxy's 64 KB body limit goes through (it is
 * the route's own cap that applies), the refusals happen before the body is read, a slow upload
 * holds the single in-flight slot (the next one gets 429 BUSY), an oversize or non-UTF-8 body is
 * refused, a preview writes nothing, a commit writes every row, and a formula cell comes back out of
 * the export neutralised.
 */
import {
  beginLogin,
  confirmTotpEnrolment,
  createAdminUser,
  startTotpEnrolment,
} from '../packages/core/src/auth/service.ts';
import { codeAt, stepOf } from '../packages/core/src/auth/totp.ts';
import net from 'node:net';

import { createDb } from '../packages/db/src/client.ts';
import { categories, products } from '../packages/db/src/schema.ts';

interface Context {
  base: string;
  databaseUrl: string;
  authSecret: string;
  siteOrigin: string;
  check: (name: string, ok: boolean) => void;
}

const PASSWORD = 'smoke-import-password-0123456789';
const client = { ip: '198.51.100.99', userAgent: 'smoke-import' };

export async function runImportSmoke({
  base,
  databaseUrl,
  authSecret,
  siteOrigin,
  check,
}: Context) {
  const config = { secret: authSecret };
  const { db, close } = createDb(databaseUrl, { max: 2 });
  const suffix = String(Date.now());
  let counter = 0;
  const nextClient = (): string => `203.0.113.${String(++counter + 200)}`;
  const origin = { Origin: siteOrigin, 'X-Forwarded-Host': new URL(siteOrigin).host };

  try {
    const owner = `owner-import-${suffix}@example.test`;
    await db.transaction(async (tx) => {
      await createAdminUser(tx, { email: owner, password: PASSWORD, role: 'owner' });
      for (const role of ['content', 'manager'] as const)
        await createAdminUser(tx, {
          email: `${role}-import-${suffix}@example.test`,
          password: PASSWORD,
          role,
        });
    });
    const login = async (email: string) => {
      const result = await db.transaction(
        async (tx) => await beginLogin(tx, config, { email, password: PASSWORD, client }),
      );
      if (!result.ok) throw new Error('smoke import account could not sign in');
      return result;
    };
    const pending = await login(owner);
    const enrol = await db.transaction(
      async (tx) => await startTotpEnrolment(tx, config, { token: pending.token }),
    );
    if (enrol === null) throw new Error('smoke import enrolment failed');
    const full = await db.transaction(
      async (tx) =>
        await confirmTotpEnrolment(tx, config, {
          token: pending.token,
          code: codeAt(enrol.secret, stepOf(Date.now())),
          client,
        }),
    );
    if (!full.ok) throw new Error('smoke import owner could not finish enrolment');
    const cookie = (token: string): Record<string, string> => ({
      Cookie: `admin_session=${token}`,
    });
    const ownerCookie = cookie(full.token);
    const contentCookie = cookie((await login(`content-import-${suffix}@example.test`)).token);
    const managerCookie = cookie((await login(`manager-import-${suffix}@example.test`)).token);

    const [category] = await db.select({ slug: categories.slug }).from(categories).limit(1);
    const categorySlug = category?.slug ?? '';

    const post = async (
      mode: string,
      body: string | Buffer | ReadableStream<Uint8Array> | null,
      headers: Record<string, string>,
      extra: RequestInit = {},
    ) => {
      // A pooled connection that the server closed after an earlier refusal can reset the next
      // request (the keep-alive race): a body that can be sent again is retried on a new connection.
      const again = typeof body === 'string' || Buffer.isBuffer(body) ? 3 : 1;
      let response: Response | null = null;
      for (let attempt = 0; attempt < again && response === null; attempt += 1) {
        try {
          response = await fetch(`${base}/admin/upload/products-csv?mode=${mode}`, {
            method: 'POST',
            redirect: 'manual',
            headers: { 'X-Forwarded-For': nextClient(), 'Content-Type': 'text/csv', ...headers },
            body,
            ...extra,
          });
        } catch {
          response = null;
        }
      }
      if (response === null) return { status: 0, cache: '', json: null, text: '' };
      const text = await response.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return {
        status: response.status,
        cache: response.headers.get('cache-control') ?? '',
        json,
        text,
      };
    };
    const code = (r: { json: unknown }): string =>
      typeof r.json === 'object' && r.json !== null && 'code' in r.json ? String(r.json.code) : '';

    // A file far over the proxy's 64 KB body limit: 120 rows with real-sized descriptions.
    const header =
      'sku,slug,brand,category,name_uk,name_en,price,short_description_uk,short_description_en,description_uk,description_en,composition_uk,composition_en,care_uk,care_en,meta_title_uk,meta_title_en,meta_description_uk,meta_description_en';
    const long = (seed: string, n: number): string =>
      `${seed} `.repeat(Math.ceil(n / (seed.length + 1))).slice(0, n);
    const rows = Array.from({ length: 120 }, (_, i) => {
      const n = `${suffix}-${String(i)}`;
      return [
        `SIMP-${n}`,
        `simp-${n}`,
        'Brand',
        categorySlug,
        `Назва ${n}`,
        `Name ${n}`,
        '499.00',
        long(`коротко ${n}`, 60),
        long(`short ${n}`, 60),
        long(`опис ${n}`, 1800),
        long(`description ${n}`, 1800),
        `Бавовна ${n}`,
        `Cotton ${n}`,
        `Прання ${n}`,
        `Wash ${n}`,
        long(`Заголовок ${n}`, 40),
        long(`Title ${n}`, 40),
        long(`Мета ${n}`, 100),
        long(`Meta ${n}`, 100),
      ].join(',');
    });
    const csv = [header, ...rows].join('\n');
    const countImported = async (): Promise<number> =>
      (await db.select({ sku: products.sku }).from(products)).filter((r) =>
        r.sku.startsWith(`SIMP-${suffix}`),
      ).length;

    check('import route: the test file is far over the proxy 64 KB limit', csv.length > 400_000);
    const anonymous = await post('preview', csv, { ...origin });
    check(
      'import route: anonymous is refused 401, private no-store',
      anonymous.status === 401 && anonymous.cache.includes('no-store'),
    );
    const asContent = await post('preview', csv, { ...origin, ...contentCookie });
    const asManager = await post('preview', csv, { ...origin, ...managerCookie });
    check(
      'import route: a content editor and a manager are refused 403 before the body is read',
      asContent.status === 403 && asManager.status === 403 && code(asContent) === 'FORBIDDEN',
    );
    const crossSite = await post('preview', csv, {
      ...ownerCookie,
      Origin: 'https://evil.example',
      'X-Forwarded-Host': new URL(siteOrigin).host,
    });
    check(
      'import route: a cross-site Origin is refused 403',
      crossSite.status === 403 && code(crossSite) === 'BAD_ORIGIN',
    );
    const wrongType = await post('preview', csv, {
      ...origin,
      ...ownerCookie,
      'Content-Type': 'application/json',
    });
    check('import route: another content type is refused 415', wrongType.status === 415);
    const badMode = await post('wipe', csv, { ...origin, ...ownerCookie });
    check('import route: an unknown mode is refused 400', badMode.status === 400);

    const preview = await post('preview', csv, { ...origin, ...ownerCookie });
    const previewRows =
      typeof preview.json === 'object' &&
      preview.json !== null &&
      'data' in preview.json &&
      typeof preview.json.data === 'object' &&
      preview.json.data !== null &&
      'results' in preview.json.data &&
      Array.isArray(preview.json.data.results)
        ? preview.json.data.results.length
        : -1;
    check(
      'import route: the owner previews 120 rows through the real proxy, and nothing is written',
      preview.status === 200 && previewRows === 120 && (await countImported()) === 0,
    );

    const invalid = await post('preview', Buffer.from([0x73, 0x6b, 0x75, 0x0a, 0xff, 0xfe, 0x0a]), {
      ...origin,
      ...ownerCookie,
    });
    check(
      'import route: a body that is not UTF-8 is refused 422',
      invalid.status === 422 && code(invalid) === 'CSV_INVALID_CHARACTERS',
    );
    const huge = await post('preview', Buffer.alloc(2 * 1024 * 1024 + 1, 0x61), {
      ...origin,
      ...ownerCookie,
    });
    check('import route: a body over 2 MB is refused 413', huge.status === 413);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(1024 * 1024).fill(0x61);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const chunked = await post(
      'preview',
      stream,
      { ...origin, ...ownerCookie },
      {
        duplex: 'half',
      },
    );
    check(
      'import route: a body of unknown length is cut at 2 MB (413), not held',
      chunked.status === 413,
    );

    // The single in-flight slot: a slow upload holds it, the next request is turned away at once.
    // The slot is held by an upload that has sent its headers and the first bytes and then goes quiet.
    // Raw sockets give exact control over that, and every request gets a FRESH connection (a pooled
    // one that the server closed after an earlier refusal would reset the next request).
    const rawPost = async (
      body: string,
      delayRestMs: number,
    ): Promise<{ status: number; body: string }> =>
      await new Promise((resolve) => {
        const url = new URL(base);
        const socket = net.connect(Number(url.port), url.hostname);
        const bytes = Buffer.from(body, 'utf8');
        const head = [
          'POST /admin/upload/products-csv?mode=preview HTTP/1.1',
          `Host: ${url.host}`,
          `X-Forwarded-For: ${nextClient()}`,
          `Origin: ${origin.Origin}`,
          `X-Forwarded-Host: ${origin['X-Forwarded-Host']}`,
          `Cookie: ${ownerCookie['Cookie'] ?? ''}`,
          'Content-Type: text/csv',
          `Content-Length: ${String(bytes.length)}`,
          'Connection: close',
          '',
          '',
        ].join('\r\n');
        socket.write(head);
        socket.write(bytes.subarray(0, 4));
        setTimeout(() => {
          socket.write(bytes.subarray(4));
        }, delayRestMs);
        let received = '';
        socket.on('data', (chunk: Buffer) => {
          received += chunk.toString('utf8');
        });
        socket.on('error', () => {
          resolve({ status: 0, body: received });
        });
        socket.on('close', () => {
          resolve({
            status: Number(/^HTTP\/1\.1 (\d+)/.exec(received)?.[1] ?? 0),
            body: received,
          });
        });
      });
    const first = rawPost(`sku\n${' '.repeat(96)}`, 3_000);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const second = await rawPost('sku\n', 0);
    const firstDone = await first;
    check(
      'import route: while one import is in flight the next gets 429 BUSY, and the first finishes',
      second.status === 429 && second.body.includes('BUSY') && firstDone.status === 200,
    );
    const afterwards = await rawPost('sku\n', 0);
    check(
      'import route: the slot is free again once the first import ended',
      afterwards.status === 200,
    );

    const committed = await post('commit', csv, { ...origin, ...ownerCookie });
    check(
      'import route: the commit writes every row',
      committed.status === 200 && (await countImported()) === 120,
    );

    // A formula cell is stored as typed and leaves the export neutralised.
    const formula = `${header}\nSIMP-F-${suffix},simp-f-${suffix},Brand,${categorySlug},"=HYPERLINK(""http://evil.example"",""x"")",Name f,10.00,,,,,,,,,,,,`;
    const formulaCommit = await post('commit', formula, { ...origin, ...ownerCookie });
    const exported = await fetch(`${base}/admin/export/products`, {
      headers: { 'X-Forwarded-For': nextClient(), ...ownerCookie },
    });
    const exportedText = await exported.text();
    check(
      'import route: a formula in a name is imported as text and exported with a leading apostrophe',
      formulaCommit.status === 200 &&
        exportedText.includes(`'=HYPERLINK(`) &&
        !exportedText.includes(',=HYPERLINK('),
    );
    check(
      'export: carries every content column',
      ['short_description_uk', 'care_en', 'meta_description_en'].every(
        (c) => exportedText.split('\n')[0]?.includes(c) === true,
      ),
    );

    // The template.
    const templateAnon = await fetch(`${base}/admin/export/content-template`, {
      redirect: 'manual',
      headers: { 'X-Forwarded-For': nextClient() },
    });
    const templateContent = await fetch(`${base}/admin/export/content-template`, {
      redirect: 'manual',
      headers: { 'X-Forwarded-For': nextClient(), ...contentCookie },
    });
    const template = await fetch(`${base}/admin/export/content-template`, {
      headers: { 'X-Forwarded-For': nextClient(), ...ownerCookie },
    });
    const templateText = await template.text();
    check(
      'template: no session is turned away (the proxy sends it to the login), a role without catalog.import gets 403',
      (templateAnon.status === 401 || templateAnon.status === 307) &&
        templateContent.status === 403,
    );
    check(
      'template: the owner downloads a CSV attachment with the content header and an example row',
      template.status === 200 &&
        (template.headers.get('content-disposition') ?? '').includes('attachment') &&
        (template.headers.get('cache-control') ?? '').includes('no-store') &&
        templateText.includes('meta_description_en') &&
        templateText.includes('EXAMPLE-DO-NOT-IMPORT'),
    );
    const asIs = await post('commit', templateText, { ...origin, ...ownerCookie });
    check(
      'template: uploaded unchanged it loads nothing (the example row is refused)',
      asIs.status === 200 &&
        JSON.stringify(asIs.json).includes('example_row') &&
        JSON.stringify(asIs.json).includes('"created":0'),
    );

    // The screen, in both languages.
    for (const [locale, text] of [
      ['uk', 'Завантажити шаблон'],
      ['en', 'Download the template'],
    ] as const) {
      const page = await fetch(`${base}/admin/import-export`, {
        headers: {
          'X-Forwarded-For': nextClient(),
          Cookie: `${ownerCookie['Cookie'] ?? ''}; admin_locale=${locale}`,
        },
      });
      const html = await page.text();
      check(
        `import screen (${locale}): the template link and the hint render real text, no raw keys`,
        page.status === 200 &&
          html.includes(text) &&
          html.includes('/admin/export/content-template') &&
          !html.includes('admin.importExport.') &&
          !html.includes('MISSING_MESSAGE'),
      );
    }
  } finally {
    await close();
  }
}
