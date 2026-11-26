/**
 * Cached public reads of the legal pages (ADR-8). The cache KEYS are built from the fixed list of kinds and
 * the two locales only (at most 14 page entries and one list), never from a request value: the proxy answers
 * an unknown `/legal/<word>` with the 404 page before this runs, and `legalKindFromSlug` is checked again by
 * the page. Tags: `legal:{kind}` for a page, `legal-nav` for everything that lists the pages. "Current" is the
 * database's decision (`effective_from <= now()`), so a TTL is also what lets a scheduled version go live.
 */
import { unstable_cache } from 'next/cache';

import { returnWindowDays } from '@store/core/returns';
import { getCompanyProfile } from '@store/core/legal-company';
import { getCurrentLegalDocument, listCurrentLegalNav } from '@store/core/legal-read';
import { LEGAL_NAV_TAG, legalTag } from '@store/shared/cache-tags';
import type { LegalKind, LegalLocale } from '@store/shared/legal';

import { getDb } from './db';

const TTL = 5 * 60;

export const getCachedLegalDocument = (kind: LegalKind, locale: LegalLocale) =>
  unstable_cache(
    async () => await getCurrentLegalDocument(await getDb(), kind, locale),
    ['legal-document', kind, locale],
    { tags: [legalTag(kind), LEGAL_NAV_TAG], revalidate: TTL },
  )();

export const getCachedLegalNav = () =>
  unstable_cache(async () => await listCurrentLegalNav(await getDb()), ['legal-nav'], {
    tags: [LEGAL_NAV_TAG],
    revalidate: TTL,
  })();

/** Settings-backed company data: refreshed by the TTL (there is no admin screen for it yet, Q77). */
export const getCachedCompanyProfile = () =>
  unstable_cache(async () => await getCompanyProfile(await getDb()), ['legal-company'], {
    tags: [legalTag('contacts')],
    revalidate: TTL,
  })();

/** The window in days for the returns page summary: the setting, else the policy default (tag `legal:returns`). */
export const getCachedReturnWindow = () =>
  unstable_cache(async () => await returnWindowDays(await getDb()), ['legal-return-window'], {
    tags: [legalTag('returns')],
    revalidate: TTL,
  })();
