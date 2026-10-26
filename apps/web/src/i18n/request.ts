import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { locale as rootLocale } from 'next/root-params';

import { routing } from './routing';

/**
 * Локаль — з кореневого сегмента `[locale]` (`next/root-params`), а не з
 * заголовків. Явна локаль (`getTranslations({ locale })`) має пріоритет.
 * Невідоме значення сегмента (`/unknown.txt`) замінюється дефолтною.
 */
export default getRequestConfig(async ({ locale: explicit }) => {
  const candidate = explicit ?? (await rootLocale());
  const locale = hasLocale(routing.locales, candidate) ? candidate : routing.defaultLocale;
  const messages = (await import(`../../messages/${locale}.json`)) as { default: IntlMessages };
  return { locale, messages: messages.default };
});
