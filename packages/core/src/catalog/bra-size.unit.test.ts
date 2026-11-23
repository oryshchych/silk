import { describe, expect, it } from 'vitest';

import { calculateBraSize, CUP_TABLE } from './bra-size';

const size = (underbust: number, bust: number) => {
  const result = calculateBraSize(underbust, bust);
  return result.ok ? result.label : result.reason;
};

describe('calculateBraSize: band', () => {
  it('rounds the underbust to the nearest multiple of 5 and switches at 72/73', () => {
    expect(size(68, 82)).toBe('70B');
    expect(size(72, 86)).toBe('70B');
    expect(size(73, 87)).toBe('75B');
    expect(size(77, 91)).toBe('75B');
    expect(size(78, 92)).toBe('80B');
  });

  it('rounds fractional measurements to whole centimetres, halves up', () => {
    expect(size(72.4, 86.4)).toBe('70B');
    expect(size(72.5, 86.5)).toBe('75B');
  });

  it('accepts the whole supported band range and rejects outside it', () => {
    expect(size(58, 72)).toBe('60B');
    expect(size(112, 126)).toBe('110B');
    expect(size(57, 71)).toBe('underbust_out_of_range');
    expect(size(113, 127)).toBe('underbust_out_of_range');
  });
});

describe('calculateBraSize: cup', () => {
  it('matches the correspondence table at both edges of every row', () => {
    const underbust = 75;
    CUP_TABLE.forEach((row, index) => {
      const next = CUP_TABLE[index + 1];
      const upper = next === undefined ? row.from + 1 : next.from - 1;
      expect(size(underbust, underbust + row.from)).toBe(`75${row.cup}`);
      expect(size(underbust, underbust + upper)).toBe(`75${row.cup}`);
    });
  });

  it('rejects a difference below the first and above the last row', () => {
    expect(size(75, 84)).toBe('cup_out_of_range');
    expect(size(75, 75 + 28)).toBe('cup_out_of_range');
  });

  it('gives the worked examples of a real fitting', () => {
    expect(size(80, 94)).toBe('80B');
    expect(size(86, 104)).toBe('85D');
    expect(size(66, 78)).toBe('65A');
  });
});

describe('calculateBraSize: invalid input', () => {
  it('rejects non-finite and non-positive measurements', () => {
    expect(size(Number.NaN, 90)).toBe('invalid_input');
    expect(size(75, Number.POSITIVE_INFINITY)).toBe('invalid_input');
    expect(size(0, 90)).toBe('invalid_input');
    expect(size(-5, 90)).toBe('invalid_input');
  });

  it('treats a bust smaller than the underbust as out of range, not as a size', () => {
    expect(size(80, 70)).toBe('cup_out_of_range');
  });
});
