import { describe, expect, it } from 'vitest';

import type { CartLineView } from '@store/core/cart-view';
import { productCardDto, productDetailDto } from '@store/shared/dto/catalog';
import { customerOrderDto } from '@store/shared/dto/order';
import { serialize } from '@store/shared/dto/serialize';
import { money } from '@store/shared/money';

import { cardItems, cartLineItem, orderItems, productItem, variantItems } from './items';

const PRODUCT_ID = '0193f0a4-7c3e-7000-8000-000000000001';
const VARIANT_ID = '0193f0a4-7c3e-7000-8000-000000000002';

const product = serialize(productDetailDto, {
  id: PRODUCT_ID,
  slug: 'aurora',
  sku: 'AUR',
  brand: 'Aurelia',
  name: 'Bra',
  shortDescription: null,
  description: null,
  composition: null,
  care: null,
  price: 129_900,
  compareAtPrice: null,
  badge: 'none',
  ratingAvg: null,
  reviewsCount: 0,
  metaTitle: null,
  metaDescription: null,
  ogImageUrl: null,
  noindex: false,
  category: { slug: 'bras', name: 'Bras' },
  breadcrumbs: [{ slug: 'bras', name: 'Bras' }],
  images: [],
  colors: [{ slug: 'black', name: 'Black', hex: '#000000' }],
  variants: [
    {
      id: VARIANT_ID,
      sku: 'AUR-75B-BLK',
      sizeLabel: '75B',
      sizeSystem: 'bra',
      band: 75,
      cup: 'B',
      colorSlug: 'black',
      price: 129_900,
      available: true,
      lastUnits: false,
    },
  ],
  attributes: [],
});

const card = serialize(productCardDto, {
  id: PRODUCT_ID,
  slug: 'aurora',
  name: 'Bra',
  brand: 'Aurelia',
  price: 129_900,
  compareAtPrice: null,
  badge: 'none',
  ratingAvg: null,
  reviewsCount: 0,
  inStock: true,
  image: null,
});

const line: CartLineView = {
  variantId: VARIANT_ID,
  productId: PRODUCT_ID,
  sku: 'AUR-75B-BLK',
  productSlug: 'aurora',
  name: 'Bra',
  sizeLabel: '75B',
  colorName: 'Black',
  image: null,
  unitPrice: money(129_900),
  quantity: 2,
  lineTotal: money(259_800),
  available: 5,
  sellable: true,
};

const order = (productId: string | null) =>
  serialize(customerOrderDto, {
    orderNumber: 'SK-2026-000001',
    paymentProvider: 'cod',
    deliveryMethod: 'np_warehouse',
    deliveryCity: null,
    deliveryPoint: null,
    deliveryAddress: null,
    status: 'pending',
    paymentStatus: 'pending',
    createdAt: '2026-11-26T10:00:00.000Z',
    subtotal: 259_800,
    discountTotal: 0,
    shippingTotal: 0,
    total: 259_800,
    ttn: null,
    items: [
      {
        name: 'Bra',
        productId,
        sku: 'AUR-75B-BLK',
        sizeLabel: '75B',
        colorName: 'Black',
        unitPrice: 129_900,
        quantity: 2,
        lineDiscount: 0,
        lineTotal: 259_800,
      },
    ],
  });

describe('analytics item ids', () => {
  it('one product has ONE id on every event: list, view, add, cart and purchase (the feed item_group_id)', () => {
    const ids = [
      cardItems([card])[0]?.id,
      productItem(product).id,
      variantItems(product)[VARIANT_ID]?.id,
      cartLineItem(line).id,
      orderItems(order(PRODUCT_ID))[0]?.id,
    ];
    expect(new Set(ids)).toEqual(new Set([PRODUCT_ID]));
  });

  it('keeps the size and colour as the variant, and a deleted product falls back to the variant sku', () => {
    expect(variantItems(product)[VARIANT_ID]?.variant).toBe('black, 75B');
    expect(cartLineItem(line).variant).toBe('Black, 75B');
    expect(orderItems(order(null))[0]?.id).toBe('AUR-75B-BLK');
  });

  it('the cart quantity and the list price come from the data, not the page', () => {
    expect(cartLineItem(line).quantity).toBe(2);
    expect(cartLineItem(line).price).toBe(129_900);
  });
});
