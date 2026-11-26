/**
 * The 301s of changed slugs, served by `proxy.ts` (ADR-14): the table is held in process memory,
 * loaded single-flight, refreshed at most once a minute and stale-on-error, so the proxy never
 * queries the database per request. Only paths that CAN have a redirect (a product or category
 * page, in either locale) are looked up. The admin drops the cache right after it writes a
 * redirect, so this instance serves it at once; other instances catch up within the TTL.
 */
import { errorReason } from './error-reason';

declare global {
  /**
   * Bumped by `invalidate`. The proxy and the server actions are separate module graphs in one
   * process, so a module-level flag would never reach the proxy's map; this counter does.
   */
  var silkRedirectsVersion: number | undefined;
}

interface RedirectHit {
  to: string;
  /** 410: the page is gone for good (`to` is unused). */
  status: 301 | 302 | 410;
}

export interface RedirectMap {
  lookup: (pathname: string) => Promise<RedirectHit | null>;
  /** Forget the loaded table: the next lookup reloads it. */
  invalidate: () => void;
  /**
   * Counts one served hit. Counters exist only for paths that are in the table (so they are
   * bounded by it, never by what clients request) and are written to the database in batches.
   */
  noteHit: (pathname: string) => void;
}

const REDIRECTABLE = /^\/(?:en\/)?(?:product|category)\/[^/]+$/;

export const canHaveRedirect = (pathname: string): boolean => REDIRECTABLE.test(pathname);

export function createRedirectMap(
  load: () => Promise<readonly { fromPath: string; toPath: string; statusCode: 301 | 302 | 410 }[]>,
  options: {
    ttlMs?: number;
    now?: () => number;
    onError?: (error: unknown) => void;
    /** Persists a batch of hit counts; a rejection puts the counts back for the next flush. */
    flushHits?: (hits: ReadonlyMap<string, number>) => Promise<void>;
    flushMs?: number;
    /** Pending hits that trigger a flush before the timer does. */
    flushAt?: number;
  } = {},
): RedirectMap {
  const flushMs = options.flushMs ?? 60_000;
  const flushAt = options.flushAt ?? 100;
  let pending = 0;
  /** The last write failed: only the timer retries, never the hit threshold. */
  let failing = false;
  let hits = new Map<string, number>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  async function flush(): Promise<void> {
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    pending = 0;
    if (hits.size === 0 || options.flushHits === undefined) return;
    const batch = hits;
    hits = new Map();
    try {
      await options.flushHits(batch);
      failing = false;
    } catch (error: unknown) {
      options.onError?.(error);
      failing = true;
      // Keep the counts (bounded: only paths of the table are ever counted).
      for (const [path, n] of batch) hits.set(path, (hits.get(path) ?? 0) + n);
      // Retry on the timer only: a database outage must not cost one failed query per request.
      flushTimer = setTimeout(() => void flush(), flushMs);
      flushTimer.unref();
    }
  }

  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? (() => performance.now());
  let table: ReadonlyMap<string, RedirectHit> | null = null;
  let staleAt = 0;
  let inflight: Promise<void> | null = null;
  let failures = 0;
  /** Set by `invalidate`: the next lookup WAITS for a fresh table instead of serving the stale one. */
  let mustReload = false;
  let seenVersion = globalThis.silkRedirectsVersion ?? 0;

  function refresh(): Promise<void> {
    inflight ??= load()
      .then((rows) => {
        table = new Map(
          rows.map((row) => [row.fromPath, { to: row.toPath, status: row.statusCode }]),
        );
        staleAt = now() + ttlMs;
        failures = 0;
      })
      .catch((error: unknown) => {
        options.onError?.(error);
        failures += 1;
        staleAt = now() + Math.min(ttlMs, 5_000 * 2 ** (failures - 1));
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    async lookup(pathname) {
      if (!canHaveRedirect(pathname)) return null;
      const version = globalThis.silkRedirectsVersion ?? 0;
      if (version !== seenVersion) {
        seenVersion = version;
        mustReload = true;
      }
      if (mustReload) {
        mustReload = false;
        // Wait for any load already running (it may predate the change), then load again.
        await inflight;
        await refresh();
      } else if (now() >= staleAt) {
        if (table === null) await refresh();
        else void refresh();
      }
      return table?.get(pathname) ?? null;
    },
    noteHit(pathname) {
      if (options.flushHits === undefined || table?.has(pathname) !== true) return;
      hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
      pending += 1;
      if (pending >= flushAt && !failing) {
        void flush();
        return;
      }
      if (flushTimer === null) {
        flushTimer = setTimeout(() => void flush(), flushMs);
        // The timer must never keep the process alive on shutdown.
        flushTimer.unref();
      }
    },
    invalidate() {
      mustReload = true;
      globalThis.silkRedirectsVersion = (globalThis.silkRedirectsVersion ?? 0) + 1;
      seenVersion = globalThis.silkRedirectsVersion;
    },
  };
}

/** The process-wide map, loaded lazily from the database. */
export const redirectMap = createRedirectMap(
  async () => {
    const { listRedirects, REDIRECT_LIMIT } = await import('@store/core/admin-redirects');
    const { getDb } = await import('./db');
    const rows = await listRedirects(await getDb());
    if (rows.length >= REDIRECT_LIMIT) {
      // The oldest redirects past the cap stop working: say so.
      process.stderr.write(
        `${JSON.stringify({ level: 'warn', scope: 'redirect-map', reason: 'redirect cap reached', cap: REDIRECT_LIMIT })}\n`,
      );
    }
    return rows;
  },
  {
    onError: (error) => {
      process.stderr.write(
        `${JSON.stringify({ level: 'error', scope: 'redirect-map', reason: errorReason(error) })}\n`,
      );
    },
    flushHits: async (hits) => {
      const { addRedirectHits } = await import('@store/core/admin-redirects');
      const { getDb } = await import('./db');
      await addRedirectHits(await getDb(), hits);
    },
  },
);
