/**
 * Fixed-window rate limiter in process memory. Enough to blunt scraping and
 * accidental loops on a public read route; it is per instance (Dokploy may run
 * several), so it limits, it does not guarantee. The clock is a parameter so
 * the window is testable without fake timers.
 */
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
  /** Upper bound on tracked keys: expired windows are dropped first, then the oldest. */
  maxKeys?: number;
}): RateLimiter {
  const { limit, windowMs, maxKeys = 10_000 } = options;
  const windows = new Map<string, { count: number; resetAt: number }>();

  function evict(now: number): void {
    for (const [key, window] of windows) if (window.resetAt <= now) windows.delete(key);
    while (windows.size >= maxKeys) {
      const oldest = windows.keys().next();
      if (oldest.done === true) break;
      windows.delete(oldest.value);
    }
  }

  return {
    check(key, now = Date.now()) {
      const current = windows.get(key);
      if (current === undefined || current.resetAt <= now) {
        if (current === undefined && windows.size >= maxKeys) evict(now);
        windows.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      current.count += 1;
      if (current.count <= limit) return { allowed: true, retryAfterSeconds: 0 };
      return { allowed: false, retryAfterSeconds: Math.ceil((current.resetAt - now) / 1000) };
    },
  };
}

/** Client address behind the reverse proxy (Traefik sets `x-forwarded-for`); 'unknown' when absent. */
export function clientKey(forwardedFor: string | null): string {
  const first = forwardedFor?.split(',')[0]?.trim();
  return first === undefined || first === '' ? 'unknown' : first;
}
