/**
 * Typed JSON-LD builders (docs/architecture/06-seo.md). Pages never assemble
 * JSON-LD from strings: they pass typed input here and render the result with
 * `serializeJsonLd`.
 */
import type { Money } from './money';
import type { ReturnPolicy } from './return-policy';

export const SCHEMA_CONTEXT = 'https://schema.org';
export const SHOP_CURRENCY = 'UAH';

export interface ListItemInput {
  name: string;
  /** Absolute URL. */
  url: string;
}

export interface BreadcrumbListLd {
  '@context': typeof SCHEMA_CONTEXT;
  '@type': 'BreadcrumbList';
  itemListElement: {
    '@type': 'ListItem';
    position: number;
    name: string;
    item: string;
  }[];
}

export function buildBreadcrumbList(crumbs: readonly ListItemInput[]): BreadcrumbListLd {
  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: crumb.url,
    })),
  };
}

export interface ItemListLd {
  '@context': typeof SCHEMA_CONTEXT;
  '@type': 'ItemList';
  itemListElement: {
    '@type': 'ListItem';
    position: number;
    name: string;
    url: string;
  }[];
}

/** `startPosition` is 1-based so page 2 of a listing continues the numbering. */
export function buildItemList(items: readonly ListItemInput[], startPosition = 1): ItemListLd {
  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'ItemList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: startPosition + index,
      name: item.name,
      url: item.url,
    })),
  };
}

export type Availability = 'InStock' | 'OutOfStock';

export interface MerchantReturnPolicyLd {
  '@type': 'MerchantReturnPolicy';
  applicableCountry: string;
  returnPolicyCategory:
    | 'https://schema.org/MerchantReturnNotPermitted'
    | 'https://schema.org/MerchantReturnFiniteReturnWindow';
  /** Absolute URL of the returns page (the schema.org property is `merchantReturnLink`). */
  merchantReturnLink?: string;
  merchantReturnDays?: number;
  returnMethod?: `https://schema.org/${ReturnPolicy['returnMethod']}`;
  returnFees?: `https://schema.org/${ReturnPolicy['returnFees']}`;
}

/**
 * `hasMerchantReturnPolicy` from the shared policy (`./return-policy`). Without voluntary returns the shop says
 * returns are NOT permitted (the defect regime is explained on the returns page, it is a legal duty and not a
 * return policy); with them, a finite window with the method and the fees. Pure, no request value: the markup on
 * a shared (ISR) product page is identical for everybody.
 */
export function buildMerchantReturnPolicy(
  policy: ReturnPolicy,
  options: { windowDays?: number; link?: string } = {},
): MerchantReturnPolicyLd {
  const windowDays = options.windowDays ?? policy.defaultWindowDays;
  const link = options.link === undefined ? {} : { merchantReturnLink: options.link };
  if (!policy.voluntaryReturns) {
    return {
      '@type': 'MerchantReturnPolicy',
      applicableCountry: policy.applicableCountry,
      returnPolicyCategory: 'https://schema.org/MerchantReturnNotPermitted',
      ...link,
    };
  }
  return {
    '@type': 'MerchantReturnPolicy',
    applicableCountry: policy.applicableCountry,
    ...link,
    returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
    merchantReturnDays: windowDays,
    returnMethod: `https://schema.org/${policy.returnMethod}`,
    returnFees: `https://schema.org/${policy.returnFees}`,
  };
}

export interface OfferInput {
  price: Money;
  availability: Availability;
  /** Absolute URL of the product page. */
  url: string;
  sku?: string;
}

export interface ProductInput {
  name: string;
  description?: string | null;
  sku: string;
  brand: string;
  /** Absolute image URLs. Rich Results wants at least one. */
  images: readonly string[];
  url: string;
  offers: readonly OfferInput[];
  rating?: { value: number; count: number } | null;
  /** Added to every offer as `hasMerchantReturnPolicy`. */
  returnPolicy?: MerchantReturnPolicyLd;
}

interface OfferLd {
  '@type': 'Offer';
  url: string;
  price: string;
  priceCurrency: typeof SHOP_CURRENCY;
  availability: `https://schema.org/${Availability}`;
  sku?: string;
  hasMerchantReturnPolicy?: MerchantReturnPolicyLd;
}

export interface ProductLd {
  '@context': typeof SCHEMA_CONTEXT;
  '@type': 'Product';
  name: string;
  sku: string;
  brand: { '@type': 'Brand'; name: string };
  url: string;
  description?: string;
  image?: string[];
  offers:
    | OfferLd
    | {
        '@type': 'AggregateOffer';
        lowPrice: string;
        highPrice: string;
        priceCurrency: typeof SHOP_CURRENCY;
        offerCount: number;
        availability: `https://schema.org/${Availability}`;
        hasMerchantReturnPolicy?: MerchantReturnPolicyLd;
        offers: OfferLd[];
      };
  aggregateRating?: {
    '@type': 'AggregateRating';
    ratingValue: number;
    reviewCount: number;
  };
}

/** Exact decimal string for a price in kopiykas: 129900 -> "1299.00". No floats. */
export function priceToDecimal(price: Money): string {
  const kopiykas = Math.abs(price);
  const whole = Math.trunc(kopiykas / 100);
  const fraction = String(kopiykas % 100).padStart(2, '0');
  return `${price < 0 ? '-' : ''}${String(whole)}.${fraction}`;
}

function buildOffer(offer: OfferInput, returnPolicy?: MerchantReturnPolicyLd): OfferLd {
  return {
    '@type': 'Offer',
    url: offer.url,
    price: priceToDecimal(offer.price),
    priceCurrency: SHOP_CURRENCY,
    availability: `https://schema.org/${offer.availability}`,
    ...(offer.sku === undefined ? {} : { sku: offer.sku }),
    ...(returnPolicy === undefined ? {} : { hasMerchantReturnPolicy: returnPolicy }),
  };
}

/**
 * One offer becomes `Offer`; several (variants with different prices) become
 * an `AggregateOffer` with the low and high price. A product with no offer
 * cannot be a Rich Result, so that is an error, not an empty object.
 */
export function buildProduct(input: ProductInput): ProductLd {
  const [first, ...rest] = input.offers;
  if (first === undefined) throw new RangeError('buildProduct needs at least one offer');

  const offers = [first, ...rest].map((offer) => buildOffer(offer, input.returnPolicy));
  const prices = [first, ...rest].map((offer) => offer.price);
  const inStock = [first, ...rest].some((offer) => offer.availability === 'InStock');

  const offersLd: ProductLd['offers'] =
    rest.length === 0
      ? buildOffer(first, input.returnPolicy)
      : {
          '@type': 'AggregateOffer',
          lowPrice: priceToDecimal(prices.reduce((a, b) => (a < b ? a : b))),
          highPrice: priceToDecimal(prices.reduce((a, b) => (a > b ? a : b))),
          priceCurrency: SHOP_CURRENCY,
          offerCount: offers.length,
          availability: `https://schema.org/${inStock ? 'InStock' : 'OutOfStock'}`,
          ...(input.returnPolicy === undefined
            ? {}
            : { hasMerchantReturnPolicy: input.returnPolicy }),
          offers,
        };

  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'Product',
    name: input.name,
    sku: input.sku,
    brand: { '@type': 'Brand', name: input.brand },
    url: input.url,
    ...(input.description === undefined || input.description === null || input.description === ''
      ? {}
      : { description: input.description }),
    ...(input.images.length === 0 ? {} : { image: [...input.images] }),
    offers: offersLd,
    ...(input.rating === undefined || input.rating === null || input.rating.count === 0
      ? {}
      : {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: input.rating.value,
            reviewCount: input.rating.count,
          },
        }),
  };
}

export interface FaqPageLd {
  '@context': typeof SCHEMA_CONTEXT;
  '@type': 'FAQPage';
  mainEntity: {
    '@type': 'Question';
    name: string;
    acceptedAnswer: { '@type': 'Answer'; text: string };
  }[];
}

/** FAQPage markup for the questions a page SHOWS (the caller passes exactly the visible entries). */
export function buildFaqPage(
  entries: readonly { question: string; answerText: string }[],
): FaqPageLd {
  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'FAQPage',
    mainEntity: entries.map((entry) => ({
      '@type': 'Question',
      name: entry.question,
      acceptedAnswer: { '@type': 'Answer', text: entry.answerText },
    })),
  };
}

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * JSON for an inline `<script type="application/ld+json">`. `<`, `>` and `&`
 * are escaped so product text can never close the script element, and U+2028
 * and U+2029 are escaped for older parsers.
 */
export function serializeJsonLd(data: object): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')

    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(LINE_SEPARATOR)
    .join('\\u2028')
    .split(PARAGRAPH_SEPARATOR)
    .join('\\u2029');
}
