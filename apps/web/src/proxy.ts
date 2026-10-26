import createMiddleware from 'next-intl/middleware';

import { routing } from './i18n/routing';

/**
 * Next.js 16: `proxy.ts`, named export `proxy`, runtime nodejs (AGENTS.md §4).
 * Тут лише мовна маршрутизація. Перевірки ролей — у самих server actions
 * (AGENTS.md §2.6), проксі — зручність, не безпека.
 */
export const proxy = createMiddleware(routing);

export const config = {
  // Усе, крім API, внутрішніх шляхів Next і файлів із розширенням.
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
