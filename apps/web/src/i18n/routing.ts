import { defineRouting } from 'next-intl/routing';

/**
 * `/` — українська (основна), `/en/*` — англійська.
 *
 * Мову за Accept-Language НЕ вгадуємо й cookie не ставимо: редирект за
 * заголовком ламає індексацію (бот бачить не ту мову) і робить відповідь
 * некешованою. Мова — тільки з URL.
 */
export const routing = defineRouting({
  locales: ['uk', 'en'],
  defaultLocale: 'uk',
  localePrefix: 'as-needed',
  localeDetection: false,
  localeCookie: false,
});

export type Locale = (typeof routing.locales)[number];
