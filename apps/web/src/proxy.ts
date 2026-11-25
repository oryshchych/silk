import { isProductSlug } from '@store/core/product-slug';
import { env } from '@store/shared/env';
import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';

import { routing } from './i18n/routing';
import { stripDefaultLocalePrefix } from './lib/locale-redirect';
import { clientAddress, UNKNOWN_CLIENT } from './lib/client-address';
import { isAdminAuthPath, isAdminPath } from './lib/admin-path';
import { SESSION_COOKIE } from './lib/admin/cookies';
import { missingPath, parseProductPath } from './lib/product-path';
import { knownProductSlugs } from './lib/product-slugs';
import { createRateLimiter } from './lib/rate-limit';
import { isSearchPath } from './lib/search-path';
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

// Search runs a ranked full-text and trigram query, so it is the one public read
// route that is limited per client (per instance, in memory). Every method but
// OPTIONS and every spelling of the path counts: the limit is on the route.
const searchLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });
// A cap over ALL clients: per-network limits cannot stop an attacker with many networks.
// Generous for honest traffic (10 searches a second), a safety net for the database.
const searchGlobalLimiter = createRateLimiter({ limit: 600, windowMs: 60_000, maxKeys: 1 });
const GLOBAL_KEY = 'all';
// The admin. Credential pages (a login form and its server actions are POSTs to the page URL) get
// a hard per-client limit and a cap over all clients; the rest of the admin a generous one. Every
// method but OPTIONS counts, on every spelling of the path (`isAdminPath` decodes and normalises).
const adminAuthLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });
const adminAuthGlobalLimiter = createRateLimiter({ limit: 600, windowMs: 60_000, maxKeys: 1 });
const adminLimiter = createRateLimiter({ limit: 300, windowMs: 60_000 });
// Reverse proxies that append to X-Forwarded-For and are trusted (Traefik: 1).
const trustedHops = env.TRUSTED_PROXY_HOPS ?? 1;
let unknownClientLoggedAt = Number.NEGATIVE_INFINITY;

/** Requests without a trustworthy client address share one bucket; say so once a minute. */
function noteUnknownClient(): void {
  const now = performance.now();
  if (now - unknownClientLoggedAt < 60_000) return;
  unknownClientLoggedAt = now;
  process.stderr.write(
    `${JSON.stringify({ level: 'warn', scope: 'rate-limit', reason: 'no trustworthy client address, shared bucket', trustedHops })}\n`,
  );
}

/** Non-production environments are never indexed (third layer after basic auth and robots.txt). */
function withNoindex(response: NextResponse): NextResponse {
  if (env.APP_ENV !== 'production') response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

/** Admin responses are never stored (shared caches, the browser's back button) and never indexed. */
function adminHeaders(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

/**
 * The admin: limits, headers and one convenience redirect. NOT access control: a request with a
 * forged or stale cookie passes here and is refused by the page or the action, which read the
 * session from the database and check the role themselves (AGENTS.md section 2.6).
 */
function handleAdmin(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (request.method === 'OPTIONS') return adminHeaders(NextResponse.next());
  const client = clientAddress(request.headers.get('x-forwarded-for'), trustedHops);
  if (client === UNKNOWN_CLIENT) noteUnknownClient();
  const authPath = isAdminAuthPath(pathname);
  const clientVerdict = (authPath ? adminAuthLimiter : adminLimiter).check(client);
  // The cap over ALL clients counts only requests that try a credential (POST): a flood of plain
  // page loads must not be able to lock every legitimate admin out.
  const tries = request.method !== 'GET' && request.method !== 'HEAD';
  const verdict =
    authPath && tries && clientVerdict.allowed
      ? adminAuthGlobalLimiter.check(GLOBAL_KEY)
      : clientVerdict;
  if (!verdict.allowed) {
    return adminHeaders(
      new NextResponse('Too many requests', {
        status: 429,
        headers: { 'Retry-After': String(verdict.retryAfterSeconds) },
      }),
    );
  }
  const reading = request.method === 'GET' || request.method === 'HEAD';
  if (reading && !authPath && !request.cookies.has(SESSION_COOKIE)) {
    const target = request.nextUrl.clone();
    target.pathname = '/admin/login';
    target.search = '';
    return adminHeaders(NextResponse.redirect(target, 307));
  }
  return adminHeaders(NextResponse.next());
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

  if (isAdminPath(pathname)) return withNoindex(handleAdmin(request));

  if (request.method !== 'OPTIONS' && isSearchPath(pathname)) {
    const client = clientAddress(request.headers.get('x-forwarded-for'), trustedHops);
    if (client === UNKNOWN_CLIENT) noteUnknownClient();
    const clientVerdict = searchLimiter.check(client);
    // Only a request the client's own limit let through counts against the shared cap.
    const verdict = clientVerdict.allowed ? searchGlobalLimiter.check(GLOBAL_KEY) : clientVerdict;
    if (!verdict.allowed) {
      return withNoindex(
        new NextResponse('Too many requests', {
          status: 429,
          headers: {
            'Retry-After': String(verdict.retryAfterSeconds),
            'Cache-Control': 'no-store',
          },
        }),
      );
    }
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
