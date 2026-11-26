/**
 * Builds analytics items from what a page already loaded on the server (DTOs and cart views).
 * Prices stay `Money` here; the conversion to a number of hryvnias is in `@store/shared/analytics`.
 */
import type { AnalyticsItem } from '@store/shared/analytics';
import type { CartLineView } from '@store/core/cart-view';
import type { ProductCardDto, ProductDetailDto } from '@store/shared/dto/catalog';
import type { CustomerOrderDto } from '@store/shared/dto/order';

export function productItem(product: ProductDetailDto): AnalyticsItem {
  return {
    id: product.id,
    name: product.name,
    brand: product.brand,
    category: product.category.name,
    price: product.price,
    quantity: 1,
  };
}

/** One item per variant, keyed by variant id: what "add to cart" reports for the chosen size and colour. */
export function variantItems(product: ProductDetailDto): Record<string, AnalyticsItem> {
  return Object.fromEntries(
    product.variants.map((variant) => [
      variant.id,
      {
        id: variant.sku,
        name: product.name,
        brand: product.brand,
        category: product.category.name,
        variant: `${variant.colorSlug}, ${variant.sizeLabel}`,
        price: variant.price,
        quantity: 1,
      },
    ]),
  );
}

export const cardItems = (cards: readonly ProductCardDto[]): AnalyticsItem[] =>
  cards.map((card) => ({
    id: card.id,
    name: card.name,
    brand: card.brand,
    price: card.price,
    quantity: 1,
  }));

export const cartLineItem = (line: CartLineView): AnalyticsItem => ({
  id: line.sku,
  name: line.name,
  variant: `${line.colorName}, ${line.sizeLabel}`,
  price: line.unitPrice,
  quantity: line.quantity,
});

/** Revenue of an order is the goods after discounts; shipping is reported separately. */
export const orderItems = (order: CustomerOrderDto): AnalyticsItem[] =>
  order.items.map((item) => ({
    id: item.sku,
    name: item.name,
    variant: `${item.colorName}, ${item.sizeLabel}`,
    // The list price per unit; the revenue after discounts goes in the event's `value`.
    price: item.unitPrice,
    quantity: item.quantity,
  }));
