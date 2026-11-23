/**
 * An in-memory set of known slugs, refreshed from a loader at most once per
 * TTL, shared by concurrent callers (single flight) and stale-on-error: a
 * failed refresh keeps the last good set (ADR-14 pattern).
 *
 * Only the FIRST load is awaited. Once a good set exists, a stale one is served
 * immediately while a refresh runs in the background, so no request waits on
 * the database after startup. Until the first load succeeds `has` answers
 * `null` (unknown), and the caller fails open.
 */
export interface SlugSet {
  has: (slug: string) => Promise<boolean | null>;
}

export function createSlugSet(
  load: () => Promise<readonly string[]>,
  options: { ttlMs?: number; now?: () => number; onError?: (error: unknown) => void } = {},
): SlugSet {
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? (() => performance.now());
  let slugs: ReadonlySet<string> | null = null;
  /** When the set must be refreshed next (0: never loaded). */
  let staleAt = 0;
  let inflight: Promise<void> | null = null;

  function refresh(): Promise<void> {
    inflight ??= load()
      .then((list) => {
        slugs = new Set(list);
        staleAt = now() + ttlMs;
      })
      .catch((error: unknown) => {
        options.onError?.(error);
        // Keep the last good set. Retry on the next call after a short pause so
        // an outage is not hammered with a query per request.
        staleAt = now() + Math.min(ttlMs, 5_000);
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    async has(slug) {
      if (now() >= staleAt) {
        // Only the first load is awaited; afterwards a stale set is served while it refreshes.
        if (slugs === null) await refresh();
        else void refresh();
      }
      return slugs === null ? null : slugs.has(slug);
    },
  };
}
