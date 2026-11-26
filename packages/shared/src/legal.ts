/**
 * The legal and static documents of the shop. One list of kinds, their public URL words and the
 * reference string a consent or a return request stores, shared by the database CHECK (migration 0021),
 * the admin, the storefront routes, the sitemap and the footer, so they cannot drift.
 */
export const LEGAL_KINDS = [
  'terms',
  'privacy',
  'delivery_payment',
  'returns',
  'about',
  'faq',
  'contacts',
] as const;
export type LegalKind = (typeof LEGAL_KINDS)[number];

export const LEGAL_LOCALES = ['uk', 'en'] as const;
export type LegalLocale = (typeof LEGAL_LOCALES)[number];

/** The word in the public URL: `/legal/<slug>`. Fixed list, so an unknown path never reaches the database or a cache key. */
export const LEGAL_SLUG: Record<LegalKind, string> = {
  terms: 'terms',
  privacy: 'privacy',
  delivery_payment: 'delivery-payment',
  returns: 'returns',
  about: 'about',
  faq: 'faq',
  contacts: 'contacts',
};

const KIND_BY_SLUG: ReadonlyMap<string, LegalKind> = new Map(
  LEGAL_KINDS.map((kind) => [LEGAL_SLUG[kind], kind]),
);

/** The kind for a URL word, or null: the gate in front of every cached read of a legal page. */
export function legalKindFromSlug(slug: string): LegalKind | null {
  return KIND_BY_SLUG.get(slug) ?? null;
}

export const legalPath = (kind: LegalKind): string => `/legal/${LEGAL_SLUG[kind]}`;

/** The kinds a customer accepts at checkout or registration: their version is recorded with the acceptance. */
export const CONSENT_KINDS = ['terms', 'privacy'] as const satisfies readonly LegalKind[];

/**
 * What an acceptance or a return request stores in a `varchar(20)`: `<kind>/<locale>/<version>`, for example
 * `terms/uk/3`. The text a person agreed to is then found by (kind, locale, version) and never changes.
 */
export function policyRef(kind: LegalKind, locale: LegalLocale, version: string): string {
  return `${kind}/${locale}/${version}`;
}

/** Stored when no version of the document is published yet. */
export const NO_POLICY_REF = 'v0-placeholder';
