/**
 * Guest cart into the customer's cart at login (phase 2 criterion: merged,
 * never overwritten). Quantities add up (capped at the per-line maximum); the
 * guest cart is deleted afterwards, which also drops its unfinished intents.
 * A converted guest cart has nothing to merge and is left alone.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import { cartItems, carts } from '@store/db/schema';
import type { Tx } from '@store/db/types';

import { CartConvertedError } from '../errors.ts';
import { acquireLocks } from '../locks/acquire-locks.ts';

const MAX_QUANTITY = 99;

export async function mergeGuestCart(
  tx: Tx,
  input: { guestToken: string; customerCartToken: string },
): Promise<{ merged: number }> {
  const found = await tx
    .select({ id: carts.id, token: carts.token })
    .from(carts)
    .where(inArray(carts.token, [input.guestToken, input.customerCartToken]));
  const guest = found.find((cart) => cart.token === input.guestToken);
  if (guest === undefined || input.guestToken === input.customerCartToken) return { merged: 0 };

  await tx.insert(carts).values({ token: input.customerCartToken }).onConflictDoNothing();
  const [target] = await tx
    .select({ id: carts.id })
    .from(carts)
    .where(eq(carts.token, input.customerCartToken));
  if (target === undefined) throw new Error('customer cart disappeared after insert');

  // Both carts are parents of cart_items rows whose trigger bumps the version: lock them
  // together, ascending (ADR-22 level 1).
  await acquireLocks(tx, { carts: [guest.id, target.id] });
  const [state] = await tx
    .select({ convertedAt: carts.convertedAt })
    .from(carts)
    .where(eq(carts.id, target.id));
  if (state === undefined) throw new Error('customer cart disappeared after lock');
  // The storefront rotates the cart token after an order, so a converted target means a stale token.
  if (state.convertedAt !== null) throw new CartConvertedError();
  const [guestState] = await tx
    .select({ convertedAt: carts.convertedAt })
    .from(carts)
    .where(eq(carts.id, guest.id));
  if (guestState?.convertedAt !== null) return { merged: 0 };

  const items = await tx
    .select({ variantId: cartItems.variantId, quantity: cartItems.quantity })
    .from(cartItems)
    .where(eq(cartItems.cartId, guest.id));
  for (const item of items) {
    await tx
      .insert(cartItems)
      .values({ cartId: target.id, variantId: item.variantId, quantity: item.quantity })
      .onConflictDoUpdate({
        target: [cartItems.cartId, cartItems.variantId],
        set: { quantity: sql`least(${cartItems.quantity} + ${item.quantity}, ${MAX_QUANTITY})` },
      });
  }
  await tx.delete(carts).where(and(eq(carts.id, guest.id)));
  return { merged: items.length };
}
