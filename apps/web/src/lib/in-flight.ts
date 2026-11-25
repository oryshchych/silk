/**
 * Bounds the work that is in flight at once: `global` slots over everybody and `perKey` for one
 * key (a user). A slot is taken BEFORE the expensive thing starts (here: before the body of an
 * upload is read into memory) and held until `release`; when there is none, `acquire` answers
 * `null` at once. Nothing queues, so memory use is bounded by `global` times the per-item cost.
 */
export interface InFlight {
  acquire: (key: string) => (() => void) | null;
  /** Slots in use right now (for tests and logs). */
  active: () => number;
}

export function createInFlight(limits: { global: number; perKey: number }): InFlight {
  let total = 0;
  const perKey = new Map<string, number>();
  return {
    acquire(key) {
      const mine = perKey.get(key) ?? 0;
      if (total >= limits.global || mine >= limits.perKey) return null;
      total += 1;
      perKey.set(key, mine + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        total -= 1;
        const left = (perKey.get(key) ?? 1) - 1;
        if (left <= 0) perKey.delete(key);
        else perKey.set(key, left);
      };
    },
    active: () => total,
  };
}
