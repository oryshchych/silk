/**
 * Cart and checkout-intent operations (ADR-11, ADR-22).
 *
 * Every cart mutation locks the parent `carts` row FIRST: the cart_items
 * trigger bumps carts.version, so touching items without holding the parent
 * would deadlock against checkout.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';

import { cartItems, carts, checkoutIntents, productVariants } from '@store/db/schema';
import type { Tx } from '@store/db/types';

import {
  CartConvertedError,
  EmptyCartError,
  InvalidCartTokenError,
  InvalidQuantityError,
  VariantNotFoundError,
} from '../errors.ts';
import { acquireLocks } from '../locks/acquire-locks.ts';

const MAX_QUANTITY = 99;
const INTENT_TTL_HOURS = 24;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The token is the sole credential of a guest cart and its intents: server-minted, high entropy. */
const CART_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

const assertToken = (token: string): void => {
  if (!CART_TOKEN.test(token)) throw new InvalidCartTokenError();
};

async function cartByToken(tx: Tx, token: string): Promise<{ id: string } | undefined> {
  const [row] = await tx.select({ id: carts.id }).from(carts).where(eq(carts.token, token));
  return row;
}

/** Sets a line to `quantity` (0 removes it). Returns the new cart version. */
export async function setCartItem(
  tx: Tx,
  input: { cartToken: string; variantId: string; quantity: number },
): Promise<{ cartId: string; version: number }> {
  const { cartToken, variantId, quantity } = input;
  assertToken(cartToken);
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_QUANTITY) {
    throw new InvalidQuantityError();
  }

  if (quantity > 0) {
    const [variant] = UUID.test(variantId)
      ? await tx
          .select({ id: productVariants.id })
          .from(productVariants)
          .where(and(eq(productVariants.id, variantId), eq(productVariants.isActive, true)))
      : [];
    if (variant === undefined) throw new VariantNotFoundError();
  }

  await tx.insert(carts).values({ token: cartToken }).onConflictDoNothing();
  const cart = await cartByToken(tx, cartToken);
  if (cart === undefined) throw new Error('cart disappeared after insert');
  await acquireLocks(tx, { carts: [cart.id] });
  const [locked] = await tx
    .select({ convertedAt: carts.convertedAt })
    .from(carts)
    .where(eq(carts.id, cart.id));
  if (locked?.convertedAt !== null) throw new CartConvertedError();

  if (quantity === 0) {
    await tx
      .delete(cartItems)
      .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.variantId, variantId)));
  } else {
    await tx
      .insert(cartItems)
      .values({ cartId: cart.id, variantId, quantity })
      .onConflictDoUpdate({
        target: [cartItems.cartId, cartItems.variantId],
        set: { quantity },
      });
  }

  const [after] = await tx
    .select({ version: carts.version })
    .from(carts)
    .where(eq(carts.id, cart.id));
  return { cartId: cart.id, version: after?.version ?? 0 };
}

export interface CheckoutIntentView {
  intentId: string;
  cartVersion: number;
  /** Set once the order exists: the page must show it instead of "no stock". */
  orderId: string | null;
}

/**
 * Returns the intent bound to (cart, current version), creating it on the
 * first call. Every tab and every reload gets the same intent until the cart
 * changes; an already completed intent is returned as is (criterion 3).
 */
export async function startCheckout(
  tx: Tx,
  input: { cartToken: string },
): Promise<CheckoutIntentView> {
  assertToken(input.cartToken);
  const cart = await cartByToken(tx, input.cartToken);
  if (cart === undefined) throw new EmptyCartError();
  await acquireLocks(tx, { carts: [cart.id] });

  const [current] = await tx
    .select({ version: carts.version, convertedAt: carts.convertedAt })
    .from(carts)
    .where(eq(carts.id, cart.id));
  const version = current?.version ?? 0;

  if (current?.convertedAt !== null) {
    // A reload after the order was created shows that order, never "no stock".
    const [done] = await tx
      .select()
      .from(checkoutIntents)
      .where(and(eq(checkoutIntents.cartId, cart.id), isNotNull(checkoutIntents.completedAt)));
    if (done === undefined) throw new CartConvertedError();
    return { intentId: done.id, cartVersion: done.cartVersion, orderId: done.orderId };
  }

  const [items] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(cartItems)
    .where(eq(cartItems.cartId, cart.id));
  if ((items?.n ?? 0) === 0) throw new EmptyCartError();

  const [existing] = await tx
    .select()
    .from(checkoutIntents)
    .where(and(eq(checkoutIntents.cartId, cart.id), eq(checkoutIntents.cartVersion, version)));
  if (existing !== undefined) {
    if (existing.completedAt === null) {
      // Time is Postgres's: never compare Date.now() with a database field.
      await tx
        .update(checkoutIntents)
        .set({ expiresAt: sql`now() + make_interval(hours => ${INTENT_TTL_HOURS})` })
        .where(eq(checkoutIntents.id, existing.id));
    }
    return { intentId: existing.id, cartVersion: version, orderId: existing.orderId };
  }

  const [created] = await tx
    .insert(checkoutIntents)
    .values({
      cartId: cart.id,
      cartVersion: version,
      ownerToken: input.cartToken,
      expiresAt: sql`now() + make_interval(hours => ${INTENT_TTL_HOURS})`,
    })
    .returning({ id: checkoutIntents.id });
  if (created === undefined) throw new Error('intent insert returned no row');
  return { intentId: created.id, cartVersion: version, orderId: null };
}
