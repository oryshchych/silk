import type { ListingParams } from '@store/core/catalog';

/** Most selected filter values (band, cup, size, colour, brand together) a cached listing may carry. */
const MAX_CACHED_FILTER_VALUES = 3;

/**
 * Whether a listing may use the data cache. The cache key space is finite once
 * values are restricted to what a category offers, but combinations of many
 * values are combinatorial and rarely reused, so they are queried directly
 * (the database answers them in milliseconds). A price range is any number:
 * never cached.
 */
export function isCacheableListing(params: ListingParams): boolean {
  if (params.priceMin !== null || params.priceMax !== null) return false;
  const selected =
    params.bands.length +
    params.cups.length +
    params.sizes.length +
    params.colors.length +
    params.brands.length;
  return selected <= MAX_CACHED_FILTER_VALUES;
}
