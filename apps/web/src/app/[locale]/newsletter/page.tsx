import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { SubscribeForm } from '@/components/newsletter/subscribe-form';
import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { paths } from '@/lib/paths';

type Props = PageProps<'/[locale]/newsletter'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'newsletter' });
  return { title: t('title'), robots: { index: false, follow: false } };
}

/** The sign-up form: the same page for every visitor, nothing about the visitor in it. */
export default async function NewsletterPage({ params }: Props) {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) notFound();
  const t = await getTranslations('newsletter');
  return (
    <SiteShell locale={locale} path={paths.newsletter} degrade>
      <h1 className="font-display text-3xl">{t('title')}</h1>
      <p className="mb-6 mt-2 text-text-muted">{t('intro')}</p>
      <SubscribeForm />
    </SiteShell>
  );
}
