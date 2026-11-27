import { createSharedComputation, type Computed } from './shared-computation.ts';

/**
 * `createSharedComputation` per KEY (a report with its parameters): ten people opening the same
 * report cost one computation, a different period is a different key. Memory is bounded (`maxKeys`,
 * the oldest key is dropped), and at most `maxRunning` computations run at once across ALL keys, so a
 * person cycling through periods cannot starve the connection pool: the next one is refused with
 * `BusyError` instead of queueing a connection.
 */
export class BusyError extends Error {
  constructor() {
    super('too many reports are being computed');
    this.name = 'BusyError';
  }
}

export function createKeyedComputation<T, C>(
  compute: (context: C) => Promise<T>,
  options: { ttlMs: number; minRefreshMs: number; maxKeys: number; maxRunning: number },
): { get: (key: string, refresh: boolean, context: C) => Promise<Computed<T>> } {
  const entries = new Map<string, ReturnType<typeof createSharedComputation<T>>>();
  let running = 0;
  return {
    get: async (key, refresh, context) => {
      let entry = entries.get(key);
      if (entry === undefined) {
        if (entries.size >= options.maxKeys) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
        entry = createSharedComputation(
          async () => {
            if (running >= options.maxRunning) throw new BusyError();
            running += 1;
            try {
              return await compute(context);
            } finally {
              running -= 1;
            }
          },
          { ttlMs: options.ttlMs, minRefreshMs: options.minRefreshMs },
        );
        entries.set(key, entry);
      }
      return await entry.get(refresh);
    },
  };
}
