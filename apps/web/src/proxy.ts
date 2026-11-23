import { isProductSlug } from '@store/core/product-slug';
import { env } from '@store/shared/env';
import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';

import { routing } from './i18n/routing';
import { stripDefaultLocalePrefix } from './lib/locale-redirect';
import { missingPath, parseProductPath } from './lib/product-path';
import { knownProductSlugs } from './lib/product-slugs';
import { isAuthorized, parseExcludeList, requiresAuth } from './lib/staging-gate';

/**
 * Next.js 16: `proxy.ts`, named export `proxy`, runtime nodejs (AGENTS.md §4).
 *
 *  1. Staging закритий basic auth (ENVIRONMENTS.md) — на всьому, крім точних
 *     POST-маршрутів вебхуків і /api/health.
 *  2. Поза production — `X-Robots-Tag: noindex, nofollow` на кожній відповіді.
 *  3. Мовна маршрутизація — лише для сторінок, не для /api і файлів.
 *
 * Перевірки ролей тут НЕМАЄ: вони в самих server actions (AGENTS.md §2.6).
 */
const intl = createMiddleware(routing);

const gate =
  env.APP_ENV === 'staging'
    ? {
        user: env.STAGING_BASIC_AUTH_USER ?? '',
        password: env.STAGING_BASIC_AUTH_PASSWORD ?? '',
        webhookPaths: parseExcludeList(env.STAGING_BASIC_AUTH_EXCLUDE),
      }
    : null;

/** Non-production environments are never indexed (third layer after basic auth and robots.txt). */
function withNoindex(response: NextResponse): NextResponse {
  if (env.APP_ENV !== 'production') response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (
    gate !== null &&
    requiresAuth(request.method, pathname, gate) &&
    !isAuthorized(request.headers.get('authorization'), gate)
  ) {
    return new NextResponse('Authentication required', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="staging", charset="UTF-8"',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  }

  // `/uk/...` -> `/...` permanently (308 keeps the method, search engines
  // treat it as a 301). Query string is preserved.
  const unprefixed = stripDefaultLocalePrefix(pathname);
  if (unprefixed !== null) {
    const target = request.nextUrl.clone();
    target.pathname = unprefixed;
    return withNoindex(NextResponse.redirect(target, 308));
  }

  // An unknown or malformed product slug is answered here with the server-rendered
  // 404 page, BEFORE the ISR product route: Next stores every distinct slug that
  // reaches it (a 404 included) in its page cache, which a client could fill
  // without limit. A slug that cannot exist (shape) never touches the database;
  // a well-formed one is checked against the in-memory set of visible slugs
  // (refreshed every minute, stale-on-error). If the set cannot be loaded at all,
  // the request passes and the page decides.
  const product = parseProductPath(pathname);
  if (product !== null && (request.method === 'GET' || request.method === 'HEAD')) {
    const known = isProductSlug(product.slug) ? await knownProductSlugs.has(product.slug) : false;
    if (known === false) {
      const target = request.nextUrl.clone();
      target.pathname = missingPath(product.locale);
      target.search = '';
      const response = NextResponse.rewrite(target);
      response.headers.set('Cache-Control', 'no-store');
      return withNoindex(response);
    }
  }

  // Мовна маршрутизація — лише для сторінок: не для API і не для файлів
  // (robots.txt, sitemap.xml), інакше next-intl перепише їх у /uk/....
  const isPage = !pathname.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(pathname);
  return withNoindex(isPage ? intl(request) : NextResponse.next());
}

export const config = {
  // Усе, крім внутрішніх ресурсів Next. /api включено свідомо: basic auth
  // мусить закривати й API, інакше staging відкритий через нього.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
