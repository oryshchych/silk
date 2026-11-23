import {
  defaultListingParams,
  serializeListingParams,
  type ListingParams,
} from '@store/core/catalog';

export interface ListingSeo {
  /** Whether search engines may index this URL. */
  index: boolean;
  /** Query of the canonical URL: empty for the clean category. */
  canonicalSearch: string;
}

/**
 * Facet strategy (docs/architecture/06-seo.md): the clean category is
 * indexed; a single popular filter from the whitelist (one bra band) is
 * indexed with its own canonical; everything else (two or more filters, sort,
 * page 2+) is `noindex, follow` with the canonical on the clean category.
 */
export function listingSeo(params: ListingParams): ListingSeo {
  const query = serializeListingParams(params);
  if (query === '') return { index: true, canonicalSearch: '' };

  const [band] = params.bands;
  const onlyBand = serializeListingParams({ ...defaultListingParams, bands: params.bands });
  if (params.bands.length === 1 && band !== undefined && query === onlyBand) {
    return { index: true, canonicalSearch: query };
  }
  return { index: false, canonicalSearch: '' };
}
