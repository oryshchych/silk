/**
 * Smoke test of the BUILT web app on a real server (run `pnpm --filter web
 * build` first): `pnpm smoke:web`. Unit tests mock next-intl and the Next
 * runtime, so locale routing, the redirect, the 404 pages and the runtime
 * `SITE_URL` are only provable here.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const port = 3917;
const base = `http://localhost:${String(port)}`;
const SITE = 'https://smoke.example';

const server = spawn(
  process.execPath,
  [join(root, 'apps/web/.next/standalone/apps/web/server.js')],
  {
    env: {
      PORT: String(port),
      APP_ENV: 'production',
      SITE_URL: SITE,
      DATABASE_URL: 'postgres://u:p@localhost:5432/d',
      // Production needs every secret; the values are never used by these pages.
      ...Object.fromEntries(
        [
          'AUTH_SECRET',
          'MONO_PLATA_TOKEN',
          'WAYFORPAY_MERCHANT_ACCOUNT',
          'WAYFORPAY_SECRET_KEY',
          'NOVA_POSHTA_API_KEY',
          'RESEND_API_KEY',
          'R2_ACCOUNT_ID',
          'R2_ACCESS_KEY_ID',
          'R2_SECRET_ACCESS_KEY',
          'R2_BUCKET_MEDIA',
        ].map((key) => [key, 'smoke']),
      ),
    },
    stdio: 'ignore',
  },
);

const failures: string[] = [];
const check = (name: string, ok: boolean): void => {
  if (!ok) failures.push(name);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}\n`);
};

async function get(
  path: string,
): Promise<{ status: number; location: string | null; html: string }> {
  const response = await fetch(base + path, { redirect: 'manual' });
  return {
    status: response.status,
    location: response.headers.get('location'),
    html: await response.text(),
  };
}

async function waitReady(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/api/health`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error('server did not start');
}

try {
  await waitReady();

  const uk = await get('/');
  check('/ is 200 with <html lang="uk">', uk.status === 200 && uk.html.includes('<html lang="uk"'));
  check('/ canonical uses the runtime SITE_URL', uk.html.includes(`rel="canonical" href="${SITE}`));

  const en = await get('/en');
  check(
    '/en is 200 with <html lang="en">',
    en.status === 200 && en.html.includes('<html lang="en"'),
  );
  check(
    '/en has reciprocal hreflang and x-default',
    ['uk', 'en', 'x-default'].every((l) => en.html.includes(`hrefLang="${l}"`)),
  );

  const prefixed = await get('/uk/zzz?a=1');
  const target = prefixed.location === null ? null : new URL(prefixed.location, base).href;
  check(
    '/uk/zzz?a=1 redirects 308 to /zzz?a=1',
    prefixed.status === 308 && target === `${base}/zzz?a=1`,
  );

  for (const path of ['/nope', '/en/nope', '/en/a/b']) {
    const page = await get(path);
    check(
      `${path} is a real 404, noindex, server-rendered with lang and text`,
      page.status === 404 &&
        page.html.includes('name="robots" content="noindex"') &&
        page.html.includes('<html lang="uk"') &&
        !page.html.includes('__next_error__') &&
        page.html.includes('Сторінку не знайдено'),
    );
  }
} finally {
  server.kill();
}

if (failures.length > 0) {
  process.stderr.write(`\n${String(failures.length)} check(s) failed\n`);
  process.exit(1);
}
