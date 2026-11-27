import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';

import { clientAdminMessages } from '@/lib/admin/client-messages';
import { currentSession } from '@/lib/admin/session';
import { LOCALE_COOKIE, THEME_COOKIE, parseAdminLocale, parseTheme } from '@/lib/admin/preferences';

import '../globals.css';
import './admin.css';

/**
 * The admin's OWN root layout (the storefront's is `app/[locale]/layout.tsx`). It reads cookies, so
 * every admin page is rendered per request and never enters the ISR cache; the theme attribute it
 * sets exists nowhere in the storefront's HTML (ADR-21). Never indexed, whatever the environment.
 */
export async function generateMetadata(): Promise<Metadata> {
  const locale = parseAdminLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const t = await getTranslations({ locale, namespace: 'admin.meta' });
  return {
    title: t('title'),
    description: t('description'),
    robots: { index: false, follow: false },
  };
}

export default async function AdminRootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const locale = parseAdminLocale(jar.get(LOCALE_COOKIE)?.value);
  const theme = parseTheme(jar.get(THEME_COOKIE)?.value);
  const messages = await getMessages({ locale });
  // Per visitor, from the session: anonymous and half-signed-in visitors get the login flow only, a full
  // session gets the namespaces its role may open (`client-messages.ts`); reports never leave the server.
  const resolved = await currentSession();
  const clientAdmin = clientAdminMessages(
    messages.admin,
    resolved?.kind === 'full' ? resolved.session.role : null,
  );

  return (
    <html lang={locale} data-theme={theme}>
      <body className="min-h-dvh bg-surface text-text-primary antialiased">
        <NextIntlClientProvider locale={locale} messages={{ admin: clientAdmin }}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
