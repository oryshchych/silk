/**
 * Customers for the admin (phase 5), derived from orders. The identity is the lower-cased email
 * of the order (guest checkout), and the URL key is a SHA-256 of it: an address never appears in a
 * path or a log line. Definitions, all in one place:
 *
 *  - orders count: orders that are not cancelled;
 *  - LTV: the total of orders that are not cancelled, returned or still pending, minus what was
 *    refunded on them (money the shop kept or is committed to; owner queue Q48);
 *  - segment: `vip` (LTV at or above the threshold), else `lapsed` (last order over 180 days ago),
 *    else `repeat` (two or more orders), else `new`;
 *  - favourite sizes: the size bought in most units, per size system, from the order snapshots.
 *
 * Search, the filters and the page are bound parameters; a LIKE wildcard in a term is literal.
 */
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { Reader } from '@store/db/types';
import {
  adminCustomerDto,
  adminCustomerRowDto,
  type AdminCustomerDto,
  type AdminCustomerRowDto,
  type customerSegmentValues,
} from '@store/shared/dto/admin-customer';

import { queryRows } from '../catalog/sql.ts';
import type { AdminPage } from '../catalog-admin/read.ts';

export const CUSTOMERS_PAGE_SIZE = 50;
/** LTV at or above which a customer is `vip`, in kopiykas (a placeholder until the owner decides, Q48). */
export const VIP_LTV = 1_000_000;
export const LAPSED_DAYS = 180;
const MAX_PAGE = 10_000;
const MAX_QUERY = 100;

export interface CustomerFilters {
  q?: string | undefined;
  segment?: (typeof customerSegmentValues)[number] | undefined;
  tag?: string | undefined;
  page?: number | undefined;
}

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/** The key of an email: the first 32 hex characters of the SHA-256 of its lower-cased form. */
export const keyOfEmail = sql`left(encode(sha256(convert_to(lower(o.customer_email), 'UTF8')), 'hex'), 32)`;

const aggregates = sql`
  SELECT ${keyOfEmail} AS key,
         lower(o.customer_email) AS email,
         (array_agg(o.customer_name ORDER BY o.created_at DESC, o.id DESC))[1] AS name,
         (array_agg(o.customer_phone ORDER BY o.created_at DESC, o.id DESC))[1] AS phone,
         (count(*) FILTER (WHERE o.status <> 'cancelled'))::int AS orders_count,
         coalesce(sum(o.total - o.refunded_total)
                  FILTER (WHERE o.status NOT IN ('cancelled', 'returned', 'pending')), 0)::int AS ltv,
         max(o.created_at) AS last_order_at,
         min(o.created_at) AS first_order_at
    FROM orders o
   GROUP BY 1, 2`;

const segmentOf = sql`CASE
    WHEN a.ltv >= ${VIP_LTV} THEN 'vip'
    WHEN a.last_order_at < now() - make_interval(days => ${LAPSED_DAYS}) THEN 'lapsed'
    WHEN a.orders_count >= 2 THEN 'repeat'
    ELSE 'new' END`;

const rowSchema = z.object({
  key: z.string(),
  email: z.string(),
  name: z.string(),
  phone: z.string(),
  orders_count: z.number(),
  ltv: z.number(),
  last_order_at: z.coerce.date(),
  first_order_at: z.coerce.date(),
  segment: z.string(),
  tags: z.array(z.string()).nullable(),
  note: z.string().nullable(),
  total: z.coerce.number().optional(),
});

function toRow(row: z.output<typeof rowSchema>): AdminCustomerRowDto {
  return adminCustomerRowDto.parse({
    key: row.key,
    email: row.email,
    name: row.name,
    phone: row.phone,
    ordersCount: row.orders_count,
    ltv: row.ltv,
    lastOrderAt: row.last_order_at.toISOString(),
    segment: row.segment,
    tags: row.tags ?? [],
  });
}

function searchCondition(term: string): SQL | undefined {
  if (term === '') return undefined;
  const like = escapeLike(term.toLowerCase());
  const digits = term.replace(/[\s()+\-.]/g, '');
  const phone = /^\d{4,}$/.test(digits) ? sql` OR a.phone LIKE ${`%${escapeLike(digits)}`}` : sql``;
  return sql`(a.email LIKE ${`${like}%`} OR lower(a.name) LIKE ${`%${like}%`}${phone})`;
}

function whereOf(filters: CustomerFilters): SQL {
  const term = (filters.q ?? '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, MAX_QUERY);
  const parts = [
    searchCondition(term),
    filters.segment === undefined ? undefined : sql`(${segmentOf}) = ${filters.segment}`,
    filters.tag === undefined ? undefined : sql`c.tags @> ARRAY[${filters.tag}]::text[]`,
  ].filter((part): part is SQL => part !== undefined);
  return parts.length === 0 ? sql`true` : sql.join(parts, sql` AND `);
}

export async function listCustomers(
  db: Reader,
  filters: CustomerFilters,
): Promise<AdminPage<AdminCustomerRowDto>> {
  const requested = filters.page ?? 1;
  const page = Number.isFinite(requested)
    ? Math.max(1, Math.min(Math.trunc(requested), MAX_PAGE))
    : 1;
  const rows = await queryRows(
    db,
    rowSchema,
    sql`WITH a AS (${aggregates})
        SELECT a.key, a.email, a.name, a.phone, a.orders_count, a.ltv, a.last_order_at, a.first_order_at,
               (${segmentOf}) AS segment, c.tags, c.admin_note AS note,
               count(*) OVER () AS total
          FROM a LEFT JOIN customers c ON lower(c.email) = a.email
         WHERE ${whereOf(filters)}
         ORDER BY a.ltv DESC, a.last_order_at DESC, a.key
         LIMIT ${CUSTOMERS_PAGE_SIZE} OFFSET ${(page - 1) * CUSTOMERS_PAGE_SIZE}`,
  );
  const total = rows[0]?.total ?? 0;
  return {
    items: rows.map(toRow),
    page,
    limit: CUSTOMERS_PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / CUSTOMERS_PAGE_SIZE)),
  };
}

const sizeRow = z.object({ system: z.string(), label: z.string(), units: z.number() });
const orderRow = z.object({
  id: z.string(),
  order_number: z.string(),
  created_at: z.coerce.date(),
  status: z.string(),
  total: z.number(),
});

/** One customer by URL key, or null. */
export async function getCustomer(db: Reader, key: string): Promise<AdminCustomerDto | null> {
  if (!/^[0-9a-f]{32}$/.test(key)) return null;
  const found = await queryRows(
    db,
    rowSchema,
    sql`WITH a AS (${aggregates})
        SELECT a.key, a.email, a.name, a.phone, a.orders_count, a.ltv, a.last_order_at, a.first_order_at,
               (${segmentOf}) AS segment, c.tags, c.admin_note AS note
          FROM a LEFT JOIN customers c ON lower(c.email) = a.email
         WHERE a.key = ${key}`,
  );
  const customer = found[0];
  if (customer === undefined) return null;
  const [sizes, orderRows] = await Promise.all([
    queryRows(
      db,
      sizeRow,
      sql`SELECT coalesce(i.size_system_snapshot, 'unknown') AS system, i.size_label AS label,
                 sum(i.quantity)::int AS units
            FROM order_items i JOIN orders o ON o.id = i.order_id
           WHERE lower(o.customer_email) = ${customer.email}
             AND o.status NOT IN ('cancelled', 'returned')
           GROUP BY 1, 2
           ORDER BY 1, 3 DESC, 2`,
    ),
    queryRows(
      db,
      orderRow,
      sql`SELECT o.id::text AS id, o.order_number, o.created_at, o.status::text AS status, o.total
            FROM orders o WHERE lower(o.customer_email) = ${customer.email}
           ORDER BY o.created_at DESC, o.id DESC LIMIT 100`,
    ),
  ]);
  // Rows come ordered by system then units descending: the first of each system is the favourite.
  const favourites = new Map<string, string>();
  for (const size of sizes)
    if (!favourites.has(size.system)) favourites.set(size.system, size.label);
  return adminCustomerDto.parse({
    ...toRow(customer),
    firstOrderAt: customer.first_order_at.toISOString(),
    averageOrder:
      customer.orders_count === 0
        ? 0
        : Math.round(customer.ltv / Math.max(1, customer.orders_count)),
    note: customer.note,
    sizes,
    favouriteSizes: [...favourites].map(([system, label]) => ({ system, label })),
    orders: orderRows.map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      createdAt: row.created_at.toISOString(),
      status: row.status,
      total: row.total,
    })),
  });
}

/** The lower-cased email behind a URL key (for the writes that need it), or null. */
export async function emailOfKey(db: Reader, key: string): Promise<string | null> {
  if (!/^[0-9a-f]{32}$/.test(key)) return null;
  const rows = await queryRows(
    db,
    z.object({ email: z.string() }),
    sql`SELECT lower(o.customer_email) AS email FROM orders o WHERE ${keyOfEmail} = ${key} LIMIT 1`,
  );
  return rows[0]?.email ?? null;
}

/** Everything the export needs, in a stable order: by email, after a cursor. */
export async function customersForExport(
  db: Reader,
  options: { after?: string | undefined; limit: number },
) {
  return await queryRows(
    db,
    rowSchema,
    sql`WITH a AS (${aggregates})
        SELECT a.key, a.email, a.name, a.phone, a.orders_count, a.ltv, a.last_order_at, a.first_order_at,
               (${segmentOf}) AS segment, c.tags, c.admin_note AS note
          FROM a LEFT JOIN customers c ON lower(c.email) = a.email
         WHERE ${options.after === undefined ? sql`true` : sql`a.email > ${options.after.toLowerCase()}`}
         ORDER BY a.email
         LIMIT ${options.limit}`,
  );
}
