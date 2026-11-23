import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { buildAlternates } from '@store/shared/seo';

import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { loadCategoryTree } from '@/lib/navigation';
import { pageMetadata } from '@/lib/metadata';
import { href, paths } from '@/lib/paths';
import { getSiteUrl } from '@/lib/site-url';

// ISR: rendered on the first request (nothing is prerendered at build, so the
// runtime SITE_URL is used) and regenerated at most hourly; category changes
// refresh it earlier through the `categories` tag.
export const revalidate = 3600;

// An empty list prerenders nothing at build (the runtime SITE_URL is read on the
// first request) but makes the dynamic `[locale]` route ISR-capable: without a
// generateStaticParams export Next renders it per request and never caches it.
export function generateStaticParams(): { locale: string }[] {
  return [];
}

export async function generateMetadata({ params }: PageProps<'/[locale]'>): Promise<Metadata> {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) return {};
  const t = await getTranslations({ locale, namespace: 'meta' });
  return pageMetadata({
    title: t('title'),
    description: t('description'),
    locale,
    siteName: t('siteName'),
    alternates: buildAlternates({ siteUrl: await getSiteUrl(), locale, path: paths.home }),
    index: true,
  });
}

export default async function HomePage({ params }: PageProps<'/[locale]'>) {
  const { locale, known } = resolveLocale((await params).locale);
  if (!known) notFound();
  const t = await getTranslations('home');
  const tree = await loadCategoryTree(locale);
  const first = tree[0];
  const usp = [
    ['usp1Title', 'usp1Text'],
    ['usp2Title', 'usp2Text'],
    ['usp3Title', 'usp3Text'],
  ] as const;

  return (
    <SiteShell locale={locale} path={paths.home}>
      <section className="flex flex-col items-start gap-4 py-8">
        <h1 className="font-display text-4xl tracking-wide">{t('heroTitle')}</h1>
        <p className="max-w-xl text-text-muted">{t('tagline')}</p>
        {first === undefined ? null : (
          <Link
            href={href(locale, paths.category(first.slug))}
            className="min-h-10 rounded-full bg-accent px-6 py-2 text-accent-contrast"
          >
            {t('heroCta')}
          </Link>
        )}
      </section>

      <section aria-labelledby="home-categories" className="py-6">
        <h2 id="home-categories" className="mb-4 font-display text-2xl">
          {t('categoriesTitle')}
        </h2>
        <ul className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {tree.map((category) => (
            <li key={category.id}>
              <Link
                href={href(locale, paths.category(category.slug))}
                className="flex min-h-24 items-center justify-center rounded-sm bg-surface-raised p-4 text-center hover:underline"
              >
                {category.name}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="home-usp" className="py-6">
        <h2 id="home-usp" className="mb-4 font-display text-2xl">
          {t('uspTitle')}
        </h2>
        <ul className="grid gap-4 md:grid-cols-3">
          {usp.map(([title, text]) => (
            <li key={title} className="rounded-sm border border-border p-4">
              <h3 className="font-medium">{t(title)}</h3>
              <p className="mt-1 text-sm text-text-muted">{t(text)}</p>
            </li>
          ))}
        </ul>
      </section>
    </SiteShell>
  );
}
