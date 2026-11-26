import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { parseFaqEntries } from '@store/shared/faq';
import { legalKindFromSlug } from '@store/shared/legal';
import { safeHref } from '@store/shared/rich-text';
import { buildBreadcrumbList, buildFaqPage } from '@store/shared/schema-org';
import { buildAlternates, siteLocales } from '@store/shared/seo';

import { Breadcrumbs } from '@/components/breadcrumbs';
import { CompanyBlock } from '@/components/company-block';
import { JsonLd } from '@/components/json-ld';
import { LegalBody } from '@/components/legal-body';
import { ReturnPolicySummary } from '@/components/return-policy-summary';
import { SiteShell } from '@/components/site-shell';
import { resolveLocale } from '@/i18n/locale';
import { htmlToSnippet } from '@/lib/html-text';
import {
  getCachedCompanyProfile,
  getCachedLegalDocument,
  getCachedLegalNav,
  getCachedReturnWindow,
} from '@/lib/legal';
import { pageMetadata } from '@/lib/metadata';
import { href, paths } from '@/lib/paths';
import { getSiteUrl } from '@/lib/site-url';

type Props = PageProps<'/[locale]/legal/[slug]'>;

// ISR like the product page. The kind is one of seven fixed words (the proxy answers anything else with the
// 404 page before this route), so at most 14 entries can exist; `legal:{kind}` and `legal-nav` refresh them.
export const revalidate = 300;

export function generateStaticParams(): { locale: string; slug: string }[] {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale: segment, slug } = await params;
  const { locale, known } = resolveLocale(segment);
  const kind = known ? legalKindFromSlug(slug) : null;
  if (kind === null) return {};
  const doc = await getCachedLegalDocument(kind, locale);
  if (doc === null) return {};
  const t = await getTranslations({ locale, namespace: 'meta' });
  const siteUrl = await getSiteUrl();
  const nav = await getCachedLegalNav();
  const both = siteLocales.every((code) =>
    nav.some((row) => row.kind === kind && row.locale === code),
  );
  const alternates = buildAlternates({ siteUrl, locale, path: paths.legal(kind) });
  return pageMetadata({
    title: `${doc.title} | ${t('siteName')}`,
    description: htmlToSnippet(doc.bodyHtml, 160),
    locale,
    siteName: t('siteName'),
    // hreflang only when BOTH languages are published: never a pair with a missing counterpart.
    alternates: both ? alternates : { canonical: alternates.canonical },
    index: true,
  });
}

export default async function LegalPage({ params }: Props) {
  const { locale: segment, slug } = await params;
  const { locale, known } = resolveLocale(segment);
  const kind = known ? legalKindFromSlug(slug) : null;
  if (kind === null) notFound();
  const doc = await getCachedLegalDocument(kind, locale);
  if (doc === null) notFound();

  const t = await getTranslations('legal');
  const tn = await getTranslations('nav');
  const siteUrl = await getSiteUrl();
  const profile = kind === 'about' || kind === 'contacts' ? await getCachedCompanyProfile() : null;
  const returnWindow = kind === 'returns' ? await getCachedReturnWindow() : null;
  // Only the questions the page SHOWS go into the structured data.
  const faq = kind === 'faq' && doc.bodyHtml !== null ? parseFaqEntries(doc.bodyHtml) : [];
  const pdf =
    doc.fileUrl !== null && /^https:\/\//.test(doc.fileUrl) ? safeHref(doc.fileUrl) : null;
  const absolute = (path: string): string => {
    const local = href(locale, path);
    return `${siteUrl}${local === '/' ? '' : local}`;
  };
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: 'long',
    timeZone: 'Europe/Kyiv',
  }).format(new Date(doc.effectiveFrom));

  return (
    <SiteShell locale={locale} path={paths.legal(kind)}>
      <JsonLd
        data={buildBreadcrumbList([
          { name: tn('home'), url: absolute(paths.home) },
          { name: doc.title, url: absolute(paths.legal(kind)) },
        ])}
      />
      {faq.length === 0 ? null : <JsonLd data={buildFaqPage(faq)} />}
      <Breadcrumbs
        locale={locale}
        crumbs={[{ name: tn('home'), path: paths.home }, { name: doc.title }]}
      />
      <article className="mt-3 flex max-w-3xl flex-col gap-4">
        <h1 className="font-display text-3xl">{doc.title}</h1>
        <p className="text-sm text-text-muted">{t('effective', { date })}</p>
        {returnWindow === null ? null : <ReturnPolicySummary windowDays={returnWindow} />}
        {doc.bodyHtml === null ? null : <LegalBody html={doc.bodyHtml} />}
        {pdf === null ? null : (
          <p>
            <a
              href={pdf}
              rel="noopener noreferrer"
              className="inline-flex min-h-6 items-center underline"
            >
              {t('pdf')}
            </a>
          </p>
        )}
        {profile === null ? null : (
          <CompanyBlock profile={profile} which={kind === 'about' ? 'company' : 'contacts'} />
        )}
      </article>
    </SiteShell>
  );
}
