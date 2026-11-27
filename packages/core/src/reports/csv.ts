/**
 * The CSV rendering of a report result. The screen renders the same `ReportResultDto` with the
 * locale formatter; the file renders it with plain decimals (`1299.00`, `12.34` for a percentage),
 * integer arithmetic only, so a test can parse every cell back to the kopiyka and compare it to
 * the screen's value. Formula cells are neutralised by the shared `writeCsv`; a plain negative
 * amount stays a number. The first cell of the totals row is `TOTAL`; facts follow as `#fact` rows;
 * a result cut at its cap ends with a truncation line.
 */
import type { ReportCell, ReportColumnDto, ReportResultDto } from '@store/shared/dto/reports';
import { money, toHryvniasText } from '@store/shared/money';

import { writeCsv } from '../catalog-admin/csv.ts';

/** `1234` basis points -> `"12.34"`, `-5` -> `"-0.05"`: integer arithmetic. */
export function bpsPlainText(bps: number): string {
  const abs = Math.abs(bps);
  const text = `${String(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
  return bps < 0 ? `-${text}` : text;
}

export function cellText(kind: ReportColumnDto['kind'], cell: ReportCell): string {
  if (cell === null) return '';
  if (typeof cell === 'string') return cell;
  if (kind === 'money') return toHryvniasText(money(cell));
  if (kind === 'bps') return bpsPlainText(cell);
  return String(cell);
}

export const TRUNCATION_LINE =
  '# truncated: only the first rows are listed and the TOTAL row covers every row';

export function resultToCsv(result: ReportResultDto): string {
  const { columns, rows, totals, truncated } = result.table;
  const header = columns.map((c) => (c.kind === 'bps' ? `${c.key}_percent` : c.key));
  const body = rows.map((row) => row.map((cell, i) => cellText(columns[i]?.kind ?? 'text', cell)));
  if (totals !== null) {
    body.push(
      totals.map((cell, i) => {
        const text = cellText(columns[i]?.kind ?? 'text', cell);
        return i === 0 && text === '' ? 'TOTAL' : text;
      }),
    );
  }
  for (const fact of result.facts) {
    body.push(['#fact', fact.key, cellText(fact.kind, fact.value)]);
  }
  if (truncated) body.push([TRUNCATION_LINE]);
  return writeCsv(header, body);
}
