/**
 * A counting semaphore with a bounded queue. Wraps the work that is expensive on the shared
 * resources (a password hash plus a database transaction): at most `max` run at once, a few more
 * may wait, and anything beyond that is refused at once instead of piling up, so a flood of login
 * attempts cannot starve the rest of the site.
 */
export interface Semaphore {
  /** Runs `work`, or answers `{ ran: false }` without running it when too many are already waiting. */
  run: <T>(work: () => Promise<T>) => Promise<{ ran: true; value: T } | { ran: false }>;
}

export function createSemaphore(max: number, maxQueue: number): Semaphore {
  let running = 0;
  const waiting: (() => void)[] = [];

  async function acquire(): Promise<boolean> {
    if (running < max) {
      running += 1;
      return true;
    }
    if (waiting.length >= maxQueue) return false;
    await new Promise<void>((resolve) => waiting.push(resolve));
    return true;
  }

  function release(): void {
    const next = waiting.shift();
    // The slot passes straight to the next waiter, so `running` stays as it is.
    if (next === undefined) running -= 1;
    else next();
  }

  return {
    async run(work) {
      if (!(await acquire())) return { ran: false };
      try {
        return { ran: true, value: await work() };
      } finally {
        release();
      }
    },
  };
}
