import { describe, expect, it } from 'vitest';

import {
  add,
  allocate,
  assertFitsPgInteger,
  formatMoney,
  money,
  multiply,
  parseHryvnias,
  percentOf,
  subtract,
  sum,
  type Money,
} from './money';

const m = (values: number[]): Money[] => values.map(money);

describe('money', () => {
  it('приймає цілі копійки, включно з від’ємними', () => {
    expect(money(129900)).toBe(129900);
    expect(money(-500)).toBe(-500);
  });

  it.each([12.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('відкидає %s', (value) => {
    expect(() => money(value)).toThrow(RangeError);
  });
});

describe('арифметика', () => {
  it('add / subtract / sum', () => {
    expect(add(money(100), money(250))).toBe(350);
    expect(subtract(money(100), money(250))).toBe(-150);
    expect(sum(m([1, 2, 3]))).toBe(6);
    expect(sum([])).toBe(0);
  });

  it('multiply приймає лише цілу кількість', () => {
    expect(multiply(money(129900), 3)).toBe(389700);
    expect(() => multiply(money(100), 0.15)).toThrow(RangeError);
  });
});

describe('percentOf — округлення явне (ADR-1)', () => {
  it('15% від 19 999 = 2 999,85 копійки', () => {
    expect(percentOf(money(19999), 15, 'floor')).toBe(2999);
    expect(percentOf(money(19999), 15, 'half-up')).toBe(3000);
  });

  it('рівно половина округлюється вгору в half-up', () => {
    expect(percentOf(money(50), 1, 'half-up')).toBe(1); // 0,5 копійки
    expect(percentOf(money(49), 1, 'half-up')).toBe(0);
  });

  it('від’ємні суми симетричні', () => {
    expect(percentOf(money(-19999), 15, 'half-up')).toBe(-3000);
    expect(percentOf(money(-19999), 15, 'floor')).toBe(-3000);
  });

  it('межі', () => {
    expect(percentOf(money(12345), 0, 'floor')).toBe(0);
    expect(percentOf(money(12345), 100, 'floor')).toBe(12345);
    expect(() => percentOf(money(100), 101, 'floor')).toThrow(RangeError);
    expect(() => percentOf(money(100), 12.5, 'floor')).toThrow(RangeError);
  });
});

describe('allocate — largest remainder (ADR-15)', () => {
  it('контрприклад з ADR: 1000, 999, 998 і знижка 2996', () => {
    const shares = allocate(money(2996), m([1000, 999, 998]));
    expect(sum(shares)).toBe(2996);
    shares.forEach((share, i) => {
      expect(share).toBeLessThanOrEqual([1000, 999, 998][i] ?? 0);
    });
    // floor: 999, 998, 997 (=2994); дробові частини .6663 / .6667 / .6670 —
    // 2 копійки залишку йдуть третій і другій позиціям.
    expect(shares).toEqual([999, 999, 998]);
  });

  it('100 ₴ на три позиції по 200 ₴ сходиться до копійки', () => {
    const shares = allocate(money(10000), m([20000, 20000, 20000]));
    expect(sum(shares)).toBe(10000);
    expect(shares).toEqual([3334, 3333, 3333]);
  });

  it('детермінований: рівні залишки — за індексом', () => {
    expect(allocate(money(1), m([100, 100]))).toEqual([1, 0]);
    expect(allocate(money(1), m([100, 100]))).toEqual(allocate(money(1), m([100, 100])));
  });

  it('позиція з нульовою вагою нічого не отримує', () => {
    expect(allocate(money(500), m([1000, 0, 1000]))).toEqual([250, 0, 250]);
  });

  it('великі суми без втрати точності', () => {
    const shares = allocate(money(2_000_000_000), m([2_100_000_000, 7, 3]));
    expect(sum(shares)).toBe(2_000_000_000);
  });

  it('відкидає некоректні входи', () => {
    expect(() => allocate(money(-1), m([1]))).toThrow(RangeError);
    expect(() => allocate(money(10), m([5]))).toThrow(RangeError);
    expect(() => allocate(money(1), [])).toThrow(RangeError);
    expect(allocate(money(0), [])).toEqual([]);
  });
});

describe('parseHryvnias — без parseFloat', () => {
  it.each([
    ['1299', 129900],
    ['1299.5', 129950],
    ['1 299,50', 129950],
    ['0.01', 1],
    ['-10', -1000],
  ])('«%s» → %i', (input, expected) => {
    expect(parseHryvnias(input)).toBe(expected);
  });

  it.each(['12.345', 'abc', '', '1,2,3', '1e3'])('відкидає «%s»', (input) => {
    expect(() => parseHryvnias(input)).toThrow(RangeError);
  });
});

describe('formatMoney', () => {
  it('гривні українською та англійською', () => {
    expect(formatMoney(money(129900), 'uk').replace(/\s/g, ' ')).toBe('1 299,00 ₴');
    expect(formatMoney(money(129900), 'en').replace(/\s/g, ' ')).toBe('UAH 1,299.00');
  });
});

describe('assertFitsPgInteger', () => {
  it('межа integer Postgres', () => {
    expect(assertFitsPgInteger(money(2_147_483_647))).toBe(2_147_483_647);
    expect(() => assertFitsPgInteger(money(2_147_483_648))).toThrow(RangeError);
  });
});
