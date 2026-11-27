import { describe, expect, it } from 'vitest';

import { percentChangeBps, ratioBps, formatBps, moneyFromDb, money } from '@store/shared/money';

import {
  daysInRange,
  lastYearPeriod,
  parsePeriod,
  previousPeriod,
  ReportInputError,
} from './period.ts';

describe('parsePeriod', () => {
  it('accepts a real range and defaults the granularity to day', () => {
    expect(parsePeriod({ from: '2026-06-01', to: '2026-06-30' })).toEqual({
      from: '2026-06-01',
      to: '2026-06-30',
      granularity: 'day',
    });
  });
  it.each([
    [{ from: '2026-02-30', to: '2026-03-01' }, 'bad_day'],
    [{ from: '2026-06-02', to: '2026-06-01' }, 'inverted'],
    [{ from: '1999-12-31', to: '2000-01-02' }, 'bad_day'],
    [{ from: '2026-1-1', to: '2026-01-02' }, 'bad_day'],
    [{ from: '2026-06-01', to: '2026-06-02', extra: 1 }, 'bad_day'],
    [{ from: '2020-01-01', to: '2026-06-02', granularity: 'month' }, 'too_long'],
    [{ from: '2025-01-01', to: '2026-06-02', granularity: 'day' }, 'too_many_points'],
    [{ from: '2026-06-01', to: '2026-06-02', granularity: 'hour' }, 'bad_day'],
    [null, 'bad_day'],
  ] as const)('refuses %j as %s', (input, reason) => {
    expect(() => parsePeriod(input)).toThrow(ReportInputError);
    try {
      parsePeriod(input);
    } catch (error) {
      expect(error).toMatchObject({ reason });
    }
  });
});

describe('period arithmetic', () => {
  it('counts days inclusively, across a leap day', () => {
    expect(daysInRange('2026-06-01', '2026-06-01')).toBe(1);
    expect(daysInRange('2028-02-28', '2028-03-01')).toBe(3);
  });
  it('the previous period ends the day before and has the same length', () => {
    expect(previousPeriod({ from: '2026-08-01', to: '2026-08-31' })).toEqual({
      from: '2026-07-01',
      to: '2026-07-31',
    });
    expect(previousPeriod({ from: '2026-01-01', to: '2026-01-01' })).toEqual({
      from: '2025-12-31',
      to: '2025-12-31',
    });
  });
  it('last year keeps the dates and clamps 29 February', () => {
    expect(lastYearPeriod({ from: '2026-08-01', to: '2026-08-31' })).toEqual({
      from: '2025-08-01',
      to: '2025-08-31',
    });
    expect(lastYearPeriod({ from: '2028-02-29', to: '2028-03-01' })).toEqual({
      from: '2027-02-28',
      to: '2027-03-01',
    });
  });
});

describe('percentages without a float', () => {
  it('percentChangeBps: relative to the previous, half away from zero, null for a zero base', () => {
    expect(percentChangeBps(money(10_000), money(30_000))).toBe(20_000);
    expect(percentChangeBps(money(40_000), money(30_000))).toBe(-2_500);
    expect(percentChangeBps(money(1_000), money(0))).toBe(-10_000);
    expect(percentChangeBps(money(0), money(500))).toBeNull();
    expect(percentChangeBps(money(0), money(0))).toBeNull();
    // 1/3 = 33.33 %: 3333 bps; 2/3 = 66.67 %: 6667 bps
    expect(percentChangeBps(money(3), money(4))).toBe(3_333);
    expect(percentChangeBps(money(3), money(5))).toBe(6_667);
    expect(percentChangeBps(money(-3), money(-4))).toBe(-3_333);
  });
  it('ratioBps and formatBps', () => {
    expect(ratioBps(1, 3)).toBe(3_333);
    expect(ratioBps(5, 0)).toBeNull();
    expect(formatBps(1_234, 'uk')).toBe('12,3 %');
    expect(formatBps(-2_500, 'en')).toBe('-25.0%');
    expect(formatBps(1, 'uk')).toBe('0,0 %');
  });
  it('moneyFromDb refuses what a float would corrupt', () => {
    expect(moneyFromDb('4000000000')).toBe(4_000_000_000);
    expect(moneyFromDb(null)).toBe(0);
    expect(() => moneyFromDb('9007199254740993')).toThrow(RangeError);
    expect(() => moneyFromDb('12.5')).toThrow(RangeError);
  });
});
