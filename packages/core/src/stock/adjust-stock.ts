/**
 * Manual stock changes from the admin (receipt, write-off, stocktake). The physical stock only:
 * reservations and shipping are `orders` business (ADR-18). Every change is ONE atomic UPDATE
 * (never read, check in JS, write: AGENTS.md section 2.4) plus one `stock_adjustments` row in the
 * same transaction, so the history always adds up to the number in `product_variants`.
 *
 *  - `delta`: `stock_quantity = stock_quantity + delta`, refused when it would go below zero;
 *  - `set`: a stocktake sets the counted quantity. It may legitimately fall below what is
 *    reserved (the count found less than was promised): that is reported, not refused, because a
 *    person has to decide which orders suffer (see the note on `variants_reserved_nonneg`).
 */
import { sql } from 'drizzle-orm';

import { stockAdjustments } from '@store/db/schema';
import type { Tx } from '@store/db/types';

import { DomainError } from '../errors.ts';
import { acquireLocks } from '../locks/acquire-locks.ts';

export type StockReason = 'receipt' | 'writeoff' | 'stocktake' | 'correction' | 'import';

export type StockChange = { kind: 'delta'; delta: number } | { kind: 'set'; quantity: number };

export interface AdjustStockInput {
  variantId: string;
  change: StockChange;
  reason: StockReason;
  note?: string | null;
  userId: string | null;
}

export interface AdjustStockResult {
  variantId: string;
  before: number;
  after: number;
  reserved: number;
  /** The new stock is below the reserved quantity: some orders cannot be shipped in full. */
  belowReserved: boolean;
  /** `false` when a `set` to the current quantity changed nothing (no history row either). */
  changed: boolean;
}

export class StockVariantNotFoundError extends DomainError {
  constructor() {
    super('STOCK_VARIANT_NOT_FOUND', 'The variant does not exist');
  }
}

export class StockBelowZeroError extends DomainError {
  constructor() {
    super('STOCK_BELOW_ZERO', 'The change would make the stock negative');
  }
}

export class InvalidStockChangeError extends DomainError {
  constructor() {
    super('STOCK_INVALID_CHANGE', 'The change must be a non-zero whole delta or a whole quantity');
  }
}

const MAX_QUANTITY = 1_000_000;

function validate(change: StockChange): void {
  const ok =
    change.kind === 'delta'
      ? Number.isInteger(change.delta) &&
        change.delta !== 0 &&
        Math.abs(change.delta) <= MAX_QUANTITY
      : Number.isInteger(change.quantity) &&
        change.quantity >= 0 &&
        change.quantity <= MAX_QUANTITY;
  if (!ok) throw new InvalidStockChangeError();
}

export async function adjustStock(tx: Tx, input: AdjustStockInput): Promise<AdjustStockResult> {
  validate(input.change);
  const locked = await acquireLocks(tx, { product_variants: [input.variantId] });
  if ((locked.product_variants ?? []).length === 0) throw new StockVariantNotFoundError();

  const rows =
    input.change.kind === 'delta'
      ? await tx.execute<{ before: number; after: number; reserved: number }>(sql`
          UPDATE product_variants
             SET stock_quantity = stock_quantity + ${input.change.delta}
           WHERE id = ${input.variantId}::uuid
             AND stock_quantity + ${input.change.delta} >= 0
          RETURNING stock_quantity - ${input.change.delta} AS before,
                    stock_quantity AS after,
                    reserved_quantity AS reserved`)
      : await tx.execute<{ before: number; after: number; reserved: number }>(sql`
          UPDATE product_variants AS v
             SET stock_quantity = ${input.change.quantity}
            FROM (SELECT stock_quantity AS before
                    FROM product_variants WHERE id = ${input.variantId}::uuid) AS old
           WHERE v.id = ${input.variantId}::uuid
          RETURNING old.before AS before,
                    v.stock_quantity AS after,
                    v.reserved_quantity AS reserved`);
  const row = rows.rows[0];
  // The row is locked and exists, so no row back means the guard refused a negative result.
  if (row === undefined) throw new StockBelowZeroError();

  const delta = row.after - row.before;
  if (delta !== 0) {
    await tx.insert(stockAdjustments).values({
      variantId: input.variantId,
      userId: input.userId,
      reason: input.reason,
      delta,
      quantityBefore: row.before,
      quantityAfter: row.after,
      note: input.note?.slice(0, 500) ?? null,
    });
  }
  return {
    variantId: input.variantId,
    before: row.before,
    after: row.after,
    reserved: row.reserved,
    belowReserved: row.after < row.reserved,
    changed: delta !== 0,
  };
}
