/**
 * Spreads one order-level discount over line items (ADR-15).
 *
 * Largest remainder, delegated to `allocate` from @store/shared/money: each
 * share is the floor of the ideal one and the leftover kopiykas go one at a
 * time to the biggest fractional parts. NOT "leftover to the priciest line":
 * on prices 1000 / 999 / 998 with a discount of 2996 that gives 1001 on a line
 * worth 1000.
 *
 * Ties are broken by line id so the result is deterministic and reproducible
 * in tests; the output keeps the input order.
 */
import { allocate, ZERO, sum, type Money } from '@store/shared/money';

export interface DiscountLine {
  id: string;
  /** Line subtotal before discount: unit price times quantity. */
  lineSubtotal: Money;
  /** Lines the promo does not apply to receive 0. */
  eligible: boolean;
}

export function allocateLineDiscounts(
  lines: readonly DiscountLine[],
  discountTotal: Money,
): Money[] {
  if (new Set(lines.map((line) => line.id)).size !== lines.length) {
    // The id tie-break (ADR-15) is only deterministic when ids are unique.
    throw new Error('discount lines must have unique ids');
  }
  const eligible = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.eligible)
    .sort((a, b) => (a.line.id < b.line.id ? -1 : 1)); // ids are unique

  const shares = allocate(
    discountTotal,
    eligible.map(({ line }) => line.lineSubtotal),
  );

  const result = lines.map(() => ZERO);
  eligible.forEach(({ index }, position) => {
    // `?? ZERO` only satisfies noUncheckedIndexedAccess: allocate returns one share per weight.
    /* v8 ignore next */
    result[index] = shares[position] ?? ZERO;
  });
  assertAllocation(lines, result, discountTotal);
  return result;
}

/**
 * ADR-15 step 3: a violation here is a bug in the algorithm, not bad data, so
 * it throws instead of returning an error. Exported so the guard itself is
 * tested: the algorithm cannot reach it.
 */
export function assertAllocation(
  lines: readonly DiscountLine[],
  discounts: readonly Money[],
  discountTotal: Money,
): void {
  lines.forEach((line, index) => {
    /* v8 ignore next */
    const share = discounts[index] ?? ZERO;
    if (share < 0 || share > line.lineSubtotal || (!line.eligible && share !== 0)) {
      throw new Error(`discount allocation is out of range for line ${line.id}`);
    }
  });
  if (sum(discounts) !== discountTotal) {
    throw new Error('discount allocation does not add up to the discount total');
  }
}
