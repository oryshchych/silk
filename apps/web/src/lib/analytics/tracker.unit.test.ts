import { describe, expect, it } from 'vitest';

import type { AnalyticsConfig, AnalyticsItem, EcommerceEvent } from '@store/shared/analytics';
import { money } from '@store/shared/money';

import { createTracker, type TrackerEnv } from './tracker';

const item: AnalyticsItem = { id: 'SKU-1', name: 'Bra', price: money(129_900), quantity: 1 };
const view: EcommerceEvent = { name: 'view_item', items: [item] };
const purchase: EcommerceEvent = { name: 'purchase', items: [item], reference: 'SK-1001' };

const FULL: AnalyticsConfig = { ga4: 'G-ABCD1234', gtm: null, metaPixel: '123456789012' };

function fakeEnv() {
  const scripts: string[] = [];
  const dataLayer: unknown[] = [];
  const store = new Set<string>();
  let fbq: ((...args: unknown[]) => void) | undefined;
  const fbqCalls: unknown[][] = [];
  const env: TrackerEnv = {
    loadScript: (src) => scripts.push(src),
    dataLayer,
    getFbq: () => fbq,
    setFbq: (f) => {
      fbq = (...args) => {
        fbqCalls.push(args);
        f(...args);
      };
    },
    seen: { has: (key) => store.has(key), add: (key) => void store.add(key) },
  };
  return { env, scripts, dataLayer, fbqCalls, store };
}

/** gtag pushes `arguments` objects: turn them into plain arrays to compare. */
const commands = (layer: unknown[]): unknown[][] =>
  layer
    .filter(
      (entry) =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry) && 'length' in entry,
    )
    .map((entry) => Array.from(entry as ArrayLike<unknown>));

describe('before a decision', () => {
  it('requests NOTHING from a tracker host, however many events fire', () => {
    const { env, scripts } = fakeEnv();
    const tracker = createTracker(FULL, env);
    for (let i = 0; i < 100; i++) tracker.track(view);
    expect(scripts).toEqual([]);
    expect(tracker.consent).toBeNull();
  });

  it('queues Consent Mode v2 "default: denied" first, with all four signals', () => {
    const { env, dataLayer } = fakeEnv();
    createTracker(FULL, env);
    expect(commands(dataLayer)[0]).toEqual([
      'consent',
      'default',
      {
        analytics_storage: 'denied',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
        wait_for_update: 500,
      },
    ]);
  });
});

describe('after a decision', () => {
  it('"only necessary" loads nothing and drops the buffered events', () => {
    const { env, scripts, dataLayer, fbqCalls } = fakeEnv();
    const tracker = createTracker(FULL, env);
    tracker.track(view);
    tracker.apply({ analytics: false, marketing: false });
    tracker.track(purchase);
    expect(scripts).toEqual([]);
    expect(fbqCalls).toEqual([]);
    expect(commands(dataLayer).some((c) => c[0] === 'event')).toBe(false);
  });

  it('analytics only loads gtag.js and never the Meta script', () => {
    const { env, scripts, fbqCalls } = fakeEnv();
    const tracker = createTracker(FULL, env);
    tracker.apply({ analytics: true, marketing: false });
    expect(scripts).toEqual(['https://www.googletagmanager.com/gtag/js?id=G-ABCD1234']);
    tracker.track(view);
    expect(fbqCalls).toEqual([]);
  });

  it('marketing only loads the Meta pixel and never gtag', () => {
    const { env, scripts, dataLayer } = fakeEnv();
    const tracker = createTracker(FULL, env);
    tracker.apply({ analytics: false, marketing: true });
    expect(scripts).toEqual(['https://connect.facebook.net/en_US/fbevents.js']);
    tracker.track(view);
    expect(commands(dataLayer).some((c) => c[0] === 'event')).toBe(false);
  });

  it('flushes the events that waited, in order, once consent is granted', () => {
    const { env, dataLayer, fbqCalls } = fakeEnv();
    const tracker = createTracker(FULL, env);
    tracker.track(view);
    tracker.track({ name: 'add_to_cart', items: [item] });
    tracker.apply({ analytics: true, marketing: true });
    const names = commands(dataLayer)
      .filter((c) => c[0] === 'event')
      .map((c) => c[1]);
    expect(names).toEqual(['view_item', 'add_to_cart']);
    expect(
      fbqCalls.filter((c) => c[0] === 'track' && c[1] !== 'PageView').map((c) => c[1]),
    ).toEqual(['ViewContent', 'AddToCart']);
  });

  it('with a GTM container it loads gtm.js only (no second gtag.js) and pushes the ecommerce object', () => {
    const { env, scripts, dataLayer } = fakeEnv();
    const tracker = createTracker({ ga4: 'G-ABCD1234', gtm: 'GTM-ABC123', metaPixel: null }, env);
    tracker.apply({ analytics: true, marketing: false });
    expect(scripts).toEqual(['https://www.googletagmanager.com/gtm.js?id=GTM-ABC123']);
    tracker.track(view);
    const pushed = dataLayer.find(
      (entry): entry is { event: string; ecommerce: Record<string, unknown> } =>
        typeof entry === 'object' &&
        entry !== null &&
        'event' in entry &&
        entry.event === 'view_item',
    );
    expect(pushed?.ecommerce).toMatchObject({ currency: 'UAH', value: 1299 });
    expect(dataLayer).toContainEqual({ ecommerce: null });
  });

  it('the identifier reaches the script URL encoded and only once, however often consent is applied', () => {
    const { env, scripts } = fakeEnv();
    const tracker = createTracker({ ga4: 'G-AB&CD', gtm: null, metaPixel: null }, env);
    for (let i = 0; i < 5; i++) tracker.apply({ analytics: true, marketing: true });
    expect(scripts).toEqual(['https://www.googletagmanager.com/gtag/js?id=G-AB%26CD']);
  });

  it('a purchase is sent once per order, even if the page asks again', () => {
    const { env, dataLayer, fbqCalls } = fakeEnv();
    const tracker = createTracker(FULL, env);
    tracker.apply({ analytics: true, marketing: true });
    tracker.track(purchase);
    tracker.track(purchase);
    tracker.track({ ...purchase, reference: 'SK-1002' });
    expect(commands(dataLayer).filter((c) => c[0] === 'event' && c[1] === 'purchase')).toHaveLength(
      2,
    );
    expect(fbqCalls.filter((c) => c[1] === 'Purchase')).toHaveLength(2);
    expect(fbqCalls.find((c) => c[1] === 'Purchase')?.[3]).toEqual({ eventID: 'SK-1001' });
  });

  it('keeps working when the dedupe store throws (private mode)', () => {
    const { env, dataLayer } = fakeEnv();
    env.seen = {
      has: () => {
        throw new Error('denied');
      },
      add: () => undefined,
    };
    const tracker = createTracker(FULL, env);
    tracker.apply({ analytics: true, marketing: false });
    tracker.track(purchase);
    expect(commands(dataLayer).some((c) => c[1] === 'purchase')).toBe(true);
  });

  it('withdrawing consent updates the signals and stops further events', () => {
    const { env, dataLayer } = fakeEnv();
    const tracker = createTracker(FULL, env);
    tracker.apply({ analytics: true, marketing: true });
    tracker.apply({ analytics: false, marketing: false });
    const updates = commands(dataLayer).filter((c) => c[0] === 'consent' && c[1] === 'update');
    expect(updates.at(-1)?.[2]).toMatchObject({
      analytics_storage: 'denied',
      ad_storage: 'denied',
    });
    const before = dataLayer.length;
    tracker.track(view);
    expect(dataLayer.length).toBe(before);
  });

  it('the buffer is bounded', () => {
    const { env, dataLayer } = fakeEnv();
    const tracker = createTracker(FULL, env);
    for (let i = 0; i < 1000; i++)
      tracker.track({ name: 'view_item', items: [{ ...item, id: String(i) }] });
    tracker.apply({ analytics: true, marketing: false });
    expect(commands(dataLayer).filter((c) => c[0] === 'event').length).toBe(20);
  });
});
