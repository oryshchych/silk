/**
 * Reading and reserving the lines of a checkout. Prices, names and
 * availability come from the database (AGENTS.md 2.2); the client contributes
 * nothing but the intent id.
 */
import { asc, eq, sql } from 'drizzle-orm';

import { cartItems, colors, productVariants, products, sizes } from '@store/db/schema';
import type { Tx } from '@store/db/types';
import { money, type Money } from '@store/shared/money';

import { InsufficientStockError, UnsupportedPurchaseError, type StockProblem } from '../errors.ts';

export interface CheckoutLine {
  variantId: string;
  productId: string;
  categoryId: string;
  quantity: number;
  unitPrice: Money;
  /** Already discounted by the shop (compare-at price): some promos skip it. */
  hasCompareAtPrice: boolean;
  isSellable: boolean;
  nameSnapshot: string;
  skuSnapshot: string;
  brandSnapshot: string;
  sizeLabel: string;
  sizeSystem: string;
  colorName: string;
  uktzed: string | null;
  unitCost: Money | null;
}

/** Variant ids of the cart, ascending: the lock order of ADR-22. */
export async function cartVariantIds(tx: Tx, cartId: string): Promise<string[]> {
  const rows = await tx
    .select({ variantId: cartItems.variantId })
    .from(cartItems)
    .where(eq(cartItems.cartId, cartId))
    .orderBy(asc(cartItems.variantId));
  return rows.map((row) => row.variantId);
}

/**
 * Call AFTER the variant rows are locked. Product-level fields (base price,
 * compare-at price, kind) have no lock level in ADR-22, so a concurrent admin
 * edit may be one commit newer than this snapshot; `is_active` is re-checked
 * inside the reserving UPDATE itself. See NOTES.md.
 */
export async function loadCheckoutLines(tx: Tx, cartId: string): Promise<CheckoutLine[]> {
  const rows = await tx
    .select({
      variantId: productVariants.id,
      productId: products.id,
      categoryId: products.categoryId,
      quantity: cartItems.quantity,
      priceOverride: productVariants.priceOverride,
      basePrice: products.basePrice,
      compareAtPrice: products.compareAtPrice,
      variantActive: productVariants.isActive,
      productActive: products.isActive,
      kind: products.kind,
      name: products.nameUk,
      sku: productVariants.sku,
      brand: products.brand,
      sizeLabel: sizes.label,
      sizeSystem: sizes.system,
      colorName: colors.nameUk,
      uktzed: products.uktzedCode,
      costPrice: products.costPrice,
    })
    .from(cartItems)
    .innerJoin(productVariants, eq(productVariants.id, cartItems.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(sizes, eq(sizes.id, productVariants.sizeId))
    .innerJoin(colors, eq(colors.id, productVariants.colorId))
    .where(eq(cartItems.cartId, cartId))
    .orderBy(asc(productVariants.id));

  return rows.map((row) => {
    if (row.kind === 'gift_card') throw new UnsupportedPurchaseError('gift_card_product');
    return {
      variantId: row.variantId,
      productId: row.productId,
      categoryId: row.categoryId,
      quantity: row.quantity,
      unitPrice: money(row.priceOverride ?? row.basePrice),
      hasCompareAtPrice: row.compareAtPrice !== null,
      isSellable: row.variantActive && row.productActive,
      nameSnapshot: row.name,
      skuSnapshot: row.sku,
      brandSnapshot: row.brand,
      sizeLabel: row.sizeLabel,
      sizeSystem: row.sizeSystem,
      colorName: row.colorName,
      uktzed: row.uktzed,
      unitCost: row.costPrice === null ? null : money(row.costPrice),
    };
  });
}

/**
 * ADR-3: one atomic conditional UPDATE per variant, ascending id. No SELECT
 * before it and no check in JS. Every line is attempted so the caller gets the
 * full list of problem positions, not just the first.
 *
 * Runs in a SAVEPOINT: if the error is caught by a caller that keeps using the
 * outer transaction, the lines reserved before the failure are rolled back too.
 */
export async function reserveStock(tx: Tx, lines: readonly CheckoutLine[]): Promise<void> {
  await tx.transaction(async (savepoint) => {
    const problems: StockProblem[] = [];
    for (const line of lines) {
      const reserved = line.isSellable
        ? await savepoint.execute(
            sql`UPDATE product_variants v
                   SET reserved_quantity = v.reserved_quantity + ${line.quantity}
                 WHERE v.id = ${line.variantId}
                   AND v.is_active
                   AND v.stock_quantity - v.reserved_quantity >= ${line.quantity}
                   AND EXISTS (SELECT 1 FROM products p WHERE p.id = v.product_id AND p.is_active)
                RETURNING v.id`,
          )
        : { rows: [] };
      if (reserved.rows.length === 0) {
        problems.push({ variantId: line.variantId, requested: line.quantity, available: 0 });
      }
    }
    if (problems.length === 0) return;

    // The variant rows are locked, so this read is stable and only informs the message.
    const detailed = await Promise.all(
      problems.map(async (problem) => {
        const line = lines.find((l) => l.variantId === problem.variantId);
        if (line?.isSellable !== true) return problem; // not for sale: available stays 0
        const [row] = await savepoint
          .select({
            available: sql<number>`greatest(${productVariants.stockQuantity} - ${productVariants.reservedQuantity}, 0)`,
          })
          .from(productVariants)
          .where(eq(productVariants.id, problem.variantId));
        return { ...problem, available: row?.available ?? 0 };
      }),
    );
    throw new InsufficientStockError(detailed);
  });
}
