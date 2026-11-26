/**
 * CSV for the catalog import and export. Small, strict and bounded:
 *
 *  - parse: RFC 4180 (quoted cells, doubled quotes, CRLF or LF, a BOM), the delimiter is `,` or
 *    `;` (Excel with a Ukrainian locale writes `;`), and hard caps on size, rows, columns and cell
 *    length, so a hostile file cannot make the server read or hold more than a known amount;
 *  - write: a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed
 *    with an apostrophe, so a product name like `=HYPERLINK(...)` is text when the file is opened
 *    in a spreadsheet (CSV injection), and every cell is quoted when it needs to be.
 */
export const CSV_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  maxRows: 1_000,
  maxColumns: 30,
  maxCell: 20_000,
} as const;

export class CsvError extends Error {
  readonly reason:
    | 'too_large'
    | 'too_many_rows'
    | 'too_many_columns'
    | 'cell_too_long'
    | 'unterminated_quote'
    | 'empty'
    | 'invalid_characters'
    | 'duplicate_header';

  constructor(reason: CsvError['reason']) {
    super(`csv rejected: ${reason}`);
    this.name = 'CsvError';
    this.reason = reason;
  }
}

export interface ParsedCsv {
  header: string[];
  /** Data rows with their 1-based line number in the file (the header is line 1). */
  rows: { line: number; cells: string[] }[];
}

function detectDelimiter(firstLine: string): ',' | ';' {
  let inQuotes = false;
  let commas = 0;
  let semicolons = 0;
  for (const char of firstLine) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char === ',') commas += 1;
    else if (!inQuotes && char === ';') semicolons += 1;
  }
  return semicolons > commas ? ';' : ',';
}

export function parseCsv(input: string): ParsedCsv {
  if (input.length > CSV_LIMITS.maxBytes) throw new CsvError('too_large');
  // A NUL byte would make Postgres refuse a whole batch (22021); U+FFFD means the file was not valid UTF-8.
  if (input.includes('\u0000') || input.includes('\uFFFD'))
    throw new CsvError('invalid_characters');
  const text = input.startsWith('﻿') ? input.slice(1) : input;
  const delimiter = detectDelimiter(text.split(/\r?\n/, 1)[0] ?? '');
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let touched = false;

  const endCell = (): void => {
    if (cell.length > CSV_LIMITS.maxCell) throw new CsvError('cell_too_long');
    cells.push(cell);
    if (cells.length > CSV_LIMITS.maxColumns) throw new CsvError('too_many_columns');
    cell = '';
  };
  const endRecord = (): void => {
    endCell();
    // A completely blank line is skipped.
    if (!(cells.length === 1 && cells[0] === '' && !touched))
      records.push({ line: recordLine, cells });
    if (records.length > CSV_LIMITS.maxRows + 1) throw new CsvError('too_many_rows');
    cells = [];
    touched = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inQuotes = false;
      } else {
        if (char === '\n') line += 1;
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell === '') {
      inQuotes = true;
      touched = true;
    } else if (char === delimiter) {
      touched = true;
      endCell();
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      recordLine = line;
    } else {
      touched = true;
      cell += char;
    }
  }
  if (inQuotes) throw new CsvError('unterminated_quote');
  if (cell !== '' || cells.length > 0 || touched) endRecord();

  const [head, ...rest] = records;
  if (head === undefined) throw new CsvError('empty');
  const header = head.cells.map((name) => name.trim().toLowerCase());
  if (
    new Set(header.filter((name) => name !== '')).size !==
    header.filter((name) => name !== '').length
  ) {
    throw new CsvError('duplicate_header');
  }
  return { header, rows: rest };
}

/**
 * A cell a spreadsheet would run as a formula starts (after optional blanks) with `=`, `+`, `-` or
 * `@`, or with a tab or a carriage return.
 */
const FORMULA_START = /^[\t\r ]*[=+\-@]|^[\t\r]/;
/**
 * Cells this shop builds from numbers are plain data, not formulas: a money amount from
 * `toHryvniasText` (`-5.00`, `1299.50`) and a canonical phone (`+380501112233`). They are left
 * alone so an accountant's sums work and a phone shows without an apostrophe; anything else that
 * starts with one of the formula characters (`-cmd`, `+1+1`, `-5.00x`) is still neutralised.
 */
const PLAIN_MONEY = /^-?\d+\.\d{2}$/;
const PLAIN_PHONE = /^\+\d{7,15}$/;

/** The reverse of `safeCell`, for a file this shop exported: the leading apostrophe of a neutralised cell is dropped. */
export function unsafeCell(value: string): string {
  return /^'(?:[\t\r ]*[=+\-@]|[\t\r])/.test(value) ? value.slice(1) : value;
}

/** A cell that a spreadsheet would run as a formula is made text by a leading apostrophe. */
export function safeCell(value: string): string {
  if (PLAIN_MONEY.test(value) || PLAIN_PHONE.test(value)) return value;
  return FORMULA_START.test(value) ? `'${value}` : value;
}

function quote(value: string): string {
  return /[",;\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function writeCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header, ...rows.map((row) => row.map(safeCell))].map((cells) =>
    cells.map(quote).join(','),
  );
  // A BOM so Excel opens UTF-8 (Ukrainian) correctly.
  return `﻿${lines.join('\r\n')}\r\n`;
}
