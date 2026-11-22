/**
 * Writes the order and everything that must exist with it, inside the
 * caller's transaction (ADR-4: order, reservation, history and outbox commit
 * together or not at all).
 */
import { createHash, randomBytes } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import {
  auditLog,
  carts,
  checkoutIntents,
  orderItems,
  orderStatusHistory,
  orders,
  outbox,
  promoCodeRedemptions,
  settings,
  stockReservations,
} from '@store/db/schema';
import type { Tx } from '@store/db/types';

import { PromoRejectedError } from '../errors.ts';
import type { CartPricing } from '../pricing/calculate-cart.ts';
import type { CheckoutLine } from './checkout-lines.ts';
import type { CreateOrderInput } from './types.ts';
import type { ResolvedPromo } from './promo.ts';

const DEFAULT_TTL_MINUTES = { card: 30, transfer: 24 * 60, cod: 2 * 60 };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

/** Reservation lifetime in minutes by payment method (ADR-3). Values live in settings. */
async function reservationMinutes(
  tx: Tx,
  provider: CreateOrderInput['paymentProvider'],
): Promise<number> {
  const [row] = await tx.select().from(settings).where(eq(settings.key, 'reservation_ttl'));
  const ttl = isRecord(row?.value) ? row.value : {};
  if (provider === 'bank_transfer') {
    return numberOr(ttl['transfer_hours'], DEFAULT_TTL_MINUTES.transfer / 60) * 60;
  }
  if (provider === 'cod') return numberOr(ttl['cod_hours'], DEFAULT_TTL_MINUTES.cod / 60) * 60;
  return numberOr(ttl['card_minutes'], DEFAULT_TTL_MINUTES.card);
}

/**
 * Takes one use of a promo. Conditional on the limit even though the caller
 * holds the row lock: if the lock is ever bypassed the use is refused here
 * instead of overshooting (the CHECK `promo_uses_lte_max` is the last line).
 */
export async function consumePromoUse(tx: Tx, promoId: string): Promise<void> {
  const updated = await tx.execute(
    sql`UPDATE promo_codes SET uses_count = uses_count + 1
         WHERE id = ${promoId} AND (max_uses IS NULL OR uses_count < max_uses)
        RETURNING id`,
  );
  if (updated.rows.length === 0) throw new PromoRejectedError('usage limit reached');
}

export interface PersistedOrder {
  orderId: string;
  orderNumber: string;
  /** Returned once; only its hash is stored. */
  accessToken: string;
}

export async function persistOrder(
  tx: Tx,
  args: {
    input: CreateOrderInput;
    intentId: string;
    cartId: string;
    fingerprint: string;
    lines: readonly CheckoutLine[];
    pricing: CartPricing;
    promo: ResolvedPromo | null;
  },
): Promise<PersistedOrder> {
  const { input, intentId, cartId, fingerprint, lines, pricing, promo } = args;
  const accessToken = randomBytes(32).toString('base64url');

  const [order] = await tx
    .insert(orders)
    .values({
      orderNumber: sql`next_order_number()`,
      checkoutIntentId: intentId,
      paymentProvider: input.paymentProvider,
      customerEmail: input.contact.email,
      customerPhone: input.contact.phone,
      customerName: input.contact.name,
      deliveryMethod: input.delivery.method,
      deliveryAddress: input.delivery.address ?? null,
      subtotal: pricing.subtotal,
      discountTotal: pricing.discountTotal,
      shippingTotal: pricing.shippingTotal,
      total: pricing.total,
      promoCode: promo?.code ?? null,
      locale: input.locale,
      accessTokenHash: createHash('sha256').update(accessToken).digest('hex'),
    })
    .returning({ id: orders.id, orderNumber: orders.orderNumber });
  if (order === undefined) throw new Error('order insert returned no row');

  const byVariant = new Map(lines.map((line) => [line.variantId, line]));
  await tx.insert(orderItems).values(
    pricing.lines.map((priced) => {
      const line = byVariant.get(priced.id);
      if (line === undefined) throw new Error(`priced line ${priced.id} has no source line`);
      return {
        orderId: order.id,
        productId: line.productId,
        variantId: line.variantId,
        productUidSnapshot: line.productId,
        variantUidSnapshot: line.variantId,
        nameSnapshot: line.nameSnapshot,
        skuSnapshot: line.skuSnapshot,
        brandSnapshot: line.brandSnapshot,
        sizeLabel: line.sizeLabel,
        sizeSystemSnapshot: line.sizeSystem,
        colorName: line.colorName,
        uktzedSnapshot: line.uktzed,
        unitPrice: priced.unitPrice,
        lineDiscount: priced.lineDiscount,
        unitCostSnapshot: line.unitCost,
        quantity: priced.quantity,
        lineTotal: priced.lineTotal,
      };
    }),
  );

  // expires_at is computed by Postgres (now() + interval), never from JS time.
  // make_interval(mins => int): settings may hold fractions (0.3 h), so round to whole minutes.
  const minutes = Math.max(1, Math.round(await reservationMinutes(tx, input.paymentProvider)));
  await tx.insert(stockReservations).values(
    lines.map((line) => ({
      variantId: line.variantId,
      orderId: order.id,
      quantity: line.quantity,
      expiresAt: sql`now() + make_interval(mins => ${minutes})`,
    })),
  );

  if (promo !== null) {
    await tx.insert(promoCodeRedemptions).values({
      promoCodeId: promo.id,
      orderId: order.id,
      discountAmount: pricing.discountTotal,
    });
    await consumePromoUse(tx, promo.id);
  }

  await tx.insert(orderStatusHistory).values([
    { orderId: order.id, toStatus: 'pending', field: 'status', source: 'checkout' },
    { orderId: order.id, toStatus: 'pending', field: 'payment_status', source: 'checkout' },
  ]);
  await tx.insert(auditLog).values({
    action: 'create',
    entity: 'order',
    entityId: order.id,
    diff: { source: 'checkout', actor: 'guest', total: pricing.total },
  });
  // Mail goes through the outbox, never straight from the request (AGENTS.md 5b).
  await tx.insert(outbox).values({
    topic: 'email.order-created',
    payload: { orderId: order.id },
    dedupKey: `order-created:${order.id}`,
  });

  await tx
    .update(checkoutIntents)
    .set({ orderId: order.id, completedAt: sql`now()`, payloadFingerprint: fingerprint })
    .where(eq(checkoutIntents.id, intentId));
  await tx
    .update(carts)
    .set({ convertedOrderId: order.id, convertedAt: sql`now()` })
    .where(eq(carts.id, cartId));

  return { orderId: order.id, orderNumber: order.orderNumber, accessToken };
}
