import type { Metadata } from 'next';

import type { Alternates, SiteLocale } from '@store/shared/seo';

const OG_LOCALE = { uk: 'uk_UA', en: 'en_US' } as const;

/**
 * Title, description, canonical, hreflang, Open Graph and Twitter in one
 * place, so every page carries the same set. `alternates` comes from
 * `buildAlternates` (the single hreflang source).
 */
export function pageMetadata(input: {
  title: string;
  description: string | null;
  locale: SiteLocale;
  siteName: string;
  /** `languages` is left out for a page that exists in one language only: no hreflang without its counterpart. */
  alternates: Pick<Alternates, 'canonical'> & { languages?: Alternates['languages'] };
  index: boolean;
  image?: string | null;
  /** False for a page with no counterpart in the other language: no `og:locale:alternate`. */
  hasCounterpart?: boolean;
  /** `article` for a blog post (with its time); `website` otherwise. */
  article?: { publishedTime: string; modifiedTime: string } | undefined;
}): Metadata {
  const {
    title,
    description,
    locale,
    siteName,
    alternates,
    index,
    image,
    hasCounterpart = true,
    article,
  } = input;
  const other = locale === 'uk' ? 'en' : 'uk';
  const images = image === undefined || image === null ? undefined : [image];
  return {
    title,
    ...(description === null ? {} : { description }),
    alternates: {
      canonical: alternates.canonical,
      ...(alternates.languages === undefined ? {} : { languages: alternates.languages }),
    },
    robots: index ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: {
      ...(article === undefined
        ? { type: 'website' as const }
        : {
            type: 'article' as const,
            publishedTime: article.publishedTime,
            modifiedTime: article.modifiedTime,
          }),
      title,
      ...(description === null ? {} : { description }),
      url: alternates.canonical,
      siteName,
      locale: OG_LOCALE[locale],
      ...(hasCounterpart ? { alternateLocale: [OG_LOCALE[other]] } : {}),
      ...(images === undefined ? {} : { images }),
    },
    twitter: {
      card: images === undefined ? 'summary' : 'summary_large_image',
      title,
      ...(description === null ? {} : { description }),
      ...(images === undefined ? {} : { images }),
    },
  };
}
