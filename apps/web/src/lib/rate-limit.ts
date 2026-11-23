/**
 * Fixed-window rate limiter in process memory. Enough to blunt scraping and
 * accidental loops on a public read route; it is per instance (Dokploy may run
 * several), so it limits, it does not guarantee.
 *
 * - The clock is monotonic (`performance.now`), so a wall-clock step cannot
 *   keep clients blocked or reset their windows; it is a parameter so tests
 *   need no fake timers.
 * - Memory is bounded. Expired windows are swept in batches, never one per
 *   request: once per window, and also when the table is full (throttled to
 *   once a second), so a table of expired windows never locks anyone out. If it
 *   is still full of LIVE windows, a NEW key is refused (fail closed): evicting
 *   a live key would let an attacker who rotates keys reset a blocked
 *   victim's limit.
 */
const FULL_TABLE_SWEEP_MS = 1_000;

interface RateLimit {
  allowed: boolean;
  /** Seconds until the window resets (0 when allowed). */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check: (key: string, now?: number) => RateLimit;
}

export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  /** Upper bound on tracked keys; a new key past it is refused. */
  maxKeys?: number;
}): RateLimiter {
  const { limit, windowMs, maxKeys = 20_000 } = options;
  const windows = new Map<string, { count: number; resetAt: number }>();
  let nextSweepAt = 0;
  let lastSweepAt = Number.NEGATIVE_INFINITY;

  function sweep(now: number): void {
    for (const [key, window] of windows) if (window.resetAt <= now) windows.delete(key);
    nextSweepAt = now + windowMs;
    lastSweepAt = now;
  }

  return {
    check(key, now = performance.now()) {
      if (now >= nextSweepAt) sweep(now);
      const current = windows.get(key);
      if (current === undefined || current.resetAt <= now) {
        if (current === undefined && windows.size >= maxKeys) {
          // Full: free the expired windows first (at most once a second), refuse only if still full.
          if (now - lastSweepAt >= FULL_TABLE_SWEEP_MS) sweep(now);
          if (windows.size >= maxKeys) {
            return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
          }
        }
        windows.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      current.count += 1;
      if (current.count <= limit) return { allowed: true, retryAfterSeconds: 0 };
      return { allowed: false, retryAfterSeconds: Math.ceil((current.resetAt - now) / 1000) };
    },
  };
}
