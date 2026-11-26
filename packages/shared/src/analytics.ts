/**
 * Analytics, pure (phase 6): the consent record, the Consent Mode v2 payloads, the config that
 * reaches the browser, and the e-commerce events in GA4 and Meta shapes. No DOM here, so every
 * rule is unit-testable. Prices are integer kopiykas (`Money`) converted ONCE, by `hryvnias`,
 * because the analytics APIs want a number of hryvnias; that is the only place a Money leaves
 * integer form.
 */
import { multiply, sum, toHryvniasText, type Money } from './money';

/* ---------- config: what the browser may know ---------- */

export interface AnalyticsIds {
  GA4_MEASUREMENT_ID?: string | undefined;
  GTM_CONTAINER_ID?: string | undefined;
  META_PIXEL_ID?: string | undefined;
}

/** Identifiers only (public by nature); never a secret or an API token. */
export interface AnalyticsConfig {
  ga4: string | null;
  gtm: string | null;
  metaPixel: string | null;
}

export const GA4_ID = /^G-[A-Z0-9]{4,20}$/;
export const GTM_ID = /^GTM-[A-Z0-9]{4,12}$/;
export const PIXEL_ID = /^\d{8,20}$/;

/**
 * Analytics exist only in production (ADR-10: one image, behaviour from the runtime environment).
 * Staging and local never load a tracker, so test traffic cannot pollute the real property.
 * An identifier that fails its pattern is treated as absent, so it can never reach a script URL.
 */
export function analyticsConfig(appEnv: string, ids: AnalyticsIds): AnalyticsConfig | null {
  if (appEnv !== 'production') return null;
  const ga4 =
    ids.GA4_MEASUREMENT_ID !== undefined && GA4_ID.test(ids.GA4_MEASUREMENT_ID)
      ? ids.GA4_MEASUREMENT_ID
      : null;
  const gtm =
    ids.GTM_CONTAINER_ID !== undefined && GTM_ID.test(ids.GTM_CONTAINER_ID)
      ? ids.GTM_CONTAINER_ID
      : null;
  const metaPixel =
    ids.META_PIXEL_ID !== undefined && PIXEL_ID.test(ids.META_PIXEL_ID) ? ids.META_PIXEL_ID : null;
  return ga4 === null && gtm === null && metaPixel === null ? null : { ga4, gtm, metaPixel };
}

/* ---------- consent ---------- */

export interface Consent {
  /** Statistics: GA4, and the analytics side of GTM. */
  analytics: boolean;
  /** Advertising: the Meta Pixel, ad storage, ad personalisation. */
  marketing: boolean;
}

export const CONSENT_COOKIE = 'silk_consent';
/** Six months, then the visitor is asked again. */
export const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 182;
export const DENIED: Consent = { analytics: false, marketing: false };

/** `v1.a1.m0`: a version and two flags. Anything else is "no decision yet" (null). */
export const serializeConsent = (consent: Consent): string =>
  `v1.a${consent.analytics ? '1' : '0'}.m${consent.marketing ? '1' : '0'}`;

export function parseConsent(value: string | null | undefined): Consent | null {
  const match = value === null || value === undefined ? null : /^v1\.a([01])\.m([01])$/.exec(value);
  return match === null ? null : { analytics: match[1] === '1', marketing: match[2] === '1' };
}

type Granted = 'granted' | 'denied';

/** The Consent Mode v2 signal set; Google needs all four. */
export function consentModeSignals(consent: Consent): {
  analytics_storage: Granted;
  ad_storage: Granted;
  ad_user_data: Granted;
  ad_personalization: Granted;
} {
  const analytics: Granted = consent.analytics ? 'granted' : 'denied';
  const marketing: Granted = consent.marketing ? 'granted' : 'denied';
  return {
    analytics_storage: analytics,
    ad_storage: marketing,
    ad_user_data: marketing,
    ad_personalization: marketing,
  };
}

/* ---------- e-commerce events ---------- */

export const CURRENCY = 'UAH';

export const hryvnias = (amount: Money): number => Number(toHryvniasText(amount));

export interface AnalyticsItem {
  /** Variant SKU where a variant is known (it is the feed `id`), else the product id. */
  id: string;
  name: string;
  brand?: string;
  category?: string;
  variant?: string;
  price: Money;
  quantity: number;
}

export type EcommerceEventName =
  | 'view_item_list'
  | 'view_item'
  | 'add_to_cart'
  | 'remove_from_cart'
  | 'view_cart'
  | 'begin_checkout'
  | 'purchase';

export interface EcommerceEvent {
  name: EcommerceEventName;
  items: readonly AnalyticsItem[];
  /** The order number for a purchase (also the dedupe key); the list name for a list. */
  reference?: string;
  /** Shipping and tax are not in `value`: it is the goods. */
  shipping?: Money;
  /** The revenue when it is not the sum of the items (a purchase after discounts). */
  value?: Money;
}

export const MAX_ITEMS = 50;

export function ga4Item(item: AnalyticsItem, index: number): Record<string, string | number> {
  return {
    item_id: item.id,
    item_name: item.name,
    ...(item.brand === undefined ? {} : { item_brand: item.brand }),
    ...(item.category === undefined ? {} : { item_category: item.category }),
    ...(item.variant === undefined ? {} : { item_variant: item.variant }),
    price: hryvnias(item.price),
    quantity: item.quantity,
    index,
  };
}

/** The goods total in integer kopiykas (shipping is not in it). */
const sumOf = (items: readonly AnalyticsItem[]): Money =>
  sum(items.map((item) => multiply(item.price, item.quantity)));

/** GA4 `ecommerce` object. `value` is summed in kopiykas (integers) and converted once. */
export function ga4Ecommerce(event: EcommerceEvent): Record<string, unknown> {
  const items = event.items.slice(0, MAX_ITEMS);
  const base = { currency: CURRENCY, items: items.map(ga4Item) };
  if (event.name === 'view_item_list')
    return { ...base, item_list_name: event.reference ?? 'list' };
  if (event.name === 'purchase') {
    return {
      ...base,
      value: hryvnias(event.value ?? sumOf(items)),
      transaction_id: event.reference ?? '',
      shipping: event.shipping === undefined ? 0 : hryvnias(event.shipping),
    };
  }
  return { ...base, value: hryvnias(sumOf(items)) };
}

export interface MetaEvent {
  name: 'ViewContent' | 'AddToCart' | 'InitiateCheckout' | 'Purchase';
  params: Record<string, unknown>;
  /** Deduplicates the browser event against a server one (the order number for a purchase). */
  eventId?: string;
}

const META_NAMES: Partial<Record<EcommerceEventName, MetaEvent['name']>> = {
  view_item: 'ViewContent',
  add_to_cart: 'AddToCart',
  begin_checkout: 'InitiateCheckout',
  purchase: 'Purchase',
};

/** The Meta equivalent, or null for an event Meta has no standard name for. */
export function metaEvent(event: EcommerceEvent): MetaEvent | null {
  const name = META_NAMES[event.name];
  if (name === undefined) return null;
  const items = event.items.slice(0, MAX_ITEMS);
  return {
    name,
    params: {
      content_type: 'product',
      content_ids: items.map((item) => item.id),
      contents: items.map((item) => ({
        id: item.id,
        quantity: item.quantity,
        item_price: hryvnias(item.price),
      })),
      value: hryvnias(event.value ?? sumOf(items)),
      currency: CURRENCY,
      num_items: items.reduce((count, item) => count + item.quantity, 0),
    },
    ...(event.name === 'purchase' && event.reference !== undefined
      ? { eventId: event.reference }
      : {}),
  };
}
