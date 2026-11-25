/** Admin theme and language: two cookies, read on the server, so the first paint is already right. */
export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];
export const ADMIN_LOCALES = ['uk', 'en'] as const;
export type AdminLocale = (typeof ADMIN_LOCALES)[number];

export const THEME_COOKIE = 'admin_theme';
export const LOCALE_COOKIE = 'admin_locale';

export function parseTheme(value: string | null | undefined): Theme {
  return THEMES.find((theme) => theme === value) ?? 'system';
}

export function parseAdminLocale(value: string | null | undefined): AdminLocale {
  return ADMIN_LOCALES.find((locale) => locale === value) ?? 'uk';
}
