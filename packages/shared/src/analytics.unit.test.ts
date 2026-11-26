import { describe, expect, it } from 'vitest';

import {
  analyticsConfig,
  consentModeSignals,
  DENIED,
  ga4Ecommerce,
  hryvnias,
  MAX_ITEMS,
  metaEvent,
  parseConsent,
  serializeConsent,
  type AnalyticsItem,
} from './analytics';
import { money } from './money';

const item = (over: Partial<AnalyticsItem> = {}): AnalyticsItem => ({
  id: 'AUR-75B-BLK',
  name: 'Бюстгальтер «Аврора»',
  brand: 'Aurelia',
  category: 'Бюстгальтери',
  variant: 'black, 75B',
  price: money(129_900),
  quantity: 2,
  ...over,
});

describe('analyticsConfig', () => {
  const ids = {
    GA4_MEASUREMENT_ID: 'G-ABCD1234',
    GTM_CONTAINER_ID: 'GTM-ABC123',
    META_PIXEL_ID: '123456789012',
  };

  it('exists only in production: staging and local never carry a tracker', () => {
    for (const env of ['staging', 'local', 'preview', ''])
      expect(analyticsConfig(env, ids), env).toBeNull();
    expect(analyticsConfig('production', ids)).toEqual({
      ga4: 'G-ABCD1234',
      gtm: 'GTM-ABC123',
      metaPixel: '123456789012',
    });
  });

  it('is null when nothing is configured, and drops an identifier that is not shaped like one', () => {
    expect(analyticsConfig('production', {})).toBeNull();
    expect(
      analyticsConfig('production', {
        GA4_MEASUREMENT_ID: 'G-1"><script>',
        GTM_CONTAINER_ID: 'gtm-lower',
        META_PIXEL_ID: '12ab',
      }),
    ).toBeNull();
    expect(analyticsConfig('production', { ...ids, GA4_MEASUREMENT_ID: '../x' })?.ga4).toBeNull();
  });
});

describe('consent record', () => {
  it('round trips, and anything else means "no decision yet"', () => {
    for (const consent of [
      DENIED,
      { analytics: true, marketing: false },
      { analytics: true, marketing: true },
    ]) {
      expect(parseConsent(serializeConsent(consent))).toEqual(consent);
    }
    for (const bad of [
      null,
      undefined,
      '',
      'v2.a1.m1',
      'v1.a2.m0',
      'v1.a1',
      'a1.m1',
      'v1.a1.m1;x',
      'true',
    ]) {
      expect(parseConsent(bad), String(bad)).toBeNull();
    }
  });

  it('Consent Mode v2 carries all four signals, advertising ones follow marketing only', () => {
    expect(consentModeSignals(DENIED)).toEqual({
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });
    expect(consentModeSignals({ analytics: true, marketing: false })).toMatchObject({
      analytics_storage: 'granted',
      ad_storage: 'denied',
      ad_user_data: 'denied',
    });
    expect(consentModeSignals({ analytics: false, marketing: true })).toMatchObject({
      analytics_storage: 'denied',
      ad_storage: 'granted',
      ad_personalization: 'granted',
    });
  });
});

describe('money for analytics', () => {
  it('converts integer kopiykas once, exactly', () => {
    expect(hryvnias(money(129_900))).toBe(1299);
    expect(hryvnias(money(5))).toBe(0.05);
    expect(hryvnias(money(99_999))).toBe(999.99);
    expect(hryvnias(money(0))).toBe(0);
  });

  it('sums in kopiykas before converting: three lines of 333.33 are 999.99, not 999.9899999', () => {
    const e = ga4Ecommerce({
      name: 'add_to_cart',
      items: [
        item({ price: money(33_333), quantity: 1 }),
        item({ price: money(33_333), quantity: 1 }),
        item({ price: money(33_333), quantity: 1 }),
      ],
    });
    expect(e['value']).toBe(999.99);
  });
});

describe('ga4Ecommerce', () => {
  it('maps items with price per unit, quantity and index, in UAH', () => {
    const e = ga4Ecommerce({ name: 'view_item', items: [item({ quantity: 1 })] });
    expect(e).toMatchObject({ currency: 'UAH', value: 1299 });
    expect(e['items']).toEqual([
      {
        item_id: 'AUR-75B-BLK',
        item_name: 'Бюстгальтер «Аврора»',
        item_brand: 'Aurelia',
        item_category: 'Бюстгальтери',
        item_variant: 'black, 75B',
        price: 1299,
        quantity: 1,
        index: 0,
      },
    ]);
  });

  it('a purchase carries the order number, the revenue override and shipping apart from it', () => {
    const e = ga4Ecommerce({
      name: 'purchase',
      items: [item()],
      reference: 'SK-1001',
      value: money(250_000),
      shipping: money(8_000),
    });
    expect(e).toMatchObject({ transaction_id: 'SK-1001', value: 2500, shipping: 80 });
  });

  it('a list carries its name; the item list is capped', () => {
    expect(
      ga4Ecommerce({ name: 'view_item_list', items: [item()], reference: 'Бюстгальтери' }),
    ).toMatchObject({
      item_list_name: 'Бюстгальтери',
    });
    const many = Array.from({ length: MAX_ITEMS + 25 }, (_, i) => item({ id: String(i) }));
    expect((ga4Ecommerce({ name: 'view_cart', items: many })['items'] as unknown[]).length).toBe(
      MAX_ITEMS,
    );
  });

  it('writes no private field', () => {
    expect(
      JSON.stringify(ga4Ecommerce({ name: 'purchase', items: [item()], reference: 'x' })),
    ).not.toMatch(/cost|stock|email|phone/i);
  });
});

describe('metaEvent', () => {
  it('maps the four standard events and has nothing for the rest', () => {
    expect(metaEvent({ name: 'view_item', items: [item()] })?.name).toBe('ViewContent');
    expect(metaEvent({ name: 'add_to_cart', items: [item()] })?.name).toBe('AddToCart');
    expect(metaEvent({ name: 'begin_checkout', items: [item()] })?.name).toBe('InitiateCheckout');
    expect(metaEvent({ name: 'purchase', items: [item()], reference: 'SK-1' })?.name).toBe(
      'Purchase',
    );
    for (const name of ['view_item_list', 'view_cart', 'remove_from_cart'] as const) {
      expect(metaEvent({ name, items: [item()] }), name).toBeNull();
    }
  });

  it('carries content ids, value in hryvnias and the order number as the event id', () => {
    const m = metaEvent({
      name: 'purchase',
      items: [item()],
      reference: 'SK-1001',
      value: money(250_000),
    });
    expect(m).toMatchObject({
      eventId: 'SK-1001',
      params: {
        content_ids: ['AUR-75B-BLK'],
        value: 2500,
        currency: 'UAH',
        num_items: 2,
        content_type: 'product',
      },
    });
    expect(metaEvent({ name: 'view_item', items: [item()] })?.eventId).toBeUndefined();
  });
});
