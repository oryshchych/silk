import type { LegalNavDto } from '@store/shared/dto/legal';
import { legalPath, type LegalKind } from '@store/shared/legal';
import { buildAlternates, siteLocales, type Alternates, type SiteLocale } from '@store/shared/seo';

/** True when the document is published in EVERY language (the only case a hreflang pair or a language switch makes sense). */
export function publishedInBoth(nav: readonly LegalNavDto[], kind: LegalKind): boolean {
  return siteLocales.every((code) => nav.some((row) => row.kind === kind && row.locale === code));
}

/**
 * The canonical and, only when both languages are published, the hreflang pair. A page that exists in one language
 * has a self canonical and NO alternates: a pair is never written without its counterpart.
 */
export function legalAlternates(input: {
  siteUrl: string;
  locale: SiteLocale;
  kind: LegalKind;
  nav: readonly LegalNavDto[];
}): Pick<Alternates, 'canonical'> & { languages?: Alternates['languages'] } {
  const alternates = buildAlternates({
    siteUrl: input.siteUrl,
    locale: input.locale,
    path: legalPath(input.kind),
  });
  return publishedInBoth(input.nav, input.kind) ? alternates : { canonical: alternates.canonical };
}
