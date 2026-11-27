/**
 * The period of a report: an inclusive range of SHOP days (Europe/Kyiv), validated by zod, and the
 * SQL that turns it into instants. The boundaries are decided by the DATABASE (`AT TIME ZONE`
 * knows the daylight-saving rules and the clock of the app server is never consulted), so a payment
 * captured at 23:59 Kyiv time belongs to that day on a UTC server too.
 */
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { granularityValues, type Granularity } from '@store/shared/dto/reports';

export const SHOP_TIMEZONE = 'Europe/Kyiv';
/** About three years: a longer range is a spreadsheet job, not a screen. */
export const MAX_PERIOD_DAYS = 1100;
/** A day-by-day series longer than this is refused (too many points to read or draw). */
export const MAX_DAILY_DAYS = 366;

/** Nothing in this shop is older: a guard against year 0000 and the date arithmetic below. */
const MIN_DAY = '2000-01-01';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day: `2026-02-30` matches the pattern and is not one. */
export function isRealDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Whole days between two real days, inclusive of both ends (`from === to` is one day). */
export function daysInRange(from: string, to: string): number {
  const ms = new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

export class ReportInputError extends Error {
  readonly reason: 'bad_day' | 'inverted' | 'too_long' | 'too_many_points';
  constructor(reason: ReportInputError['reason']) {
    super(`invalid report period: ${reason}`);
    this.name = 'ReportInputError';
    this.reason = reason;
  }
}

/** The raw input of every report: two days and a granularity. Unknown keys are refused. */
export const periodInputSchema = z.strictObject({
  from: z.string().max(10),
  to: z.string().max(10),
  granularity: z.enum(granularityValues).default('day'),
});
export type PeriodInput = z.input<typeof periodInputSchema>;
export interface Period {
  from: string;
  to: string;
  granularity: Granularity;
}

/** Validate and normalise; throws `ReportInputError` (a 400, never a 500) on anything out of range. */
export function parsePeriod(input: unknown, options: { series?: boolean } = {}): Period {
  const parsed = periodInputSchema.safeParse(input);
  if (!parsed.success) throw new ReportInputError('bad_day');
  const { from, to, granularity } = parsed.data;
  if (!isRealDay(from) || !isRealDay(to)) throw new ReportInputError('bad_day');
  if (from < MIN_DAY) throw new ReportInputError('bad_day');
  if (from > to) throw new ReportInputError('inverted');
  const days = daysInRange(from, to);
  if (days > MAX_PERIOD_DAYS) throw new ReportInputError('too_long');
  // The point cap protects a SERIES (a chart of one point per day); a report without one has no points.
  if (options.series !== false && granularity === 'day' && days > MAX_DAILY_DAYS) {
    throw new ReportInputError('too_many_points');
  }
  return { from, to, granularity };
}

/** A whitelisted literal, never user text: the granularity enum maps to these two strings only. */
export const TRUNC: Record<Granularity, SQL> = {
  day: sql.raw(`'day'`),
  week: sql.raw(`'week'`),
  month: sql.raw(`'month'`),
};
export const STEP: Record<Granularity, SQL> = {
  day: sql.raw(`interval '1 day'`),
  week: sql.raw(`interval '1 week'`),
  month: sql.raw(`interval '1 month'`),
};
const TZ = sql.raw(`'${SHOP_TIMEZONE}'`);

/** First instant of the first shop day. */
export const lowerBound = (from: string): SQL =>
  sql`((${from}::date)::timestamp AT TIME ZONE ${TZ})`;
/** First instant AFTER the last shop day (exclusive upper bound). */
export const upperBound = (to: string): SQL =>
  sql`(((${to}::date + 1))::timestamp AT TIME ZONE ${TZ})`;
/** The shop-local calendar day of an instant column. */
export const shopDay = (column: SQL | string): SQL =>
  typeof column === 'string'
    ? sql`((${sql.raw(column)} AT TIME ZONE ${TZ})::date)`
    : sql`((${column} AT TIME ZONE ${TZ})::date)`;

/** The previous period of the same length: ends the day before `from`. Pure date arithmetic on real days. */
export function previousPeriod(period: Pick<Period, 'from' | 'to'>): { from: string; to: string } {
  const days = daysInRange(period.from, period.to);
  const end = new Date(`${period.from}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

/** The same calendar dates one year earlier; 29 February becomes 28 February. */
export function lastYearPeriod(period: Pick<Period, 'from' | 'to'>): { from: string; to: string } {
  const shift = (day: string): string => {
    const [y = '0', m = '0', d = '0'] = day.split('-');
    const year = Number(y) - 1;
    const month = Number(m);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const dayOfMonth = Math.min(Number(d), lastDay);
    return `${String(year).padStart(4, '0')}-${m}-${String(dayOfMonth).padStart(2, '0')}`;
  };
  return { from: shift(period.from), to: shift(period.to) };
}

/** An instant as ISO 8601 UTC text, decided by the database (never the session time zone). */
export const isoUtc = (expression: SQL): SQL =>
  sql`to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** A real day moved by whole days (pure date arithmetic on `YYYY-MM-DD`). */
export function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
