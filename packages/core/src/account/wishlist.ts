/**
 * The wishlist. Scoped by the customer id of the session. Only a product the storefront shows can be
 * added (a draft or hidden product answers "not found"), 200 at most (per-customer lock), and adding
 * twice is one row. A product that is hidden later simply drops out of the list.
 */
import { and, eq, sql } from 'drizzle-orm';

import { wishlistItems } from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';
import { wishlistItemDto, type WishlistItemDto } from '@store/shared/dto/account';
import { serialize } from '@store/shared/dto/serialize';

import { visibleProduct } from '../catalog/sql.ts';
import { DomainError } from '../errors.ts';
import { writeAudit } from '../audit/write-audit.ts';

export const MAX_WISHLIST = 200;

export class WishlistProductNotFoundError extends DomainError {
  constructor() {
    super('WISHLIST_NOT_FOUND', 'Product not found');
  }
}
export class WishlistFullError extends DomainError {
  constructor() {
    super('WISHLIST_FULL', 'The wishlist is full');
  }
}

interface Who {
  customerId: string;
  userId: string;
  ip: string | null;
}

export async function addToWishlist(tx: Tx, who: Who, productId: string): Promise<boolean> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wishlist:${who.customerId}`}, 0))`,
  );
  const found = await tx.execute(
    sql`SELECT 1 FROM products p WHERE p.id = ${productId}::uuid AND ${visibleProduct}`,
  );
  if (found.rows.length === 0) throw new WishlistProductNotFoundError();
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(wishlistItems)
    .where(eq(wishlistItems.customerId, who.customerId));
  const inserted = await tx
    .insert(wishlistItems)
    .values({ customerId: who.customerId, productId })
    .onConflictDoNothing()
    .returning({ productId: wishlistItems.productId });
  if (inserted.length === 0) return false;
  if ((count?.n ?? 0) >= MAX_WISHLIST) throw new WishlistFullError();
  await writeAudit(tx, {
    userId: who.userId,
    action: 'customer.wishlist_added',
    entity: 'product',
    entityId: productId,
    ip: who.ip,
  });
  return true;
}

export async function removeFromWishlist(tx: Tx, who: Who, productId: string): Promise<boolean> {
  const removed = await tx
    .delete(wishlistItems)
    .where(
      and(eq(wishlistItems.customerId, who.customerId), eq(wishlistItems.productId, productId)),
    )
    .returning({ productId: wishlistItems.productId });
  if (removed.length > 0) {
    await writeAudit(tx, {
      userId: who.userId,
      action: 'customer.wishlist_removed',
      entity: 'product',
      entityId: productId,
      ip: who.ip,
    });
  }
  return removed.length > 0;
}

export async function listMyWishlist(
  reader: Reader,
  customerId: string,
  locale: 'uk' | 'en',
): Promise<WishlistItemDto[]> {
  const result = await reader.execute<{
    id: string;
    slug: string;
    name: string;
    price: number;
    available: boolean;
  }>(
    sql`SELECT p.id, p.slug, ${locale === 'en' ? sql`p.name_en` : sql`p.name_uk`} AS name, p.base_price AS price,
               EXISTS (SELECT 1 FROM product_variants v
                        WHERE v.product_id = p.id AND v.is_active AND v.stock_quantity - v.reserved_quantity > 0) AS available
          FROM wishlist_items w JOIN products p ON p.id = w.product_id
         WHERE w.customer_id = ${customerId} AND ${visibleProduct}
         ORDER BY w.created_at DESC, p.id`,
  );
  return result.rows.map((row) =>
    serialize(wishlistItemDto, {
      productId: row.id,
      slug: row.slug,
      name: row.name,
      price: row.price,
      available: row.available,
    }),
  );
}
