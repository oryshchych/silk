import { describe, expect, it } from 'vitest';

import { add, money, sum, type Money } from '@store/shared/money';

import { allocateLineDiscounts, assertAllocation, type DiscountLine } from './allocate-discount.ts';
import { calculateCart, calculateDiscount, type CartLineInput } from './calculate-cart.ts';

const line = (id: string, kopiykas: number, eligible = true): DiscountLine => ({
  id,
  lineSubtotal: money(kopiykas),
  eligible,
});

describe('allocateLineDiscounts', () => {
  it('review counterexample: 2996 over 1000/999/998 sums exactly and no line goes negative', () => {
    const lines = [line('a', 1000), line('b', 999), line('c', 998)];
    const result = allocateLineDiscounts(lines, money(2996));
    expect(sum(result)).toBe(2996);
    // Exact largest-remainder result: remainders 1997 / 1998 / 1999 over 2997, so the two
    // leftover kopiykas go to the 998 and 999 lines. "Leftover to the priciest line"
    // would have produced 1001 on the 1000 line.
    expect(result).toEqual([999, 999, 998]);
  });

  it('gives lines the discount equal to their subtotal when the discount covers everything', () => {
    const result = allocateLineDiscounts([line('a', 700), line('b', 300)], money(1000));
    expect(result).toEqual([700, 300]);
  });

  it('single line takes the whole discount', () => {
    expect(allocateLineDiscounts([line('a', 5000)], money(1234))).toEqual([1234]);
  });

  it('100 UAH over three 200 UAH lines: 3334 / 3333 / 3333, tie broken by id', () => {
    const result = allocateLineDiscounts(
      [line('c', 20000), line('a', 20000), line('b', 20000)],
      money(10000),
    );
    // equal remainders: the extra kopiyka goes to the smallest id ('a'), output keeps input order
    expect(result).toEqual([3333, 3334, 3333]);
  });

  it('ineligible lines receive nothing', () => {
    const result = allocateLineDiscounts(
      [line('a', 1000), line('b', 1000, false), line('c', 1000)],
      money(500),
    );
    expect(result).toEqual([250, 0, 250]);
  });

  it('zero discount, and zero discount with no eligible lines', () => {
    expect(allocateLineDiscounts([line('a', 100)], money(0))).toEqual([0]);
    expect(allocateLineDiscounts([line('a', 100, false)], money(0))).toEqual([0]);
  });

  it('rejects a discount larger than the eligible subtotal', () => {
    expect(() => allocateLineDiscounts([line('a', 100)], money(101))).toThrow();
    expect(() => allocateLineDiscounts([line('a', 100, false)], money(1))).toThrow();
  });

  it('property: exact sum, shares within subtotal, deterministic, for random carts', () => {
    let seed = 7;
    const next = (max: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % max;
    };
    for (let round = 0; round < 500; round += 1) {
      const lines = Array.from({ length: 1 + next(6) }, (_, i) =>
        line(`id-${String(i)}`, 1 + next(500000), next(4) !== 0),
      );
      const eligible = sum(lines.filter((l) => l.eligible).map((l) => l.lineSubtotal));
      const discount = money(eligible === 0 ? 0 : next(add(eligible, money(1))));
      const first = allocateLineDiscounts(lines, discount);
      expect(sum(first)).toBe(discount);
      first.forEach((d, i) => {
        const l = lines[i];
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(l?.lineSubtotal ?? 0);
        // within one kopiyka of the ideal proportional share: |d * sumW - discount * w| < sumW
        if (l?.eligible === true) {
          const gap = BigInt(d) * BigInt(eligible) - BigInt(discount) * BigInt(l.lineSubtotal);
          expect(gap < 0n ? -gap : gap).toBeLessThan(BigInt(eligible));
        }
      });
      expect(allocateLineDiscounts([...lines], discount)).toEqual(first);
    }
  });
});

describe('assertAllocation', () => {
  const lines = [line('a', 1000), line('b', 500, false)];
  it('accepts a valid allocation', () => {
    expect(() => {
      assertAllocation(lines, [money(300), money(0)], money(300));
    }).not.toThrow();
  });
  it('rejects a share above the line subtotal', () => {
    expect(() => {
      assertAllocation(lines, [money(1001), money(0)], money(1001));
    }).toThrow(/out of range/);
  });
  it('rejects a negative share and a share on an ineligible line', () => {
    expect(() => {
      assertAllocation(lines, [money(-1), money(0)], money(-1));
    }).toThrow(/out of range/);
    expect(() => {
      assertAllocation(lines, [money(0), money(10)], money(10));
    }).toThrow(/out of range/);
  });
  it('rejects a total that does not add up', () => {
    expect(() => {
      assertAllocation(lines, [money(100), money(0)], money(101));
    }).toThrow(/add up/);
  });
});

describe('promo rule validation and cap', () => {
  it('caps a fixed discount with max_discount_amount too', () => {
    const rule = { type: 'fixed', value: 5000, maxDiscountAmount: money(3000) } as const;
    expect(calculateDiscount(rule, money(20000))).toBe(3000);
  });

  it('rejects a negative fixed value, a negative cap and an out-of-range percent', () => {
    const subtotal = money(1000);
    expect(() =>
      calculateDiscount({ type: 'fixed', value: -1, maxDiscountAmount: null }, subtotal),
    ).toThrow(/fixed/);
    expect(() =>
      calculateDiscount({ type: 'percent', value: 10, maxDiscountAmount: money(-1) }, subtotal),
    ).toThrow(/max discount/);
    expect(() =>
      calculateDiscount({ type: 'percent', value: 0, maxDiscountAmount: null }, subtotal),
    ).toThrow(/percent/);
    expect(() =>
      calculateDiscount({ type: 'percent', value: 101, maxDiscountAmount: null }, subtotal),
    ).toThrow(/percent/);
  });

  it('an empty cart prices to zero', () => {
    const result = calculateCart([], null);
    expect(result.total).toBe(0);
  });

  it('shipping alone cannot overflow silently', () => {
    expect(() => calculateCart([], null, money(2_147_483_647 + 1))).toThrow(/integer/);
  });
});

describe('calculateDiscount', () => {
  const percent = (value: number, cap: Money | null = null) =>
    ({ type: 'percent', value, maxDiscountAmount: cap }) as const;

  it('15% of 19999 is floored to 2999 (one rounding point, explicit mode)', () => {
    expect(calculateDiscount(percent(15), money(19999))).toBe(2999);
  });

  it('percent is capped by max_discount_amount', () => {
    expect(calculateDiscount(percent(20, money(1000)), money(500000))).toBe(1000);
    expect(calculateDiscount(percent(20, money(1000)), money(2000))).toBe(400);
  });

  it('fixed never exceeds the eligible subtotal', () => {
    const fixed = { type: 'fixed', value: 20000, maxDiscountAmount: null } as const;
    expect(calculateDiscount(fixed, money(15000))).toBe(15000);
    expect(calculateDiscount(fixed, money(30000))).toBe(20000);
  });

  it('free_shipping discounts nothing from lines', () => {
    const ship = { type: 'free_shipping', value: 0, maxDiscountAmount: null } as const;
    expect(calculateDiscount(ship, money(30000))).toBe(0);
  });
});

describe('calculateCart input boundary', () => {
  const ok: CartLineInput = { id: 'a', unitPrice: money(1000), quantity: 1, eligible: true };

  it.each([0, -2, 1.5, 100])('rejects quantity %s', (quantity) => {
    expect(() => calculateCart([{ ...ok, quantity }], null)).toThrow(/quantity/);
  });

  it('rejects a negative price and negative shipping', () => {
    expect(() => calculateCart([{ ...ok, unitPrice: money(-1) }], null)).toThrow(/price/);
    expect(() => calculateCart([ok], null, money(-1))).toThrow(/shipping/);
  });

  it('rejects totals that overflow a Postgres integer', () => {
    const big = { ...ok, unitPrice: money(100_000_000), quantity: 99 };
    expect(() => calculateCart([big], null)).toThrow(/integer/);
  });

  it('rejects duplicate line ids', () => {
    expect(() => calculateCart([ok, ok], null)).toThrow(/unique/);
  });

  it('free_shipping zeroes carrier shipping; other promos keep it', () => {
    const free = { type: 'free_shipping', value: 0, maxDiscountAmount: null } as const;
    expect(calculateCart([ok], free, money(8000)).total).toBe(1000);
    const fixed = { type: 'fixed', value: 100, maxDiscountAmount: null } as const;
    expect(calculateCart([ok], fixed, money(8000)).total).toBe(8900);
  });

  it('percent applies to the eligible subtotal only, with quantity above one', () => {
    const lines: CartLineInput[] = [
      { id: 'a', unitPrice: money(1000), quantity: 3, eligible: true },
      { id: 'b', unitPrice: money(5000), quantity: 1, eligible: false },
    ];
    const result = calculateCart(lines, { type: 'percent', value: 10, maxDiscountAmount: null });
    expect(result.discountTotal).toBe(300);
    expect(result.lines.map((l) => l.lineDiscount)).toEqual([300, 0]);
    expect(result.total).toBe(7700);
  });

  it('percent 100 takes the whole eligible subtotal', () => {
    const result = calculateCart([ok], { type: 'percent', value: 100, maxDiscountAmount: null });
    expect(result.lines[0]?.lineTotal).toBe(0);
  });
});

describe('calculateCart', () => {
  const inputs: CartLineInput[] = [
    { id: 'a', unitPrice: money(1000), quantity: 1, eligible: true },
    { id: 'b', unitPrice: money(999), quantity: 1, eligible: true },
    { id: 'c', unitPrice: money(998), quantity: 1, eligible: true },
  ];

  it('subtotal excludes the discount; total subtracts it exactly once', () => {
    const result = calculateCart(
      inputs,
      { type: 'fixed', value: 2996, maxDiscountAmount: null },
      money(5000),
    );
    expect(result.subtotal).toBe(2997);
    expect(result.discountTotal).toBe(2996);
    expect(result.total).toBe(2997 - 2996 + 5000);
    expect(sum(result.lines.map((l) => add(l.lineTotal, l.lineDiscount)))).toBe(result.subtotal);
    expect(sum(result.lines.map((l) => l.lineDiscount))).toBe(result.discountTotal);
    result.lines.forEach((l) => {
      expect(l.lineTotal).toBeGreaterThanOrEqual(0);
    });
  });

  it('without a promo nothing is discounted', () => {
    const result = calculateCart(inputs, null);
    expect(result.discountTotal).toBe(0);
    expect(result.total).toBe(2997);
  });

  it('multiplies by quantity', () => {
    const result = calculateCart(
      [{ id: 'a', unitPrice: money(129900), quantity: 3, eligible: true }],
      null,
    );
    expect(result.subtotal).toBe(389700);
  });
});
