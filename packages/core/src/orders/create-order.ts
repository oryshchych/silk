/**
 * createOrder (ADR-11, docs/architecture/05-payment-flow.md): turns a checkout
 * intent into exactly one order, atomically.
 *
 * Order of operations matters:
 *  1. lock `carts` then `checkout_intents` (ADR-22 levels 1-2);
 *  2. a COMPLETED intent returns its order BEFORE any reservation. Otherwise a
 *     repeat of a successful purchase of the last unit would answer "no stock"
 *     instead of showing the existing order;
 *  3. a cart that changed since the intent was issued is a 409;
 *  4. lock the promo (6) and all variants (8, ascending) in one call, then read
 *     prices and validate the promo under those locks;
 *  5. reserve stock with atomic conditional UPDATEs, write everything, commit.
 * The payment attempt and the provider call are NOT here: they happen after
 * this transaction commits.
 */
import { createHash } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import { carts, checkoutIntents, orders } from '@store/db/schema';
import type { Tx } from '@store/db/types';

import {
  IntentExpiredError,
  IntentNotFoundError,
  IntentPayloadMismatchError,
  PromoRejectedError,
  StaleCartError,
  UnsupportedPurchaseError,
} from '../errors.ts';
import { acquireLocks } from '../locks/acquire-locks.ts';
import { calculateCart } from '../pricing/calculate-cart.ts';
import {
  cartVariantIds,
  loadCheckoutLines,
  reserveStock,
  type CheckoutLine,
} from './checkout-lines.ts';
import { persistOrder } from './persist-order.ts';
import type { CreateOrderInput } from './types.ts';
import { findPromoId, resolvePromo, type ResolvedPromo } from './promo.ts';

export type { CreateOrderInput } from './types.ts';

export interface CreateOrderResult {
  orderId: string;
  orderNumber: string;
  /** False when an earlier call already created this order. */
  created: boolean;
  /** Only on creation: the hash is all that is stored. */
  accessToken: string | null;
}

/** Essential parameters, in a fixed key order so the hash is stable. */
export function payloadFingerprint(input: CreateOrderInput): string {
  const essential = [
    input.contact.email,
    input.contact.phone,
    input.contact.name,
    input.delivery.method,
    input.delivery.address ?? '',
    input.paymentProvider,
    input.promoCode?.toUpperCase() ?? '',
  ];
  return createHash('sha256').update(JSON.stringify(essential)).digest('hex');
}

async function existingOrder(tx: Tx, orderId: string) {
  const [order] = await tx
    .select({ id: orders.id, orderNumber: orders.orderNumber })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (order === undefined) throw new Error(`completed intent points to missing order ${orderId}`);
  return order;
}

export async function createOrder(tx: Tx, input: CreateOrderInput): Promise<CreateOrderResult> {
  if (input.paymentProvider === 'gift_card')
    throw new UnsupportedPurchaseError('gift_card_provider');
  const fingerprint = payloadFingerprint(input);

  // Unlocked read, only to learn which cart to lock first.
  const [probe] = await tx
    .select({ cartId: checkoutIntents.cartId, ownerToken: checkoutIntents.ownerToken })
    .from(checkoutIntents)
    .where(eq(checkoutIntents.id, input.intentId));
  if (probe === undefined || probe.ownerToken !== input.ownerToken) throw new IntentNotFoundError();

  await acquireLocks(tx, { carts: [probe.cartId], checkout_intents: [input.intentId] });
  const [intent] = await tx
    .select()
    .from(checkoutIntents)
    .where(eq(checkoutIntents.id, input.intentId));
  if (intent === undefined) throw new IntentNotFoundError();

  if (intent.completedAt !== null) {
    if (intent.orderId === null) throw new Error(`completed intent ${intent.id} lost its order`);
    if (intent.payloadFingerprint !== fingerprint) throw new IntentPayloadMismatchError();
    const order = await existingOrder(tx, intent.orderId);
    return { orderId: order.id, orderNumber: order.orderNumber, created: false, accessToken: null };
  }

  const [cart] = await tx.select().from(carts).where(eq(carts.id, intent.cartId));
  if (cart === undefined || cart.convertedAt !== null || cart.version !== intent.cartVersion) {
    throw new StaleCartError();
  }
  // Postgres owns time: expiry is decided in SQL.
  const live = await tx.execute<{ live: boolean }>(
    sql`SELECT expires_at > now() AS live FROM checkout_intents WHERE id = ${intent.id}`,
  );
  if (live.rows[0]?.live !== true) throw new IntentExpiredError();

  const variantIds = await cartVariantIds(tx, intent.cartId);
  const promoId = input.promoCode === null ? null : await findPromoId(tx, input.promoCode);
  const locked = await acquireLocks(tx, {
    ...(promoId === null ? {} : { promo_codes: [promoId] }),
    product_variants: variantIds,
  });

  const lines = await loadCheckoutLines(tx, intent.cartId);
  if (lines.length !== variantIds.length || locked.product_variants?.length !== variantIds.length) {
    // The cart row is locked, so this cannot happen; if it does, never order fewer items silently.
    throw new Error('cart lines and locked variants disagree');
  }
  const promo = await resolveOptionalPromo(tx, input.promoCode, promoId, lines);
  const pricing = calculateCart(
    lines.map((line) => ({
      id: line.variantId,
      unitPrice: line.unitPrice,
      quantity: line.quantity,
      eligible: promo?.eligibleVariantIds.has(line.variantId) ?? false,
    })),
    promo?.rule ?? null,
  );

  await reserveStock(tx, lines);
  const persisted = await persistOrder(tx, {
    input,
    intentId: intent.id,
    cartId: intent.cartId,
    fingerprint,
    lines,
    pricing,
    promo,
  });
  return {
    orderId: persisted.orderId,
    orderNumber: persisted.orderNumber,
    created: true,
    accessToken: persisted.accessToken,
  };
}

async function resolveOptionalPromo(
  tx: Tx,
  code: string | null,
  promoId: string | null,
  lines: readonly CheckoutLine[],
): Promise<ResolvedPromo | null> {
  if (code === null) return null;
  if (promoId === null) throw new PromoRejectedError('unknown code');
  const { subtotal } = calculateCart(
    lines.map((l) => ({
      id: l.variantId,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
      eligible: false,
    })),
    null,
  );
  return await resolvePromo(tx, promoId, lines, subtotal);
}
