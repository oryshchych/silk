import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import { logoutAction } from '@/actions/admin-auth';
import { PreferenceSwitches } from '@/components/admin/preference-switches';
import { LOCALE_COOKIE, THEME_COOKIE, parseAdminLocale, parseTheme } from '@/lib/admin/preferences';
import { requireFullSession } from '@/lib/admin/session';
import { toAdminSessionDto } from '@/lib/admin/session-dto';

/**
 * The shell of every signed-in page. The session is required HERE (a redirect to the right login
 * step otherwise), and again by every action; `proxy.ts` only saves a round trip.
 */
export default async function AdminShellLayout({ children }: { children: React.ReactNode }) {
  const session = toAdminSessionDto(await requireFullSession());
  const jar = await cookies();
  const locale = parseAdminLocale(jar.get(LOCALE_COOKIE)?.value);
  const theme = parseTheme(jar.get(THEME_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.shell' });

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:bg-surface focus:p-2"
      >
        {t('skip')}
      </a>
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-surface-raised px-4 py-3">
        <span className="font-semibold">{t('brand')}</span>
        <nav aria-label={t('nav')}>
          <a
            href="/admin"
            aria-current="page"
            className="inline-flex min-h-11 items-center underline"
          >
            {t('dashboard')}
          </a>
          {session.permissions.includes('orders.view') ? (
            <a href="/admin/orders" className="ml-4 inline-flex min-h-11 items-center underline">
              {t('orders')}
            </a>
          ) : null}
          {session.permissions.includes('customers.view') ? (
            <a href="/admin/customers" className="ml-4 inline-flex min-h-11 items-center underline">
              {t('customers')}
            </a>
          ) : null}
          {session.permissions.includes('returns.manage') ? (
            <a href="/admin/returns" className="ml-4 inline-flex min-h-11 items-center underline">
              {t('returns')}
            </a>
          ) : null}
          {session.permissions.includes('reviews.moderate') ? (
            <a href="/admin/reviews" className="ml-4 inline-flex min-h-11 items-center underline">
              {t('reviews')}
            </a>
          ) : null}
          {session.permissions.includes('users.manage') ? (
            <a href="/admin/users" className="ml-4 inline-flex min-h-11 items-center underline">
              {t('users')}
            </a>
          ) : null}
          <a href="/admin/products" className="ml-4 inline-flex min-h-11 items-center underline">
            {t('products')}
          </a>
          <a
            href="/admin/import-export"
            className="ml-4 inline-flex min-h-11 items-center underline"
          >
            {t('importExport')}
          </a>
          <a href="/admin/categories" className="ml-4 inline-flex min-h-11 items-center underline">
            {t('categories')}
          </a>
          <a
            href="/admin/dictionaries"
            className="ml-4 inline-flex min-h-11 items-center underline"
          >
            {t('dictionaries')}
          </a>
        </nav>
        <PreferenceSwitches theme={theme} locale={locale} />
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-text-muted">
            {t('signedInAs')} {session.email} ({t(`role.${session.role}`)})
          </span>
          <form action={logoutAction}>
            <button
              type="submit"
              className="min-h-11 min-w-11 rounded-md border border-border px-3"
            >
              {t('logout')}
            </button>
          </form>
        </div>
      </header>
      <main id="main" className="px-4 py-6">
        {children}
      </main>
    </div>
  );
}
