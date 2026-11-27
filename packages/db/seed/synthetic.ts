/**
 * A synthetic order history for performance checks of the reports (phase 10): N orders (default
 * 50 000) over 23 months with lines, payment attempts, refunds, returns, cancellations, promo
 * codes and customers, written with a handful of SET-BASED statements (a row at a time would take
 * minutes). Deterministic: every value is arithmetic on the row number, there is no random().
 *
 * Guards (the same as the demo seed): refused in production, refused on a non-local database
 * host, refused when the database already holds orders, and the whole thing is one transaction.
 *
 * Mix, by row number i (so the totals are predictable and a test can assert them):
 *  - i % 10 in (0, 1): cash on delivery (no payment attempt: nothing is captured)
 *  - i % 20 = 7: cancelled; one in two of those had been paid and is fully refunded
 *  - i % 10 = 3 (paid, not cancelled): a partial refund of a quarter of the total, settled 3 days later
 *  - i % 40 = 3: one line of a refunded order also comes back as a received return, 10 days later
 *  - i % 25 = 0: the first line has no cost snapshot
 *  - i % 4 = 0: the order carries a promo code and a line discount; shipping paid by the sender
 *  - the orders belong to 5 000 customers, the first buy of each customer is its lowest row number
 */
import { count, sql } from 'drizzle-orm';

import { orders } from '../src/schema.ts';
import type { Tx } from '../src/types.ts';

export interface SyntheticOptions {
  orders: number;
  /** Distinct products the lines draw from. */
  products?: number;
}

export const SYNTHETIC_DEFAULT_ORDERS = 50_000;

export interface SyntheticSummary {
  orders: number;
  lines: number;
  attempts: number;
  refunds: number;
  returns: number;
}

export async function seedSynthetic(tx: Tx, options: SyntheticOptions): Promise<SyntheticSummary> {
  const n = Math.trunc(options.orders);
  if (!Number.isSafeInteger(n) || n < 1 || n > 1_000_000) {
    throw new Error('synthetic orders must be a whole number from 1 to 1 000 000');
  }
  const pool = Math.max(1, Math.trunc(options.products ?? 200));
  const [existing] = await tx.select({ n: count() }).from(orders);
  if (existing !== undefined && existing.n > 0) {
    throw new Error(
      `the database already holds ${String(existing.n)} orders: the synthetic seed needs none`,
    );
  }
  await tx.execute(sql`
    CREATE TEMP TABLE syn ON COMMIT DROP AS
    SELECT i,
           uuidv7() AS id,
           timestamptz '2025-01-01 00:00:00+02'
             + ((i::bigint * 7919 % 700)::int) * interval '1 day' + ((i::bigint * 104729 % 86400)::int) * interval '1 second' AS created_at,
           (i % 10 IN (0, 1)) AS is_cod,
           (i % 20 = 7) AS is_cancelled,
           ((i % 20 = 7 AND i % 40 = 7) OR (i % 20 <> 7 AND i % 10 NOT IN (0, 1))) AS is_paid,
           (i % 4 = 0) AS has_promo,
           ((i * 31) % ${pool}) AS p1,
           ((i * 57 + 11) % ${pool}) AS p2,
           (1 + i % 3) AS q1,
           (1 + (i / 3) % 2) AS q2
      FROM generate_series(1, ${n}) AS i
  `);
  await tx.execute(sql`
    CREATE TEMP TABLE syn_calc ON COMMIT DROP AS
    SELECT s.*,
           (30000 + (p1 % 50) * 1500) AS price1, (20000 + (p2 % 40) * 2000) AS price2,
           CASE WHEN has_promo THEN 5000 ELSE 0 END AS disc1,
           CASE WHEN has_promo THEN 8000 ELSE 0 END AS ship
      FROM syn s
  `);
  await tx.execute(sql`
    CREATE TEMP TABLE syn_tot ON COMMIT DROP AS
    SELECT c.*, (price1 * q1 + price2 * q2) AS subtotal,
           (price1 * q1 + price2 * q2 - disc1 + ship) AS total
      FROM syn_calc c
  `);
  await tx.execute(sql`
    INSERT INTO orders (id, order_number, status, payment_status, payment_provider, customer_id, customer_email,
                        customer_phone, customer_name, delivery_method, subtotal, discount_total, shipping_total,
                        total, captured_total, refunded_total, shipping_cost_actual, shipping_paid_by, promo_code,
                        paid_at, cancelled_at, created_at)
    SELECT t.id, 'LS-SYN-' || lpad(t.i::text, 8, '0'),
           CASE WHEN is_cancelled THEN 'cancelled'::order_status ELSE 'delivered'::order_status END,
           CASE WHEN NOT is_paid THEN 'pending'::payment_status
                WHEN is_cancelled THEN 'refunded'::payment_status
                WHEN i % 10 = 3 THEN 'partially_refunded'::payment_status
                ELSE 'paid'::payment_status END,
           (CASE WHEN is_cod THEN 'cod' WHEN i % 10 = 2 THEN 'bank_transfer'
                 WHEN i % 10 IN (3, 4, 5) THEN 'wayforpay' ELSE 'mono' END)::payment_provider,
           NULL,
           'syn-' || (t.i % 5000) || '@example.com', '+380501112233', 'Synthetic Buyer',
           CASE WHEN i % 3 = 0 THEN 'np_courier' WHEN i % 3 = 1 THEN 'np_warehouse' ELSE 'pickup' END::delivery_method,
           subtotal, disc1, ship, total,
           CASE WHEN is_paid THEN total ELSE 0 END,
           CASE WHEN is_paid AND is_cancelled THEN total
                WHEN is_paid AND i % 10 = 3 THEN total / 4 ELSE 0 END,
           CASE WHEN has_promo THEN 6500 ELSE NULL END,
           CASE WHEN has_promo THEN 'sender' ELSE 'recipient' END,
           CASE WHEN has_promo THEN 'SYN' || (i % 5) ELSE NULL END,
           CASE WHEN is_paid THEN created_at + interval '5 minutes' ELSE NULL END,
           CASE WHEN is_cancelled THEN created_at + interval '1 hour' ELSE NULL END,
           created_at
      FROM syn_tot t
  `);
  // The promo report reads redemptions (the record written with the order), so the orders that carry a code get one.
  await tx.execute(sql`
    INSERT INTO promo_codes (code, type, value)
    SELECT 'SYN' || g, 'fixed', 5000 FROM generate_series(0, 4) g`);
  await tx.execute(sql`
    INSERT INTO promo_code_redemptions (promo_code_id, order_id, discount_amount, state)
    SELECT pc.id, t.id, t.disc1, 'consumed'
      FROM syn_tot t JOIN promo_codes pc ON pc.code = 'SYN' || (t.i % 5)
     WHERE t.has_promo`);
  await tx.execute(sql`
    INSERT INTO order_items (order_id, product_uid_snapshot, variant_uid_snapshot, name_snapshot, sku_snapshot,
                             size_label, color_name, category_path_snapshot, unit_price, line_discount,
                             unit_cost_snapshot, quantity, line_total)
    SELECT t.id, ('00000000-0000-4000-8000-' || lpad(t.p1::text, 12, '0'))::uuid,
           ('10000000-0000-4000-8000-' || lpad(t.p1::text, 12, '0'))::uuid,
           'Product ' || t.p1, 'SYN-' || t.p1, 'M', 'Black', 'Category ' || (t.p1 % 8),
           t.price1, t.disc1, CASE WHEN t.i % 25 = 0 THEN NULL ELSE t.price1 * 45 / 100 END, t.q1,
           t.price1 * t.q1 - t.disc1
      FROM syn_tot t
    UNION ALL
    SELECT t.id, ('00000000-0000-4000-8000-' || lpad(t.p2::text, 12, '0'))::uuid,
           ('10000000-0000-4000-8000-' || lpad(t.p2::text, 12, '0'))::uuid,
           'Product ' || t.p2, 'SYN-' || t.p2, 'L', 'White', 'Category ' || (t.p2 % 8),
           t.price2, 0, t.price2 * 50 / 100, t.q2, t.price2 * t.q2
      FROM syn_tot t
  `);
  await tx.execute(sql`
    INSERT INTO payment_attempts (order_id, attempt_number, provider, state, status, amount, captured_amount,
                                  completed_at, created_at)
    SELECT t.id, 1,
           (CASE WHEN i % 10 = 2 THEN 'bank_transfer' WHEN i % 10 IN (3, 4, 5) THEN 'wayforpay' ELSE 'mono' END)::payment_provider,
           'succeeded', 'paid', total, total, created_at + interval '5 minutes', created_at
      FROM syn_tot t
     WHERE is_paid AND NOT is_cod
  `);
  await tx.execute(sql`
    INSERT INTO refund_operations (order_id, payment_attempt_id, amount, state, settled_at, created_at)
    SELECT t.id, a.id,
           CASE WHEN t.is_cancelled THEN t.total ELSE t.total / 4 END,
           'succeeded', t.created_at + CASE WHEN t.is_cancelled THEN interval '2 hours' ELSE interval '3 days' END,
           t.created_at + interval '1 hour'
      FROM syn_tot t JOIN payment_attempts a ON a.order_id = t.id
     WHERE t.is_paid AND (t.is_cancelled OR t.i % 10 = 3)
  `);
  await tx.execute(sql`
    INSERT INTO return_requests (request_number, order_id, status, reason, policy_version, received_at, created_at)
    SELECT 'RT-SYN-' || lpad(t.i::text, 8, '0'), t.id, 'received',
           (CASE WHEN t.i % 3 = 0 THEN 'defect' WHEN t.i % 3 = 1 THEN 'wrong_size' ELSE 'changed_mind' END)::return_reason,
           'syn', t.created_at + interval '10 days', t.created_at + interval '6 days'
      FROM syn_tot t
     WHERE t.is_paid AND NOT t.is_cancelled AND t.i % 40 = 3
  `);
  await tx.execute(sql`
    INSERT INTO return_request_items (return_request_id, order_item_id, order_id, quantity, received_quantity,
                                      restocked_quantity)
    SELECT r.id, oi.id, r.order_id, 1, 1, CASE WHEN r.reason = 'defect' THEN 0 ELSE 1 END
      FROM return_requests r
      JOIN LATERAL (SELECT id FROM order_items WHERE order_id = r.order_id ORDER BY id LIMIT 1) oi ON true
     WHERE r.policy_version = 'syn'
  `);
  const [summary] = (
    await tx.execute<{ lines: string; attempts: string; refunds: string; returns: string }>(sql`
      SELECT (SELECT count(*) FROM order_items)::text AS lines,
             (SELECT count(*) FROM payment_attempts)::text AS attempts,
             (SELECT count(*) FROM refund_operations)::text AS refunds,
             (SELECT count(*) FROM return_requests)::text AS returns
    `)
  ).rows;
  if (summary === undefined) throw new Error('synthetic seed: no summary');
  return {
    orders: n,
    lines: Number(summary.lines),
    attempts: Number(summary.attempts),
    refunds: Number(summary.refunds),
    returns: Number(summary.returns),
  };
}
