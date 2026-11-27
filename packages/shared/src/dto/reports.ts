/**
 * Report shapes (phase 10). Every shape is an explicit list of fields and every amount is an
 * integer count of kopiykas (`Money`), never a float and never a formatted string: the screen and
 * the CSV format them with ONE function (`formatMoney` / `toHryvniasText`).
 *
 * Cost visibility (AGENTS.md section 2 and docs/SECURITY.md): the cost figures live ONLY in the
 * `*WithCost` shapes. A role without `catalog.cost.view` is never handed one, so the margin
 * columns are absent from its JSON, its RSC payload, its CSV and its chart data, not merely hidden
 * by the UI. A test walks every serialised shape of every role and looks for the field names in
 * `COST_FIELD_NAMES`.
 */
import type { Money } from '../money.ts';

/** Every field name that carries a cost or something derived from one. */
export const COST_FIELD_NAMES = [
  'cost',
  'costPrice',
  'unitCost',
  'unitCostSnapshot',
  'shippingCost',
  'shippingCostActual',
  'margin',
  'marginBps',
  'marginPerUnit',
  'noCostLines',
  'noCostRevenue',
  'noShippingCostOrders',
  'otherRefunds',
  'stockValueAtCost',
  'costOfGoods',
  'goodsRevenue',
] as const;

export const granularityValues = ['day', 'week', 'month'] as const;
export type Granularity = (typeof granularityValues)[number];

/** One inclusive range of shop days (Europe/Kyiv): `from` and `to` are `YYYY-MM-DD`. */
export interface PeriodDto {
  from: string;
  to: string;
  /** The same range expressed as UTC instants, decided by the database (the first is inclusive, the second exclusive). */
  startsAt: string;
  endsAt: string;
}

/** When the numbers were read: the database clock, never the app clock. */
export interface AsOfDto {
  /** ISO instant. Direct queries: the moment of the read. */
  asOf: string;
}

export interface RevenuePointDto {
  /** Bucket start, `YYYY-MM-DD` (a Monday for weeks, the first day for months). */
  bucket: string;
  /** Money that came in (`payment_attempts.captured_amount`, by capture time). */
  gross: Money;
  /** Refunds that SETTLED (`refund_operations`, state `succeeded`, by settle time). */
  refunds: Money;
  /** `gross - refunds` of the bucket: can be negative (a refund of an earlier period). */
  net: Money;
}

export interface RevenueTotalsDto {
  gross: Money;
  refunds: Money;
  net: Money;
  /** Captures counted (attempts), refunds counted (operations). */
  captures: number;
  refundOperations: number;
  /**
   * Data-quality counters: money rows with NO time (a capture without `completed_at`, a succeeded
   * refund without `settled_at`). They belong to no period and are in none of the figures above.
   * Both must be zero; the screen warns when one is not.
   */
  untimedCaptures: number;
  untimedRefunds: number;
}

export interface RevenueReportDto extends AsOfDto {
  period: PeriodDto;
  granularity: Granularity;
  series: RevenuePointDto[];
  totals: RevenueTotalsDto;
}

/** A change between two periods: the absolute change always, the percentage only when it means something. */
export interface ChangeDto {
  previous: Money;
  current: Money;
  absolute: Money;
  /**
   * Percent change in basis points (1 % = 100), rounded half away from zero, or `null` when the
   * previous value is zero (a percentage of nothing is not a number). Never a float.
   */
  percentBps: number | null;
}

export interface ComparisonDto {
  /** The previous period of the same length, ending the day before `from`. */
  previous: PeriodDto;
  /** The same dates one year earlier, or `null` when there is no data that old. */
  lastYear: PeriodDto | null;
  gross: { vsPrevious: ChangeDto; vsLastYear: ChangeDto | null };
  refunds: { vsPrevious: ChangeDto; vsLastYear: ChangeDto | null };
  net: { vsPrevious: ChangeDto; vsLastYear: ChangeDto | null };
}

/** Margin figures. Only inside `*WithCost` shapes. */
export interface MarginFiguresDto {
  /** Goods revenue of lines that HAVE a cost snapshot (sales minus received returns and cancelled orders). */
  goodsRevenue: Money;
  costOfGoods: Money;
  /** Carrier cost paid by the seller (`shipping_paid_by = 'sender'` only). */
  shippingCost: Money;
  /** `goodsRevenue - costOfGoods - shippingCost`. */
  margin: Money;
  /** `margin / goodsRevenue` in basis points; `null` when there is no revenue. */
  marginBps: number | null;
  /** Lines sold in the period without a cost snapshot: excluded from the figures above, never treated as zero cost. */
  noCostLines: number;
  noCostRevenue: Money;
  /** Seller-paid orders whose carrier cost is not recorded yet: their shipping is left out. */
  noShippingCostOrders: number;
  /** Refunds settled in the period that are tied to neither a received return nor a cancelled order. */
  otherRefunds: Money;
}

export interface MarginReportDto extends AsOfDto {
  period: PeriodDto;
  totals: MarginFiguresDto;
}
