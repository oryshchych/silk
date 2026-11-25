import { describe, expect, it } from 'vitest';

import { createSemaphore } from './semaphore';

const gate = () => {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

describe('createSemaphore', () => {
  it('runs at most `max` at once, queues up to `maxQueue` and refuses the rest at once', async () => {
    const semaphore = createSemaphore(2, 1);
    const hold = gate();
    let active = 0;
    let peak = 0;
    const job = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await hold.promise;
      active -= 1;
      return 'done';
    };
    const results = [
      semaphore.run(job),
      semaphore.run(job),
      semaphore.run(job),
      semaphore.run(job),
    ];
    // The fourth found two running and one waiting: refused without waiting.
    expect(await results[3]).toEqual({ ran: false });
    hold.open();
    expect(await Promise.all(results.slice(0, 3))).toEqual(
      Array.from({ length: 3 }, () => ({ ran: true, value: 'done' })),
    );
    expect(peak).toBe(2);
  });

  it('frees the slot when the work throws', async () => {
    const semaphore = createSemaphore(1, 0);
    await expect(semaphore.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await semaphore.run(() => Promise.resolve('again'))).toEqual({
      ran: true,
      value: 'again',
    });
  });
});
