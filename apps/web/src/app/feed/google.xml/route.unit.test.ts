import { afterEach, describe, expect, it, vi } from 'vitest';

const listFeedVariants = vi.fn<
  (db: unknown, after: string | null, limit: number) => Promise<unknown[]>
>(() => Promise.resolve([]));
vi.mock('../../../lib/db', () => ({ getDb: () => Promise.resolve({}) }));
vi.mock('../../../lib/site-url', () => ({
  getSiteUrl: () => Promise.resolve('https://s.example'),
}));
vi.mock('next-intl/server', () => ({ getTranslations: () => Promise.resolve(() => 'Shop') }));
vi.mock('@store/core/feed', () => ({
  listFeedVariants: (db: unknown, after: string | null, limit: number) =>
    listFeedVariants(db, after, limit),
}));

const { GET } = await import('./route');
const { FEED_DEADLINE_MS, takeFeedSlot } = await import('../../../lib/product-feed');

const get = (method = 'GET', signal?: AbortSignal): Promise<Response> =>
  GET(new Request('https://s.example/feed/google.xml', { method, ...(signal ? { signal } : {}) }));

afterEach(() => {
  vi.useRealTimers();
  listFeedVariants.mockReset();
  listFeedVariants.mockResolvedValue([]);
});

describe('GET /feed/google.xml', () => {
  it('a HEAD takes no slot and no database read: any number of them leave the feed available', async () => {
    for (let i = 0; i < 20; i++) {
      const head = await get('HEAD');
      expect(head.status).toBe(200);
      expect(head.headers.get('x-robots-tag')).toBe('noindex');
      expect(head.headers.get('content-type')).toContain('application/xml');
      expect(await head.text()).toBe('');
    }
    expect(listFeedVariants).not.toHaveBeenCalled();
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('</rss>');
  });

  it('refuses with a 503 that is never cached when all slots are taken, and frees a slot when a stream is cancelled', async () => {
    const taken = Array.from({ length: 8 }, () => takeFeedSlot());
    expect(taken.every((release) => release !== null)).toBe(true);
    const refused = await get();
    expect(refused.status).toBe(503);
    expect(refused.headers.get('cache-control')).toBe('no-store');
    expect(refused.headers.get('retry-after')).toBe('60');
    taken[0]?.();
    const stream = await get();
    expect(stream.status).toBe(200);
    await stream.body?.cancel();
    // The cancelled stream released its slot: another one fits again.
    const again = takeFeedSlot();
    expect(again).not.toBeNull();
    again?.();
    for (const release of taken) release?.();
  });

  it('a client that aborts frees the slot', async () => {
    const controller = new AbortController();
    const response = await get('GET', controller.signal);
    expect(response.status).toBe(200);
    const hold = Array.from({ length: 7 }, () => takeFeedSlot());
    expect(takeFeedSlot()).toBeNull();
    controller.abort();
    const freed = takeFeedSlot();
    expect(freed).not.toBeNull();
    freed?.();
    for (const release of hold) release?.();
  });

  it('a reader that reads nothing cannot hold a slot past the deadline: the timer errors the stream and frees it', async () => {
    vi.useFakeTimers();
    const hold = Array.from({ length: 7 }, () => takeFeedSlot());
    const response = await get();
    expect(response.status).toBe(200);
    // All slots are taken and nobody reads: pull is never called, only the timer can free the slot.
    expect(takeFeedSlot()).toBeNull();
    await vi.advanceTimersByTimeAsync(FEED_DEADLINE_MS + 1_000);
    const reader = response.body?.getReader();
    const outcome = await reader?.read().then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(Error);
    const free = takeFeedSlot();
    expect(free).not.toBeNull();
    free?.();
    for (const release of hold) release?.();
  });

  it('a stalled database read keeps its slot only until the same deadline', async () => {
    vi.useFakeTimers();
    listFeedVariants.mockImplementation(() => new Promise(() => undefined));
    const response = await get();
    const reader = response.body?.getReader();
    await reader?.read(); // the XML header
    const pending = reader?.read().then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(FEED_DEADLINE_MS + 1_000);
    expect(await pending).toBeInstanceOf(Error);
    const slots = Array.from({ length: 8 }, () => takeFeedSlot());
    expect(slots.every((slot) => slot !== null)).toBe(true);
    for (const slot of slots) slot?.();
  });
});
