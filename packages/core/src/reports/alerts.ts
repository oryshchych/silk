/**
 * The alerts block of the dashboard: what needs a person right now. One read-only statement, the
 * database clock, counts and the age of the oldest row only (no order number, name or address leaves),
 * so the same block is safe for every role that may read reports. Thresholds are constants here and
 * stated in `docs/REPORTS.md`.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader } from '@store/db/types';
import { alertCodes, type AlertDto } from '@store/shared/dto/reports';

import { isoUtc } from './period.ts';

/** An outbox row unpublished this long means the relay is not delivering. */
export const OUTBOX_STUCK_MINUTES = 15;
/** A refund still unsent or unconfirmed this long needs a person (the sweep only alerts on unknown). */
export const REFUND_OPEN_MINUTES = 10;
/** A reservation that lapses within this window is about to release its stock. */
export const RESERVATION_WINDOW_MINUTES = 15;
export const WAYBILL_OPEN_MINUTES = 10;
export const LOW_STOCK_AVAILABLE = 3;

const rowSchema = z.object({
  code: z.enum(alertCodes),
  n: z.coerce.number(),
  oldest: z.string().nullable(),
});

export async function readAlerts(db: Reader): Promise<AlertDto[]> {
  const part = (code: string, count: ReturnType<typeof sql>, oldest: ReturnType<typeof sql>) =>
    sql`SELECT ${code}::text AS code, (${count})::text AS n, ${isoUtc(sql`(${oldest})`)} AS oldest`;
  const result = await db.execute(sql`
    ${part(
      'outbox_stuck',
      sql`SELECT count(*) FROM outbox WHERE published_at IS NULL AND created_at < now() - ${OUTBOX_STUCK_MINUTES} * interval '1 minute'`,
      sql`SELECT min(created_at) FROM outbox WHERE published_at IS NULL AND created_at < now() - ${OUTBOX_STUCK_MINUTES} * interval '1 minute'`,
    )}
    UNION ALL ${part(
      'refund_open',
      sql`SELECT count(*) FROM refund_operations WHERE state IN ('pending', 'in_flight', 'unknown') AND created_at < now() - ${REFUND_OPEN_MINUTES} * interval '1 minute'`,
      sql`SELECT min(created_at) FROM refund_operations WHERE state IN ('pending', 'in_flight', 'unknown') AND created_at < now() - ${REFUND_OPEN_MINUTES} * interval '1 minute'`,
    )}
    UNION ALL ${part(
      'payment_unknown',
      sql`SELECT count(*) FROM payment_attempts WHERE state = 'unknown'`,
      sql`SELECT min(created_at) FROM payment_attempts WHERE state = 'unknown'`,
    )}
    UNION ALL ${part(
      'reservation_expiring',
      sql`SELECT count(*) FROM stock_reservations WHERE released_at IS NULL AND expires_at IS NOT NULL AND expires_at >= now() AND expires_at < now() + ${RESERVATION_WINDOW_MINUTES} * interval '1 minute'`,
      sql`SELECT min(expires_at) FROM stock_reservations WHERE released_at IS NULL AND expires_at IS NOT NULL AND expires_at >= now() AND expires_at < now() + ${RESERVATION_WINDOW_MINUTES} * interval '1 minute'`,
    )}
    UNION ALL ${part(
      'low_stock',
      sql`SELECT count(*) FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.is_active AND p.is_active AND p.kind = 'physical' AND v.stock_quantity - v.reserved_quantity <= ${LOW_STOCK_AVAILABLE}`,
      sql`SELECT NULL::timestamptz`,
    )}
    UNION ALL ${part(
      'fiscal_failed',
      sql`SELECT count(*) FROM orders WHERE fiscal_status = 'failed'`,
      sql`SELECT min(created_at) FROM orders WHERE fiscal_status = 'failed'`,
    )}
    UNION ALL ${part(
      'waybill_unknown',
      sql`SELECT count(*) FROM shipment_operations WHERE state = 'unknown' OR (state IN ('pending', 'in_flight') AND created_at < now() - ${WAYBILL_OPEN_MINUTES} * interval '1 minute')`,
      sql`SELECT min(created_at) FROM shipment_operations WHERE state = 'unknown' OR (state IN ('pending', 'in_flight') AND created_at < now() - ${WAYBILL_OPEN_MINUTES} * interval '1 minute')`,
    )}
  `);
  const byCode = new Map(
    result.rows.map((row) => [rowSchema.parse(row).code, rowSchema.parse(row)]),
  );
  return alertCodes.map((code) => ({
    code,
    count: byCode.get(code)?.n ?? 0,
    oldestAt: byCode.get(code)?.oldest ?? null,
  }));
}
