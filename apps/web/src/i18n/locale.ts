import { hasLocale } from 'next-intl';

import { routing, type Locale } from './routing';

/**
 * The locale of a request, or the default one for an unknown URL segment.
 * The locale layout is the root layout, so it must always render a valid
 * `<html lang>`; unknown segments (`/nope`) are rejected by the page with
 * `notFound()`, which the locale `not-found.tsx` renders inside that layout.
 */
export function resolveLocale(segment: string): { locale: Locale; known: boolean } {
  return hasLocale(routing.locales, segment)
    ? { locale: segment, known: true }
    : { locale: routing.defaultLocale, known: false };
}
