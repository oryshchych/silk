import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { getTranslations } from 'next-intl/server';

import { resolveLocale } from '@/i18n/locale';
import { getSiteUrl } from '@/lib/site-url';

import '../globals.css';

// No generateStaticParams on purpose: nothing under [locale] is prerendered at
// build time, so getSiteUrl() reads the RUNTIME SITE_URL (ADR-10); getSiteUrl()
// fails the build if that ever stops being true. Pages are rendered per request
// (the product page is ISR with tags).

export async function generateMetadata({ params }: LayoutProps<'/[locale]'>): Promise<Metadata> {
  const { locale } = resolveLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: 'meta' });
  return {
    title: t('title'),
    description: t('description'),
    metadataBase: new URL(await getSiteUrl()),
  };
}

export default async function LocaleLayout({ children, params }: LayoutProps<'/[locale]'>) {
  // The root layout always renders a valid <html lang>. An unknown segment
  // (`/nope`) is rejected by the page with notFound(); app/global-not-found.tsx renders it.
  const { locale } = resolveLocale((await params).locale);
  const messages = await getMessages();

  return (
    <html lang={locale}>
      <body className="min-h-dvh bg-surface text-text-primary antialiased">
        {/* Only the namespaces client components use: not the whole bundle on every page. */}
        <NextIntlClientProvider messages={{ errors: messages.errors, product: messages.product }}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
