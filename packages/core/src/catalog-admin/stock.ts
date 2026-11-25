import { eq } from 'drizzle-orm';

import { productVariants, products } from '@store/db/schema';
import type { Tx } from '@store/db/types';
import { categoryTag, listingTag, productTag, SHOWCASE_TAG } from '@store/shared/cache-tags';

import { adjustStock, type AdjustStockInput } from '../stock/adjust-stock.ts';
import type { AdminOutcome } from './outcome.ts';

/** `adjustStock` as an admin mutation: its audit draft, and the cache tags of the product it touches. */
export async function adjustVariantStock(
  tx: Tx,
  input: AdjustStockInput,
): Promise<AdminOutcome<{ before: number; after: number; replayed: boolean }>> {
  const result = await adjustStock(tx, input);
  const [owner] = await tx
    .select({ productId: products.id, categoryId: products.categoryId })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(productVariants.id, input.variantId));
  return {
    data: { before: result.before, after: result.after, replayed: result.replayed },
    audit: result.audit,
    // A replay or a no-op changed nothing: nothing to refresh.
    tags:
      owner === undefined || !result.changed
        ? []
        : [
            productTag(owner.productId),
            listingTag(owner.categoryId),
            categoryTag(owner.categoryId),
            SHOWCASE_TAG,
          ],
  };
}
