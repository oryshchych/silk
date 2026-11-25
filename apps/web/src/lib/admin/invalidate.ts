import { revalidateTag } from 'next/cache';

/** The most tags one mutation may invalidate: a bound against a runaway fan-out. */
const MAX_TAGS = 1_000;

/**
 * Drops the storefront's cached reads for these tags (ADR-8: `revalidateTag(tag, 'max')`, the
 * two-argument form). This is the TRUSTED invalidation path (owner queue Q23): it runs inside the
 * server action, after the transaction committed and after the role was checked, so there is no
 * HTTP endpoint that can be called to invalidate the cache. Admin reads are not cached at all.
 */
export function invalidateTags(tags: readonly string[]): void {
  for (const tag of [...new Set(tags)].slice(0, MAX_TAGS)) revalidateTag(tag, 'max');
}
