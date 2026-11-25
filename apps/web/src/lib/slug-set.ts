/**
 * An in-memory set of known slugs, refreshed from a loader at most once per
 * TTL, shared by concurrent callers (single flight) and stale-on-error: a
 * failed refresh keeps the last good set (ADR-14 pattern).
 *
 * Only the FIRST load is awaited. Once a good set exists, a stale one is served
 * immediately while a refresh runs in the background, so no request waits on
 * the database after startup. Until the first load succeeds `has` answers
 * `null` (unknown), and the caller fails open. Repeated load failures back off
 * (5 s, 10 s, 20 s, ... up to the TTL) so an outage is not hammered; one
 * success resets it.
 */
declare global {
  /**
   * Bumped by `invalidate`. The proxy and the server actions are separate module graphs in one
   * process, so the counter lives on `globalThis` (same pattern as the redirect map).
   */
  var silkSlugSetVersion: number | undefined;
}

export interface SlugSet {
  has: (slug: string) => Promise<boolean | null>;
  /** Forget the loaded set: the next `has` WAITS for a fresh one (a publish or a rename just happened). */
  invalidate: () => void;
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
  let failures = 0;
  let mustReload = false;
  let seenVersion = globalThis.silkSlugSetVersion ?? 0;

  function refresh(): Promise<void> {
    inflight ??= load()
      .then((list) => {
        slugs = new Set(list);
        staleAt = now() + ttlMs;
        failures = 0;
      })
      .catch((error: unknown) => {
        options.onError?.(error);
        // Keep the last good set and back off, so an outage is not hammered with a
        // query per request: 5 s, 10 s, 20 s ... capped at the TTL.
        failures += 1;
        staleAt = now() + Math.min(ttlMs, 5_000 * 2 ** (failures - 1));
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    async has(slug) {
      const version = globalThis.silkSlugSetVersion ?? 0;
      if (version !== seenVersion) {
        seenVersion = version;
        mustReload = true;
      }
      if (mustReload) {
        mustReload = false;
        await inflight;
        await refresh();
      } else if (now() >= staleAt) {
        // Only the first load is awaited; afterwards a stale set is served while it refreshes.
        if (slugs === null) await refresh();
        else void refresh();
      }
      return slugs === null ? null : slugs.has(slug);
    },
    invalidate() {
      mustReload = true;
      globalThis.silkSlugSetVersion = (globalThis.silkSlugSetVersion ?? 0) + 1;
      seenVersion = globalThis.silkSlugSetVersion;
    },
  };
}
