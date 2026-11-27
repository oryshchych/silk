import type { ColumnKind, ReportCell } from '@store/shared/dto/reports';
import { formatBps, formatMoney, money, type MoneyLocale } from '@store/shared/money';

import type { Translate } from './message-lookup';

/**
 * One cell as the screen shows it: money through the shared locale formatter (the CSV uses plain
 * decimals from the same integers), percentages through `formatBps`, counts and text as they are.
 * The result is always a string for React to escape; nothing here produces markup.
 */
export function formatCell(kind: ColumnKind, cell: ReportCell, locale: MoneyLocale): string {
  if (cell === null) return '';
  if (typeof cell === 'string') return cell;
  if (kind === 'money') return formatMoney(money(cell), locale);
  if (kind === 'bps') return formatBps(cell, locale);
  if (kind === 'int')
    return new Intl.NumberFormat(locale === 'uk' ? 'uk-UA' : 'en-US').format(cell);
  return String(cell);
}

/** A translated name for an enum-like value (`np_warehouse`), or the raw text when there is none. */
export function valueLabel(t: Translate, raw: string): string {
  const text = t(`values.${raw}`);
  return text.endsWith(`values.${raw}`) ? raw : text;
}

/** Columns whose text cells are enum-like values worth translating. */
export const LABELLED_COLUMNS: ReadonlySet<string> = new Set([
  'dimension',
  'value',
  'provider',
  'reason',
  'kind',
]);
