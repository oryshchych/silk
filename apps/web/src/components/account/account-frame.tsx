import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import type { CustomerSession } from '@store/core/customer-session';

import { SignOutButton } from '@/components/account/sign-out-button';
import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { requireCustomer } from '@/lib/account/session';
import { href, paths } from '@/lib/paths';

const SECTIONS = [
  { path: paths.accountOrders, key: 'orders' },
  { path: paths.accountProfile, key: 'profile' },
  { path: paths.accountAddresses, key: 'addresses' },
] as const;

/**
 * The frame of every signed-in page: the locale, the session (a redirect to sign-in without one),
 * the section links and the title. Per request and per person, never cached.
 */
export async function AccountFrame({
  rawLocale,
  path,
  title,
  children,
}: {
  rawLocale: string;
  path: string;
  title: (t: Awaited<ReturnType<typeof getTranslations<'account'>>>) => string;
  children: (context: {
    locale: 'uk' | 'en';
    customer: CustomerSession;
  }) => Promise<ReactNode> | ReactNode;
}) {
  const { locale, known } = resolveLocale(rawLocale);
  if (!known) notFound();
  const customer = await requireCustomer(locale);
  const t = await getTranslations('account');
  return (
    <SiteShell locale={locale} path={path} degrade>
      <h1 className="font-display text-3xl">{title(t)}</h1>
      <nav aria-label={t('sections')} className="my-4">
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {SECTIONS.map((section) => (
            <li key={section.key}>
              <Link
                href={href(locale, section.path)}
                className="inline-flex min-h-6 items-center underline"
              >
                {t(`section.${section.key}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex flex-col gap-6">
        {await children({ locale, customer })}
        <div>
          <SignOutButton locale={locale} />
        </div>
      </div>
    </SiteShell>
  );
}
