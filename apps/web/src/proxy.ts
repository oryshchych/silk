import { env } from '@store/shared/env';
import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';

import { routing } from './i18n/routing';
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

export function proxy(request: NextRequest): NextResponse {
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

  // Мовна маршрутизація — лише для сторінок: не для API і не для файлів
  // (robots.txt, sitemap.xml), інакше next-intl перепише їх у /uk/....
  const isPage = !pathname.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(pathname);
  const response = isPage ? intl(request) : NextResponse.next();
  if (env.APP_ENV !== 'production') response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

export const config = {
  // Усе, крім внутрішніх ресурсів Next. /api включено свідомо: basic auth
  // мусить закривати й API, інакше staging відкритий через нього.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
