/** Dates in the admin are shown in Kyiv time whatever the server's zone is. */
export function formatWhen(iso: string, locale: 'uk' | 'en'): string {
  return new Date(iso).toLocaleString(locale === 'uk' ? 'uk-UA' : 'en-GB', {
    timeZone: 'Europe/Kyiv',
  });
}
