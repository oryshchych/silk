/**
 * Promo-code reads: the list (filters, sorting, pages in SQL) and the statistics of one code. Every
 * statistic is COUNTED from `promo_code_redemptions` in state `consumed`, never read from the stored
 * `uses_count`, so the screen cannot drift from the truth (and `promo:reconcile` can compare the two).
 * Reads run in the read-only report transaction: a slow filter is cancelled, never holds the pool.
 */
import { sql, type SQL } from 'drizzle-orm';

import {
  adminPromoRowDto,
  adminPromoRowWithAuthorDto,
  adminPromoStatsDto,
  type AdminPromoRowDto,
  type AdminPromoRowWithAuthorDto,
  type AdminPromoStatsDto,
  type promoScopeValues,
  type promoStatusValues,
  type promoTypeValues,
} from '@store/shared/dto/admin-promo';
import { serialize } from '@store/shared/dto/serialize';

import type { AdminPage } from '../catalog-admin/read.ts';
import { inReportTransaction, type ReportDb } from '../reports/transaction.ts';

export const PROMO_PAGE_SIZE = 50;
export const PROMO_SORT_KEYS = ['code', 'uses', 'revenue', 'created', 'ends'] as const;
const MAX_QUERY = 100;
const MAX_PAGE = 10_000;
const PAGE_STATEMENT_TIMEOUT_MS = 5_000;

export interface PromoFilters {
  q?: string | undefined;
  status?: (typeof promoStatusValues)[number] | undefined;
  type?: (typeof promoTypeValues)[number] | undefined;
  scope?: (typeof promoScopeValues)[number] | undefined;
  /** `YYYY-MM-DD`, Kyiv days, inclusive. */
  createdFrom?: string | undefined;
  createdTo?: string | undefined;
  hasUses?: boolean | undefined;
  sort?: (typeof PROMO_SORT_KEYS)[number] | undefined;
  dir?: 'asc' | 'desc' | undefined;
  page?: number | undefined;
}

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);
const isRealDay = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/** The status, decided by Postgres' clock. A switched-off code is "inactive" whatever its dates say. */
const STATUS_SQL = sql`CASE
  WHEN NOT p.is_active THEN 'inactive'
  WHEN p.max_uses IS NOT NULL AND p.uses_count >= p.max_uses THEN 'exhausted'
  WHEN p.ends_at IS NOT NULL AND p.ends_at <= now() THEN 'ended'
  WHEN p.starts_at IS NOT NULL AND p.starts_at > now() THEN 'upcoming'
  ELSE 'active' END`;

/** Constants only: the sort key is looked up here, never interpolated from the request. */
const SORT_SQL: Record<(typeof PROMO_SORT_KEYS)[number], string> = {
  code: 'upper(p.code)',
  uses: 'consumed',
  revenue: 'captured',
  created: 'p.created_at',
  ends: 'p.ends_at',
};

const STATS_JOIN = sql`LEFT JOIN (
  SELECT r.promo_code_id,
         count(*)::int AS consumed,
         coalesce(sum(r.discount_amount), 0)::text AS discount,
         coalesce(sum(o.captured_total), 0)::text AS captured
    FROM promo_code_redemptions r JOIN orders o ON o.id = r.order_id
   WHERE r.state = 'consumed'
   GROUP BY r.promo_code_id) s ON s.promo_code_id = p.id`;

function conditions(filters: PromoFilters, term: string): SQL[] {
  const parts: SQL[] = [];
  if (term !== '') {
    const like = `%${escapeLike(term)}%`;
    parts.push(sql`(p.code ILIKE ${like} OR coalesce(p.description, '') ILIKE ${like})`);
  }
  if (filters.status !== undefined) parts.push(sql`(${STATUS_SQL}) = ${filters.status}`);
  if (filters.type !== undefined) parts.push(sql`p.type = ${filters.type}`);
  if (filters.scope !== undefined) parts.push(sql`p.scope = ${filters.scope}`);
  if (filters.createdFrom !== undefined && isRealDay(filters.createdFrom)) {
    parts.push(
      sql`p.created_at >= ((${filters.createdFrom}::date)::timestamp AT TIME ZONE 'Europe/Kyiv')`,
    );
  }
  if (filters.createdTo !== undefined && isRealDay(filters.createdTo)) {
    parts.push(
      sql`p.created_at < (((${filters.createdTo}::date + 1)::timestamp) AT TIME ZONE 'Europe/Kyiv')`,
    );
  }
  if (filters.hasUses === true) {
    parts.push(
      sql`EXISTS (SELECT 1 FROM promo_code_redemptions x WHERE x.promo_code_id = p.id AND x.state = 'consumed')`,
    );
  }
  return parts;
}

const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? new Date(value).toISOString() : null;
};

interface ListRow extends Record<string, unknown> {
  id: string;
  created_by: string | null;
}

function toDto(row: ListRow, withAuthor: boolean): AdminPromoRowDto | AdminPromoRowWithAuthorDto {
  const shape = {
    id: row.id,
    code: row['code'],
    description: row['description'],
    type: row['type'],
    value: row['value'],
    maxDiscountAmount: row['max_discount_amount'],
    minOrderTotal: row['min_order_total'],
    maxUses: row['max_uses'],
    usesCount: row['uses_count'],
    perCustomerLimit: row['per_customer_limit'],
    scope: row['scope'],
    scopeCategoryId: row['scope_category_id'],
    scopeProductId: row['scope_product_id'],
    stackable: row['stackable'],
    excludesDiscountedItems: row['excludes_discounted_items'],
    firstOrderOnly: row['first_order_only'],
    excludesGiftCards: row['excludes_gift_cards'],
    startsAt: iso(row['starts_at']),
    endsAt: iso(row['ends_at']),
    isActive: row['is_active'],
    status: row['status'],
    createdAt: iso(row['created_at']),
    consumedCount: row['consumed'],
    discountTotal: Number(row['discount']),
    capturedTotal: Number(row['captured']),
    hasRedemptions: row['has_redemptions'],
  };
  return withAuthor
    ? serialize(adminPromoRowWithAuthorDto, { ...shape, createdBy: row.created_by })
    : serialize(adminPromoRowDto, shape);
}

/**
 * One page of codes. `withAuthor` is the caller's `promo.manage`: the author's e-mail is selected and
 * serialised only then (a manager's shape has no such key).
 */
export async function listPromoCodes(
  db: ReportDb,
  filters: PromoFilters,
  withAuthor: boolean,
  pageSize = PROMO_PAGE_SIZE,
): Promise<AdminPage<AdminPromoRowDto | AdminPromoRowWithAuthorDto>> {
  const requested = filters.page ?? 1;
  const page = Number.isFinite(requested)
    ? Math.max(1, Math.min(Math.trunc(requested), MAX_PAGE))
    : 1;
  const term = (filters.q ?? '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, MAX_QUERY);
  const where = conditions(filters, term);
  const whereSql = where.length === 0 ? sql`` : sql`WHERE ${sql.join(where, sql` AND `)}`;
  const direction = filters.dir === 'asc' ? sql`ASC` : sql`DESC`;
  const sortKey = filters.sort ?? 'created';
  const order = sql`${sql.raw(SORT_SQL[sortKey])} ${direction} NULLS LAST, p.id`;
  const offset = (page - 1) * pageSize;

  return await inReportTransaction(
    db,
    async (tx) => {
      const counted = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM promo_codes p ${STATS_JOIN} ${whereSql}`,
      );
      const total = counted.rows[0]?.n ?? 0;
      const rows = await tx.execute<ListRow>(
        sql`SELECT p.*, ${STATUS_SQL} AS status,
                   coalesce(s.consumed, 0) AS consumed,
                   coalesce(s.discount, '0') AS discount,
                   coalesce(s.captured, '0') AS captured,
                   EXISTS (SELECT 1 FROM promo_code_redemptions h WHERE h.promo_code_id = p.id) AS has_redemptions,
                   u.email AS created_by
              FROM promo_codes p ${STATS_JOIN}
              LEFT JOIN auth_users u ON u.id = p.created_by_user_id
              ${whereSql}
             ORDER BY ${order}
             LIMIT ${pageSize} OFFSET ${offset}`,
      );
      return {
        items: rows.rows.map((row) => toDto(row, withAuthor)),
        page,
        limit: pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      };
    },
    { statementTimeoutMs: PAGE_STATEMENT_TIMEOUT_MS },
  );
}

/** One code for the edit form, in the same shape as a list row. */
export async function getPromoCode(
  db: ReportDb,
  id: string,
  withAuthor: boolean,
): Promise<AdminPromoRowDto | AdminPromoRowWithAuthorDto | null> {
  return await inReportTransaction(
    db,
    async (tx) => {
      const rows = await tx.execute<ListRow>(
        sql`SELECT p.*, ${STATUS_SQL} AS status,
                   coalesce(s.consumed, 0) AS consumed,
                   coalesce(s.discount, '0') AS discount,
                   coalesce(s.captured, '0') AS captured,
                   EXISTS (SELECT 1 FROM promo_code_redemptions h WHERE h.promo_code_id = p.id) AS has_redemptions,
                   u.email AS created_by
              FROM promo_codes p ${STATS_JOIN}
              LEFT JOIN auth_users u ON u.id = p.created_by_user_id
             WHERE p.id = ${id}::uuid`,
      );
      const row = rows.rows[0];
      return row === undefined ? null : toDto(row, withAuthor);
    },
    { statementTimeoutMs: PAGE_STATEMENT_TIMEOUT_MS },
  );
}

const STATS_ORDER_LIMIT = 100;

/** What one code did: uses over time, the money, new customers and the orders behind it. */
export async function readPromoStats(db: ReportDb, id: string): Promise<AdminPromoStatsDto | null> {
  return await inReportTransaction(
    db,
    async (tx) => {
      const exists = await tx.execute<{ id: string }>(
        sql`SELECT id FROM promo_codes WHERE id = ${id}::uuid`,
      );
      if (exists.rows.length === 0) return null;
      const totals = await tx.execute<Record<string, string | number | null>>(
        sql`SELECT count(*) FILTER (WHERE r.state = 'consumed')::int AS consumed,
                   count(*) FILTER (WHERE r.state = 'released')::int AS released,
                   coalesce(sum(r.discount_amount) FILTER (WHERE r.state = 'consumed'), 0)::text AS discount,
                   coalesce(sum(o.captured_total) FILTER (WHERE r.state = 'consumed'), 0)::text AS captured,
                   round(avg(o.captured_total) FILTER (WHERE r.state = 'consumed' AND o.captured_total > 0))::text AS avg_with,
                   count(DISTINCT lower(o.customer_email)) FILTER (
                     WHERE r.state = 'consumed' AND NOT EXISTS (
                       SELECT 1 FROM orders earlier
                        WHERE lower(earlier.customer_email) = lower(o.customer_email)
                          AND earlier.created_at < o.created_at))::int AS new_customers
              FROM promo_code_redemptions r JOIN orders o ON o.id = r.order_id
             WHERE r.promo_code_id = ${id}::uuid`,
      );
      const without = await tx.execute<{ avg_without: string | null }>(
        sql`SELECT round(avg(o.captured_total))::text AS avg_without
              FROM orders o
             WHERE o.captured_total > 0 AND NOT EXISTS (
               SELECT 1 FROM promo_code_redemptions r
                WHERE r.order_id = o.id AND r.promo_code_id = ${id}::uuid AND r.state = 'consumed')`,
      );
      const days = await tx.execute<{ day: string; uses: number }>(
        sql`SELECT to_char(r.created_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS day, count(*)::int AS uses
              FROM promo_code_redemptions r
             WHERE r.promo_code_id = ${id}::uuid AND r.state = 'consumed'
             GROUP BY 1 ORDER BY 1`,
      );
      const orders = await tx.execute(
        sql`SELECT o.id, o.order_number, o.created_at, r.discount_amount, o.captured_total
              FROM promo_code_redemptions r JOIN orders o ON o.id = r.order_id
             WHERE r.promo_code_id = ${id}::uuid AND r.state = 'consumed'
             ORDER BY o.created_at DESC, o.id LIMIT ${STATS_ORDER_LIMIT}`,
      );
      const t = totals.rows[0] ?? {};
      const optionalAmount = (value: unknown): number | null =>
        value === null || value === undefined ? null : Number(value);
      return serialize(adminPromoStatsDto, {
        consumedCount: t['consumed'] ?? 0,
        releasedCount: t['released'] ?? 0,
        discountTotal: Number(t['discount'] ?? 0),
        capturedTotal: Number(t['captured'] ?? 0),
        averageOrderWithCode: optionalAmount(t['avg_with']),
        averageOrderWithout: optionalAmount(without.rows[0]?.avg_without),
        newCustomers: t['new_customers'] ?? 0,
        byDay: days.rows,
        orders: orders.rows.map((row) => ({
          id: row['id'],
          orderNumber: row['order_number'],
          createdAt: iso(row['created_at']),
          discountAmount: row['discount_amount'],
          capturedTotal: row['captured_total'],
        })),
      });
    },
    { statementTimeoutMs: PAGE_STATEMENT_TIMEOUT_MS },
  );
}

/** The categories a code can be scoped to, for the form's picker (names in both languages). */
export async function listPromoScopeCategories(
  db: ReportDb,
): Promise<{ id: string; nameUk: string; nameEn: string }[]> {
  return await inReportTransaction(
    db,
    async (tx) => {
      const rows = await tx.execute<{ id: string; name_uk: string; name_en: string }>(
        sql`SELECT id, name_uk, name_en FROM categories ORDER BY name_uk, id LIMIT 500`,
      );
      return rows.rows.map((row) => ({ id: row.id, nameUk: row.name_uk, nameEn: row.name_en }));
    },
    { statementTimeoutMs: PAGE_STATEMENT_TIMEOUT_MS },
  );
}
