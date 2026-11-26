/**
 * Admin order reads: the list (filters, search, pages) and the card. Every value that leaves goes
 * through `@store/shared/dto/admin-order`, so the cost keys exist only for a role that may see
 * them and the raw payment payloads, the access token hash, the IP and the user agent never
 * leave, even though the rows carry them.
 */
import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';

import {
  authUsers,
  orderItems,
  orderStatusHistory,
  orders,
  paymentAttempts,
  paymentEvents,
  refundOperations,
} from '@store/db/schema';
import type { Reader } from '@store/db/types';
import {
  adminOrderRowDto,
  serializeAdminOrder,
  type AdminOrderDto,
  type AdminOrderRowDto,
  type AdminOrderWithCostDto,
  type deliveryMethodValues,
  type paymentProviderValues,
} from '@store/shared/dto/admin-order';
import type { orderStatusValues, paymentStatusValues } from '@store/shared/dto/order';

type OrderStatus = (typeof orderStatusValues)[number];

import type { AdminPage } from '../catalog-admin/read.ts';

export const ORDERS_PAGE_SIZE = 50;
const MAX_QUERY = 100;
const MAX_PAGE = 10_000;

export interface AdminOrderFilters {
  q?: string | undefined;
  status?: OrderStatus | undefined;
  paymentStatus?: (typeof paymentStatusValues)[number] | undefined;
  paymentProvider?: (typeof paymentProviderValues)[number] | undefined;
  deliveryMethod?: (typeof deliveryMethodValues)[number] | undefined;
  /** `YYYY-MM-DD`, inclusive, Kyiv calendar days. */
  from?: string | undefined;
  to?: string | undefined;
  page?: number | undefined;
}

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day: `2026-02-30` and `2026-13-45` have the right shape and are not days. */
const isRealDay = (value: string): boolean => {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/**
 * What a search term can mean, decided by its shape: an order number (`LS-2026-000123`, whole or
 * the start of one), an email (has an `@`), a waybill or phone (digits), or a name. Each shape
 * gets the cheapest honest match; a term can match several (digits are a phone ending OR the start
 * of a waybill), never everything.
 */
function searchCondition(term: string): SQL | undefined {
  if (term === '') return undefined;
  const upper = term.toUpperCase();
  if (/^[A-Z]{2}-\d{0,4}(-\d{0,6})?$/.test(upper)) {
    return ilike(orders.orderNumber, `${escapeLike(upper)}%`);
  }
  if (term.includes('@')) {
    return sql`lower(${orders.customerEmail}) LIKE ${`${escapeLike(term.toLowerCase())}%`}`;
  }
  const digits = term.replace(/[\s()+\-.]/g, '');
  if (/^\d{4,}$/.test(digits)) {
    return or(
      sql`${orders.customerPhone} LIKE ${`%${escapeLike(digits)}`}`,
      sql`${orders.ttn} LIKE ${`${escapeLike(digits)}%`}`,
    );
  }
  return or(
    ilike(orders.customerName, `%${escapeLike(term)}%`),
    ilike(orders.orderNumber, `%${escapeLike(upper)}%`),
  );
}

export async function listAdminOrders(
  db: Reader,
  filters: AdminOrderFilters,
): Promise<AdminPage<AdminOrderRowDto>> {
  const requested = filters.page ?? 1;
  const page = Number.isFinite(requested)
    ? Math.max(1, Math.min(Math.trunc(requested), MAX_PAGE))
    : 1;
  // A NUL byte would make Postgres refuse the query (22021): it cannot be part of a term.
  const term = (filters.q ?? '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, MAX_QUERY);
  const day = (value: string | undefined): string | undefined =>
    value !== undefined && isRealDay(value) ? value : undefined;
  const from = day(filters.from);
  const to = day(filters.to);
  const where = and(
    searchCondition(term),
    filters.status === undefined ? undefined : eq(orders.status, filters.status),
    filters.paymentStatus === undefined
      ? undefined
      : eq(orders.paymentStatus, filters.paymentStatus),
    filters.paymentProvider === undefined
      ? undefined
      : eq(orders.paymentProvider, filters.paymentProvider),
    filters.deliveryMethod === undefined
      ? undefined
      : eq(orders.deliveryMethod, filters.deliveryMethod),
    // Calendar days are Kyiv days; the bounds are built by Postgres, not by the server's clock.
    from === undefined
      ? undefined
      : gte(orders.createdAt, sql`(${from}::date)::timestamp AT TIME ZONE 'Europe/Kyiv'`),
    to === undefined
      ? undefined
      : lt(orders.createdAt, sql`((${to}::date + 1)::timestamp) AT TIME ZONE 'Europe/Kyiv'`),
  );
  const [counted] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(where);
  const total = counted?.n ?? 0;
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      createdAt: orders.createdAt,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      paymentProvider: orders.paymentProvider,
      deliveryMethod: orders.deliveryMethod,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      customerEmail: orders.customerEmail,
      total: orders.total,
      ttn: orders.ttn,
    })
    .from(orders)
    .where(where)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(ORDERS_PAGE_SIZE)
    .offset((page - 1) * ORDERS_PAGE_SIZE);
  const counts = new Map<string, number>();
  if (rows.length > 0) {
    const sums = await db
      .select({ orderId: orderItems.orderId, n: sql<number>`sum(${orderItems.quantity})::int` })
      .from(orderItems)
      .where(
        inArray(
          orderItems.orderId,
          rows.map((row) => row.id),
        ),
      )
      .groupBy(orderItems.orderId);
    for (const sum of sums) counts.set(sum.orderId, sum.n);
  }
  return {
    items: rows.map((row) =>
      adminOrderRowDto.parse({
        ...row,
        createdAt: row.createdAt.toISOString(),
        itemCount: counts.get(row.id) ?? 0,
      }),
    ),
    page,
    limit: ORDERS_PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / ORDERS_PAGE_SIZE)),
  };
}

/** The buttons a state offers. The permission filter is the caller's; the action re-checks the state. */
export function availableActions(order: {
  status: OrderStatus;
  paymentStatus: string;
  paymentProvider: string | null;
}): ('confirm' | 'process' | 'ship' | 'deliver' | 'cancel')[] {
  const actions: ('confirm' | 'process' | 'ship' | 'deliver' | 'cancel')[] = [];
  const isCod = order.paymentProvider === 'cod';
  const open =
    order.status === 'pending' || order.status === 'confirmed' || order.status === 'processing';
  if (order.status === 'pending' && (isCod || order.paymentStatus === 'paid'))
    actions.push('confirm');
  if (order.status === 'confirmed') actions.push('process');
  // Ship comes after confirm: the steps are not skipped (shipOrder enforces it for the admin).
  if (open && order.status !== 'pending' && (isCod || order.paymentStatus === 'paid')) {
    actions.push('ship');
  }
  if (order.status === 'shipped') actions.push('deliver');
  if (open) actions.push('cancel');
  return actions;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export async function getAdminOrder(
  db: Reader,
  orderId: string,
  canSeeCost: boolean,
): Promise<AdminOrderDto | AdminOrderWithCostDto | null> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (order === undefined) return null;
  const [items, history, events, attempts, refunds] = await Promise.all([
    db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.id)),
    db
      .select({
        id: orderStatusHistory.id,
        field: orderStatusHistory.field,
        from: orderStatusHistory.fromStatus,
        to: orderStatusHistory.toStatus,
        source: orderStatusHistory.source,
        comment: orderStatusHistory.comment,
        byEmail: authUsers.email,
        at: orderStatusHistory.createdAt,
      })
      .from(orderStatusHistory)
      .leftJoin(authUsers, eq(authUsers.id, orderStatusHistory.changedByUserId))
      .where(eq(orderStatusHistory.orderId, orderId))
      .orderBy(desc(orderStatusHistory.createdAt), desc(orderStatusHistory.id)),
    db
      .select({
        id: paymentEvents.id,
        provider: paymentEvents.provider,
        eventType: paymentEvents.eventType,
        mappedStatus: paymentEvents.mappedStatus,
        amount: paymentEvents.amount,
        appliedAt: paymentEvents.appliedAt,
        at: paymentEvents.createdAt,
      })
      .from(paymentEvents)
      .where(eq(paymentEvents.orderId, orderId))
      .orderBy(desc(paymentEvents.createdAt), desc(paymentEvents.id)),
    db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.orderId, orderId))
      .orderBy(asc(paymentAttempts.attemptNumber)),
    db
      .select()
      .from(refundOperations)
      .where(eq(refundOperations.orderId, orderId))
      .orderBy(desc(refundOperations.createdAt)),
  ]);
  return serializeAdminOrder(
    {
      ...order,
      createdAt: order.createdAt.toISOString(),
      paidAt: iso(order.paidAt),
      shippedAt: iso(order.shippedAt),
      deliveredAt: iso(order.deliveredAt),
      cancelledAt: iso(order.cancelledAt),
      items: items.map((item) => ({
        id: item.id,
        variantId: item.variantId,
        name: item.nameSnapshot,
        sku: item.skuSnapshot,
        sizeLabel: item.sizeLabel,
        colorName: item.colorName,
        unitPrice: item.unitPrice,
        lineDiscount: item.lineDiscount,
        quantity: item.quantity,
        lineTotal: item.lineTotal,
        unitCostSnapshot: item.unitCostSnapshot,
      })),
      history: history.map((row) => ({ ...row, at: row.at.toISOString() })),
      paymentEvents: events.map((row) => ({
        ...row,
        applied: row.appliedAt !== null,
        at: row.at.toISOString(),
      })),
      attempts: attempts.map((row) => ({ ...row, at: row.createdAt.toISOString() })),
      refunds: refunds.map((row) => ({
        id: row.id,
        amount: row.amount,
        state: row.state,
        reason: row.reason,
        at: row.createdAt.toISOString(),
        settledAt: iso(row.settledAt),
      })),
      actions: availableActions(order),
    },
    canSeeCost,
  );
}
