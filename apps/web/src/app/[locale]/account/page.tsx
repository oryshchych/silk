import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { SignOutButton } from '@/components/account/sign-out-button';
import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { requireCustomer } from '@/lib/account/session';
import { paths } from '@/lib/paths';

type Props = PageProps<'/[locale]/account'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'account' });
  const tm = await getTranslations({ locale, namespace: 'meta' });
  return { title: `${t('title')} | ${tm('siteName')}`, robots: { index: false, follow: false } };
}

/** Per request and per person: it reads the session, so it is never part of the shared page cache. */
export default async function AccountPage({ params }: Props) {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) notFound();
  const customer = await requireCustomer(locale);
  const t = await getTranslations('account');
  return (
    <SiteShell locale={locale} path={paths.account} degrade>
      <h1 className="font-display text-3xl">{t('title')}</h1>
      <p className="mb-6 mt-2 text-text-muted">{t('signedInAs', { email: customer.email })}</p>
      <SignOutButton locale={locale} />
    </SiteShell>
  );
}
