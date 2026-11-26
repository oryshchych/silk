/**
 * One expensive computation shared by everybody who asks for it: while it runs, every caller gets
 * the SAME promise (ten parallel requests cost one computation and one database connection); its
 * result is kept for `ttlMs`; a caller may ask for a fresh one (`refresh`) only when the kept one is
 * at least `minRefreshMs` old, so a refresh link cannot be turned into a flood. A failure is not
 * kept: the next caller tries again.
 */
export interface Computed<T> {
  value: T;
  /** When the value was computed (ms, the injected clock). */
  at: number;
}

export function createSharedComputation<T>(
  compute: () => Promise<T>,
  options: { ttlMs: number; minRefreshMs: number; now?: () => number },
): { get: (refresh: boolean) => Promise<Computed<T>> } {
  const now = options.now ?? Date.now;
  let kept: Computed<T> | null = null;
  let running: Promise<Computed<T>> | null = null;

  const start = (): Promise<Computed<T>> => {
    const run = compute().then(
      (value) => {
        kept = { value, at: now() };
        running = null;
        return kept;
      },
      (error: unknown) => {
        running = null;
        throw error;
      },
    );
    running = run;
    return run;
  };

  return {
    get: async (refresh) => {
      if (running !== null) return await running;
      if (kept !== null) {
        const age = now() - kept.at;
        if (age < options.ttlMs && !(refresh && age >= options.minRefreshMs)) return kept;
      }
      return await start();
    },
  };
}
