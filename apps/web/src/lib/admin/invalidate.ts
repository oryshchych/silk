import { revalidateTag, updateTag } from 'next/cache';

/** The most tags one mutation may invalidate: a bound against a runaway fan-out. */
const MAX_TAGS = 1_000;

/**
 * Drops the storefront's cached reads for these tags (ADR-8: `revalidateTag(tag, 'max')`, the
 * two-argument form). This is the TRUSTED invalidation path (owner queue Q23): it runs inside the
 * server action, after the transaction committed and after the role was checked, so there is no
 * HTTP endpoint that can be called to invalidate the cache. Admin reads are not cached at all.
 */
export function invalidateTags(tags: readonly string[]): void {
  const unique = [...new Set(tags)];
  if (unique.length > MAX_TAGS) {
    // Never silently: pages past the cap stay stale until their TTL, and somebody should know.
    process.stderr.write(
      `${JSON.stringify({ level: 'warn', scope: 'cache-invalidation', reason: 'tag cap reached', tags: unique.length, cap: MAX_TAGS })}\n`,
    );
  }
  for (const tag of unique.slice(0, MAX_TAGS)) revalidateTag(tag, 'max');
}

/**
 * Read-your-writes for a SERVER ACTION (`updateTag`, AGENTS.md section 4): the very next request after the change
 * reads fresh data, instead of one more stale answer while the cache refreshes. Server actions only.
 */
export function updateTags(tags: readonly string[]): void {
  for (const tag of new Set(tags)) updateTag(tag);
}

/** The same immediate expiry for a ROUTE HANDLER, where `updateTag` is not allowed. */
export function expireTags(tags: readonly string[]): void {
  for (const tag of new Set(tags)) revalidateTag(tag, { expire: 0 });
}
