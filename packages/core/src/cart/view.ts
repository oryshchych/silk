/**
 * The cart as the buyer sees it. Read-only, an explicit field list (no cost
 * price, no internal ids beyond the variant the page needs to change a line).
 * Prices and stock come from the database on every read (AGENTS.md 2.2).
 */
import { and, asc, eq } from 'drizzle-orm';

import { cartItems, carts, colors, productVariants, products, sizes } from '@store/db/schema';
import type { Reader } from '@store/db/types';
import type { ImageDto } from '@store/shared/dto/catalog';
import { money, multiply, sum, ZERO, type Money } from '@store/shared/money';

import { fetchMainImages } from '../catalog/images.ts';
import type { SiteLocale } from '../catalog/sql.ts';

export interface CartLineView {
  variantId: string;
  productSlug: string;
  name: string;
  sizeLabel: string;
  colorName: string;
  image: ImageDto | null;
  unitPrice: Money;
  quantity: number;
  lineTotal: Money;
  /** Units that can still be reserved right now (stock minus reserved), at least 0. */
  available: number;
  /** False when the product or variant was switched off since it was added. */
  sellable: boolean;
}

export interface CartView {
  lines: CartLineView[];
  subtotal: Money;
  itemCount: number;
  version: number;
  /** True when some line cannot be ordered as it stands (gone, or more than is left). */
  hasProblems: boolean;
}

const EMPTY: CartView = { lines: [], subtotal: ZERO, itemCount: 0, version: 0, hasProblems: false };

const CART_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

export async function getCartView(
  reader: Reader,
  cartToken: string,
  locale: SiteLocale,
): Promise<CartView> {
  if (!CART_TOKEN.test(cartToken)) return EMPTY;
  const [cart] = await reader
    .select({ id: carts.id, version: carts.version, convertedAt: carts.convertedAt })
    .from(carts)
    .where(eq(carts.token, cartToken));
  if (cart === undefined || cart.convertedAt !== null) return EMPTY;

  const rows = await reader
    .select({
      variantId: productVariants.id,
      productId: products.id,
      slug: products.slug,
      nameUk: products.nameUk,
      nameEn: products.nameEn,
      sizeLabel: sizes.label,
      colorUk: colors.nameUk,
      colorEn: colors.nameEn,
      quantity: cartItems.quantity,
      priceOverride: productVariants.priceOverride,
      basePrice: products.basePrice,
      stock: productVariants.stockQuantity,
      reserved: productVariants.reservedQuantity,
      variantActive: productVariants.isActive,
      productActive: products.isActive,
    })
    .from(cartItems)
    .innerJoin(productVariants, eq(productVariants.id, cartItems.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(sizes, eq(sizes.id, productVariants.sizeId))
    .innerJoin(colors, eq(colors.id, productVariants.colorId))
    .where(and(eq(cartItems.cartId, cart.id)))
    .orderBy(asc(cartItems.addedAt), asc(cartItems.id));

  const names = rows.map((row) => ({
    id: row.productId,
    name: locale === 'en' ? row.nameEn : row.nameUk,
  }));
  const images = await fetchMainImages(reader, names, locale);

  const lines = rows.map((row): CartLineView => {
    const unitPrice = money(row.priceOverride ?? row.basePrice);
    const available = Math.max(row.stock - row.reserved, 0);
    return {
      variantId: row.variantId,
      productSlug: row.slug,
      name: locale === 'en' ? row.nameEn : row.nameUk,
      sizeLabel: row.sizeLabel,
      colorName: locale === 'en' ? row.colorEn : row.colorUk,
      image: images.get(row.productId) ?? null,
      unitPrice,
      quantity: row.quantity,
      lineTotal: multiply(unitPrice, row.quantity),
      available,
      sellable: row.variantActive && row.productActive,
    };
  });
  return {
    lines,
    subtotal: sum(lines.map((line) => line.lineTotal)),
    itemCount: lines.reduce((count, line) => count + line.quantity, 0),
    version: cart.version,
    hasProblems: lines.some((line) => !line.sellable || line.quantity > line.available),
  };
}
