import { getTranslations } from 'next-intl/server';

import { setLocaleAction, setThemeAction } from '@/actions/admin-prefs';
import { ADMIN_LOCALES, THEMES, type AdminLocale, type Theme } from '@/lib/admin/preferences';

const itemClass =
  'min-h-11 min-w-11 rounded-md border border-border px-3 aria-pressed:bg-accent aria-pressed:text-accent-contrast';

/**
 * Theme and language as plain forms: they work without client JavaScript, and the choice is a
 * cookie the server reads, so the page that comes back is already in the right theme.
 */
export async function PreferenceSwitches({ theme, locale }: { theme: Theme; locale: AdminLocale }) {
  const t = await getTranslations({ locale, namespace: 'admin.shell' });
  const themeLabel: Record<Theme, string> = {
    light: t('themeLight'),
    dark: t('themeDark'),
    system: t('themeSystem'),
  };
  const localeLabel: Record<AdminLocale, string> = { uk: t('languageUk'), en: t('languageEn') };
  return (
    <div className="flex flex-wrap gap-4">
      <form action={setThemeAction} aria-label={t('theme')} className="flex flex-wrap gap-2">
        {THEMES.map((value) => (
          <button
            key={value}
            type="submit"
            name="theme"
            value={value}
            aria-pressed={theme === value}
            className={itemClass}
          >
            {themeLabel[value]}
          </button>
        ))}
      </form>
      <form action={setLocaleAction} aria-label={t('language')} className="flex flex-wrap gap-2">
        {ADMIN_LOCALES.map((value) => (
          <button
            key={value}
            type="submit"
            name="locale"
            value={value}
            aria-pressed={locale === value}
            lang={value}
            className={itemClass}
          >
            {localeLabel[value]}
          </button>
        ))}
      </form>
    </div>
  );
}
