import { describe, expect, it } from 'vitest';

import { CSV_LIMITS, CsvError, parseCsv, safeCell, writeCsv } from './csv.ts';

describe('parseCsv', () => {
  it('reads quoted cells, doubled quotes, newlines inside quotes, CRLF and a BOM', () => {
    const parsed = parseCsv('﻿SKU,Name\r\nA1,"Lace ""Bra"", black"\r\nA2,"two\nlines"\r\n');
    expect(parsed.header).toEqual(['sku', 'name']);
    expect(parsed.rows).toEqual([
      { line: 2, cells: ['A1', 'Lace "Bra", black'] },
      { line: 3, cells: ['A2', 'two\nlines'] },
    ]);
  });

  it('numbers lines as the file does, including lines inside quoted cells', () => {
    const parsed = parseCsv('a,b\n1,"x\ny"\n2,z\n');
    expect(parsed.rows.map((row) => row.line)).toEqual([2, 4]);
  });

  it('detects a semicolon delimiter (Excel with a Ukrainian locale) and skips blank lines', () => {
    const parsed = parseCsv('sku;name\n\nA1;Бра\n');
    expect(parsed.header).toEqual(['sku', 'name']);
    expect(parsed.rows).toEqual([{ line: 3, cells: ['A1', 'Бра'] }]);
  });

  it('keeps empty cells and a last row without a trailing newline', () => {
    expect(parseCsv('a,b,c\n1,,3').rows).toEqual([{ line: 2, cells: ['1', '', '3'] }]);
  });

  it('refuses what is too big or malformed, with a reason', () => {
    const reason = (input: string): string => {
      try {
        parseCsv(input);
        return 'accepted';
      } catch (error) {
        return error instanceof CsvError ? error.reason : 'other';
      }
    };
    expect(reason('a\n' + 'x\n'.repeat(CSV_LIMITS.maxRows + 2))).toBe('too_many_rows');
    expect(
      reason(
        Array.from({ length: CSV_LIMITS.maxColumns + 1 }, (_, i) => `c${String(i)}`).join(','),
      ),
    ).toBe('too_many_columns');
    expect(reason(`a\n${'x'.repeat(CSV_LIMITS.maxCell + 1)}`)).toBe('cell_too_long');
    expect(reason('a\n"never closed')).toBe('unterminated_quote');
    expect(reason('x'.repeat(CSV_LIMITS.maxBytes + 1))).toBe('too_large');
    expect(reason('')).toBe('empty');
  });
});

describe('writeCsv', () => {
  it('neutralises formulas: a cell starting with = + - @ tab or CR is text', () => {
    for (const value of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx']) {
      expect(safeCell(value), value).toBe(`'${value}`);
    }
    expect(safeCell('Lace bra')).toBe('Lace bra');
    expect(safeCell('12.50')).toBe('12.50');
  });

  it('quotes what needs it, starts with a BOM and round-trips through parseCsv', () => {
    const csv = writeCsv(
      ['sku', 'name'],
      [
        ['A1', 'Lace "Bra", black'],
        ['A2', '=HYPERLINK("http://evil.example")'],
      ],
    );
    expect(csv.startsWith('﻿')).toBe(true);
    const parsed = parseCsv(csv);
    expect(parsed.rows[0]?.cells).toEqual(['A1', 'Lace "Bra", black']);
    expect(parsed.rows[1]?.cells[1]?.startsWith("'=")).toBe(true);
  });
});
