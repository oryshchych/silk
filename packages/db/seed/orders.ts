/**
 * Замовлення за сценаріями з scenarios.ts. Суми — копійки, і кожне
 * замовлення проходить звірку з schema.ts (блок SQL, п. 8c):
 *   subtotal       = Σ line_total + Σ line_discount
 *   discount_total = Σ line_discount
 *   total          = subtotal − discount_total + shipping_total + adjustment_total
 */
import { eq, sql, type SQL } from 'drizzle-orm';

import {
  orderItems,
  orders,
  orderStatusHistory,
  paymentAttempts,
  productVariants,
  promoCodeRedemptions,
  refundOperations,
  returnRequestItems,
  returnRequests,
  stockReservations,
} from '../src/schema.ts';
import type { Tx } from '../src/types.ts';
import type { SeedVariant } from './catalog.ts';
import type { SeedCustomer } from './customers.ts';
import type { SeedPromo } from './promo.ts';
import type { Rng } from './random.ts';
import {
  SCENARIOS,
  statusPath,
  type AttemptOutcome,
  type OrderStatus,
  type PaymentStatus,
  type Scenario,
} from './scenarios.ts';

/** Позиція, з якої seed відгуків бере пари «товар — клієнт». */
export interface SeedPurchase {
  orderId: string;
  customerId: string;
  productId: string;
  sizeLabel: string;
  delivered: boolean;
}

interface Line {
  variant: SeedVariant;
  quantity: number;
  discount: number;
}

/** Момент відносно now() — рахує Postgres, не Node (AGENTS.md §4b.6). */
const at = (daysAgo: number, plusHours = 0): SQL =>
  sql`now() - make_interval(days => ${daysAgo}) + make_interval(hours => ${plusHours})`;

const GUEST = { name: 'Гість Тестовий', email: 'guest@example.com', phone: '+380930000000' };

const RESERVATION_TTL: Record<string, SQL> = {
  mono: sql`now() + interval '30 minutes'`,
  wayforpay: sql`now() + interval '30 minutes'`,
  bank_transfer: sql`now() + interval '24 hours'`,
  cod: sql`now() + interval '2 hours'`,
};

function pickLines(rng: Rng, variants: SeedVariant[], s: Scenario): Line[] {
  const eligible = variants.filter(
    (v) =>
      v.isActive &&
      v.stock >= 2 &&
      (s.promo !== 'BRAS15' || (v.categorySlug === 'bras' && !v.onSale)),
  );
  const lines: Line[] = [];
  const used = new Set<string>();
  while (lines.length < s.lines) {
    const variant = rng.pick(eligible);
    if (used.has(variant.productId)) continue;
    used.add(variant.productId);
    lines.push({ variant, quantity: s.lines === 1 ? rng.int(1, 2) : 1, discount: 0 });
  }
  // MINUS200 діє від 1500 ₴: добираємо позиції, доки сума не дотягне.
  while (s.promo === 'MINUS200' && subtotalOf(lines) < 150000) {
    const variant = rng.pick(eligible);
    if (used.has(variant.productId)) continue;
    used.add(variant.productId);
    lines.push({ variant, quantity: 1, discount: 0 });
  }
  return lines;
}

const subtotalOf = (lines: Line[]): number =>
  lines.reduce((sum, l) => sum + l.variant.unitPrice * l.quantity, 0);

/** Розподіл знижки по позиціях; залишок від округлення — на останню. */
function applyPromo(lines: Line[], promo: SeedPromo | undefined): void {
  if (promo === undefined || promo.type === 'free_shipping') return;
  const gross = lines.map((l) => l.variant.unitPrice * l.quantity);
  if (promo.type === 'percent') {
    const subtotal = gross.reduce((a, b) => a + b, 0);
    // WELCOME10 має стелю 500 ₴ — враховуємо її, як pricing у core.
    const cap = promo.code === 'WELCOME10' ? 50000 : Number.POSITIVE_INFINITY;
    const total = Math.min(Math.round((subtotal * promo.value) / 100), cap);
    spread(lines, gross, total);
    return;
  }
  spread(lines, gross, promo.value);
}

function spread(lines: Line[], gross: number[], total: number): void {
  const subtotal = gross.reduce((a, b) => a + b, 0);
  let left = total;
  lines.forEach((line, i) => {
    const share = i === lines.length - 1 ? left : Math.floor((total * (gross[i] ?? 0)) / subtotal);
    line.discount = share;
    left -= share;
  });
}

const attemptState = (o: AttemptOutcome): 'pending' | 'in_flight' | 'succeeded' | 'failed' =>
  o === 'paid' || o === 'authorized' ? 'succeeded' : o === 'pending' ? 'in_flight' : 'failed';

const attemptStatus = (o: AttemptOutcome): PaymentStatus => o;

export async function seedOrders(
  tx: Tx,
  rng: Rng,
  variants: SeedVariant[],
  people: SeedCustomer[],
  promos: SeedPromo[],
): Promise<SeedPurchase[]> {
  const purchases: SeedPurchase[] = [];
  for (const [n, s] of SCENARIOS.entries()) {
    purchases.push(...(await seedOrder(tx, rng, n, s, variants, people, promos)));
  }
  // uses_count — кількість спожитих погашень, як веде його core.
  await tx.execute(sql`
    UPDATE promo_codes p SET uses_count = r.n
      FROM (SELECT promo_code_id, count(*)::int AS n FROM promo_code_redemptions
             WHERE state = 'consumed' GROUP BY promo_code_id) r
     WHERE p.id = r.promo_code_id`);
  return purchases;
}

/** Один сценарій — одне замовлення з усіма залежними рядками. */
async function seedOrder(
  tx: Tx,
  rng: Rng,
  n: number,
  s: Scenario,
  variants: SeedVariant[],
  people: SeedCustomer[],
  promos: SeedPromo[],
): Promise<SeedPurchase[]> {
  const customer = s.customer === null ? undefined : people[s.customer];
  const contact = customer ?? GUEST;
  const promo = promos.find((p) => p.code === s.promo);
  const lines = pickLines(rng, variants, s);
  applyPromo(lines, promo);

  const subtotal = subtotalOf(lines);
  const discountTotal = lines.reduce((sum, l) => sum + l.discount, 0);
  const total = subtotal - discountTotal;
  const captured = ['paid', 'refunded', 'partially_refunded'].includes(s.payment) ? total : 0;
  const path = statusPath(s.status);
  const step = (name: OrderStatus): number => path.indexOf(name) * 6;

  const [order] = await tx
    .insert(orders)
    .values({
      orderNumber: sql`next_order_number()`,
      customerId: customer?.id ?? null,
      status: s.status,
      paymentStatus: s.payment,
      paymentProvider: s.provider,
      customerEmail: contact.email,
      customerPhone: contact.phone,
      customerName: contact.name,
      deliveryMethod: s.delivery,
      deliverySettlementName: s.delivery === 'pickup' ? null : 'Київ',
      deliveryWarehouseName: s.delivery === 'np_warehouse' ? `Відділення №${String(n + 1)}` : null,
      deliveryAddress: s.delivery === 'np_courier' ? 'вул. Хрещатик, 1, кв. 10' : null,
      ttn: step('shipped') >= 0 ? `2045${String(1000000000 + n)}` : null,
      subtotal,
      discountTotal,
      total,
      capturedTotal: captured,
      shippingPaidBy: s.promo === 'FREESHIP' ? 'sender' : 'recipient',
      shippingCostActual: s.promo === 'FREESHIP' ? 8000 : null,
      promoCode: promo?.code ?? null,
      paidAt: captured > 0 ? at(s.daysAgo, 1) : null,
      shippedAt: step('shipped') >= 0 ? at(s.daysAgo, step('shipped')) : null,
      deliveredAt: step('delivered') >= 0 ? at(s.daysAgo, step('delivered')) : null,
      cancelledAt: s.status === 'cancelled' ? at(s.daysAgo, 1) : null,
      createdAt: at(s.daysAgo),
    })
    .returning({ id: orders.id });
  if (order === undefined) throw new Error(`замовлення ${String(n)} не створилось`);

  const items = await tx
    .insert(orderItems)
    .values(
      lines.map((l) => ({
        orderId: order.id,
        productId: l.variant.productId,
        variantId: l.variant.id,
        productUidSnapshot: l.variant.productId,
        variantUidSnapshot: l.variant.id,
        nameSnapshot: l.variant.nameUk,
        skuSnapshot: l.variant.sku,
        brandSnapshot: l.variant.brand,
        sizeLabel: l.variant.sizeLabel,
        sizeSystemSnapshot: l.variant.sizeSystem,
        colorName: l.variant.colorNameUk,
        categoryPathSnapshot: l.variant.categoryPath,
        unitPrice: l.variant.unitPrice,
        lineDiscount: l.discount,
        unitCostSnapshot: l.variant.unitCost,
        quantity: l.quantity,
        lineTotal: l.variant.unitPrice * l.quantity - l.discount,
        createdAt: at(s.daysAgo),
      })),
    )
    .returning({
      id: orderItems.id,
      lineTotal: orderItems.lineTotal,
      quantity: orderItems.quantity,
    });

  // Спроби оплати: сума кожної — повна сума замовлення; captured — лише в успішної.
  let currentAttempt = '';
  for (const [i, outcome] of s.attempts.entries()) {
    const terminal = outcome !== 'pending';
    const [attempt] = await tx
      .insert(paymentAttempts)
      .values({
        orderId: order.id,
        attemptNumber: i + 1,
        provider: s.provider,
        externalId:
          s.provider === 'cod' ? null : `seed-${s.provider}-${String(n)}-${String(i + 1)}`,
        state: attemptState(outcome),
        status: attemptStatus(outcome),
        amount: total,
        capturedAmount: outcome === 'paid' ? total : 0,
        failureReason: outcome === 'failed' ? 'insufficient_funds' : null,
        completedAt: terminal ? at(s.daysAgo, i) : null,
        createdAt: at(s.daysAgo, i),
      })
      .returning({ id: paymentAttempts.id });
    if (attempt === undefined) throw new Error('спроба оплати не створилась');
    currentAttempt = attempt.id;
  }
  await tx
    .update(orders)
    .set({ currentPaymentAttemptId: currentAttempt })
    .where(eq(orders.id, order.id));

  await seedReservations(tx, s, order.id, lines);

  await tx.insert(orderStatusHistory).values([
    ...path.map((to, i) => ({
      orderId: order.id,
      fromStatus: i === 0 ? null : (path[i - 1] ?? null),
      toStatus: to,
      field: 'status',
      source: 'seed',
      createdAt: at(s.daysAgo, i * 6),
    })),
    ...(s.payment === 'pending'
      ? []
      : [
          {
            orderId: order.id,
            fromStatus: 'pending',
            toStatus: s.payment,
            field: 'payment_status',
            source: `seed:${s.provider}`,
            createdAt: at(s.daysAgo, 1),
          },
        ]),
  ]);

  if (promo !== undefined) {
    await tx.insert(promoCodeRedemptions).values({
      promoCodeId: promo.id,
      orderId: order.id,
      customerId: customer?.id ?? null,
      discountAmount: discountTotal,
      state: s.status === 'cancelled' ? 'released' : 'consumed',
    });
  }

  if (s.returns !== undefined) {
    await seedReturn(tx, s, order.id, customer?.id ?? null, currentAttempt, items, total);
  }

  if (customer === undefined) return [];
  return lines.map((l) => ({
    orderId: order.id,
    customerId: customer.id,
    productId: l.variant.productId,
    sizeLabel: l.variant.sizeLabel,
    delivered: s.status === 'delivered' || s.status === 'returned',
  }));
}

/**
 * Резерви за ADR-18. Активні (`ttl`, `held`) збільшують reserved_quantity
 * АТОМАРНИМ умовним UPDATE (ADR-3) — той самий патерн, що в core.
 */
async function seedReservations(
  tx: Tx,
  s: Scenario,
  orderId: string,
  lines: Line[],
): Promise<void> {
  const active = s.reservation === 'ttl' || s.reservation === 'held';
  for (const l of lines) {
    await tx.insert(stockReservations).values({
      variantId: l.variant.id,
      orderId,
      quantity: l.quantity,
      expiresAt: s.reservation === 'ttl' ? (RESERVATION_TTL[s.provider] ?? null) : null,
      releasedAt: active ? null : at(s.daysAgo, 6),
      releaseReason: active ? null : s.reservation,
      createdAt: at(s.daysAgo),
    });
    if (!active) continue;
    const updated = await tx
      .update(productVariants)
      .set({ reservedQuantity: sql`${productVariants.reservedQuantity} + ${l.quantity}` })
      .where(
        sql`${productVariants.id} = ${l.variant.id}
            AND ${productVariants.stockQuantity} - ${productVariants.reservedQuantity} >= ${l.quantity}`,
      )
      .returning({ id: productVariants.id });
    if (updated.length !== 1) throw new Error(`немає залишку для резерву ${l.variant.sku}`);
  }
}

async function seedReturn(
  tx: Tx,
  s: Scenario,
  orderId: string,
  customerId: string | null,
  attemptId: string,
  items: { id: string; lineTotal: number; quantity: number }[],
  total: number,
): Promise<void> {
  const ret = s.returns;
  if (ret === undefined) return;
  const chosen = ret.scope === 'full' ? items : items.slice(0, 1);
  const received = ret.status !== 'requested';
  const refund = ret.scope === 'full' ? total : chosen.reduce((sum, i) => sum + i.lineTotal, 0);

  const [request] = await tx
    .insert(returnRequests)
    .values({
      requestNumber: sql`next_return_number()`,
      orderId,
      customerId,
      status: ret.status,
      reason: ret.scope === 'full' ? 'changed_mind' : 'wrong_size',
      policyVersion: 'v1',
      customerComment: ret.scope === 'full' ? 'Не підійшов фасон.' : 'Замалий розмір.',
      refundAmount: received ? refund : null,
      restock: received,
      resolvedAt: received ? at(s.daysAgo - 3) : null,
      createdAt: at(s.daysAgo - 2),
    })
    .returning({ id: returnRequests.id });
  if (request === undefined) throw new Error('запит на повернення не створився');

  await tx.insert(returnRequestItems).values(
    chosen.map((i) => ({
      returnRequestId: request.id,
      orderItemId: i.id,
      orderId,
      quantity: i.quantity,
      receivedQuantity: received ? i.quantity : 0,
      restockedQuantity: received ? i.quantity : 0,
    })),
  );

  if (!received) return;
  await tx.insert(refundOperations).values({
    orderId,
    paymentAttemptId: attemptId,
    returnRequestId: request.id,
    amount: refund,
    state: 'succeeded',
    reason: 'return',
    settledAt: at(s.daysAgo - 3),
    createdAt: at(s.daysAgo - 3),
  });
  await tx.update(orders).set({ refundedTotal: refund }).where(eq(orders.id, orderId));
}
