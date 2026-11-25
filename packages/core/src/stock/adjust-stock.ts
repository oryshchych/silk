/**
 * Manual stock changes from the admin (receipt, write-off, stocktake). The physical stock only:
 * reservations and shipping are `orders` business (ADR-18). Every change is ONE atomic UPDATE
 * (never read, check in JS, write: AGENTS.md section 2.4) plus one `stock_adjustments` row in the
 * same transaction, so the history always adds up to the number in `product_variants`.
 *
 *  - `delta`: `stock_quantity = stock_quantity + delta`, refused when it would go below zero;
 *  - `set`: a stocktake sets the counted quantity.
 *
 * Both refuse a result BELOW the reserved quantity (`StockBelowReservedError`): `shipOrder` takes
 * `stock_quantity` and `reserved_quantity` down together, so stock under the reservations would
 * make already-promised orders impossible to ship (`variants_stock_nonneg`). To count less than is
 * reserved, cancel or release the orders first. Whether a stocktake may ever override this is the
 * owner's decision (queue Q44); the default is to refuse. Raising stock releases nothing and
 * leaves `reserved_quantity` as it is.
 *
 * `requestId` makes a retried or double-submitted request harmless: the second call returns the
 * first result and changes nothing. Variants are locked first, so two parallel calls with one id
 * on one variant are serialised; one id reused for ANOTHER variant is an error.
 *
 * The caller writes the `audit_log` row (the draft is in the result) through `adminAction`, which
 * refuses to commit a handler that wrote none.
 */
import { eq, sql } from 'drizzle-orm';

import { productVariants, stockAdjustments } from '@store/db/schema';
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
  /** Idempotency key of the admin request (a UUID); a repeat returns the first result. */
  requestId?: string | null;
}

export interface AdjustStockResult {
  variantId: string;
  before: number;
  after: number;
  reserved: number;
  /** `false` when a `set` to the current quantity changed nothing (no history row either). */
  changed: boolean;
  /** True when `requestId` was already applied: nothing was changed now. */
  replayed: boolean;
  /** What the caller writes to `audit_log` (stock numbers and the reason, no personal data). */
  audit: {
    action: 'update';
    entity: 'product_variant';
    entityId: string;
    diff: Record<string, unknown>;
  };
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

export class StockBelowReservedError extends DomainError {
  constructor() {
    super('STOCK_BELOW_RESERVED', 'The stock cannot fall below the quantity reserved for orders');
  }
}

export class StockAboveMaxError extends DomainError {
  constructor() {
    super('STOCK_ABOVE_MAX', 'The stock cannot exceed the maximum');
  }
}

export class StockRequestReusedError extends DomainError {
  constructor() {
    super('STOCK_REQUEST_REUSED', 'This request id was already used for another variant');
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

  const requestId = input.requestId ?? null;
  if (requestId !== null) {
    const [earlier] = await tx
      .select()
      .from(stockAdjustments)
      .where(eq(stockAdjustments.requestId, requestId));
    if (earlier !== undefined) {
      if (earlier.variantId !== input.variantId) throw new StockRequestReusedError();
      const [variant] = await tx
        .select({ reserved: productVariants.reservedQuantity })
        .from(productVariants)
        .where(eq(productVariants.id, input.variantId));
      return {
        variantId: input.variantId,
        before: earlier.quantityBefore,
        after: earlier.quantityAfter,
        reserved: variant?.reserved ?? 0,
        changed: false,
        replayed: true,
        audit: auditDraft(input, earlier.quantityBefore, earlier.quantityAfter),
      };
    }
  }

  // The new quantity must stay between what is reserved and the cap. One statement, so nothing
  // can slip in between the check and the write.
  const rows =
    input.change.kind === 'delta'
      ? await tx.execute<{ before: number; after: number; reserved: number }>(sql`
          UPDATE product_variants
             SET stock_quantity = stock_quantity + ${input.change.delta}
           WHERE id = ${input.variantId}::uuid
             AND stock_quantity + ${input.change.delta} >= reserved_quantity
             AND stock_quantity + ${input.change.delta} <= ${MAX_QUANTITY}
          RETURNING stock_quantity - ${input.change.delta} AS before,
                    stock_quantity AS after,
                    reserved_quantity AS reserved`)
      : await tx.execute<{ before: number; after: number; reserved: number }>(sql`
          UPDATE product_variants AS v
             SET stock_quantity = ${input.change.quantity}
            FROM (SELECT stock_quantity AS before
                    FROM product_variants WHERE id = ${input.variantId}::uuid) AS old
           WHERE v.id = ${input.variantId}::uuid
             AND ${input.change.quantity} >= v.reserved_quantity
          RETURNING old.before AS before,
                    v.stock_quantity AS after,
                    v.reserved_quantity AS reserved`);
  const row = rows.rows[0];
  if (row === undefined) {
    // Refused. The variant is locked and exists: say which rule it broke.
    const [now] = await tx
      .select({
        stock: productVariants.stockQuantity,
        reserved: productVariants.reservedQuantity,
      })
      .from(productVariants)
      .where(eq(productVariants.id, input.variantId));
    const target =
      input.change.kind === 'delta'
        ? (now?.stock ?? 0) + input.change.delta
        : input.change.quantity;
    if (target > MAX_QUANTITY) throw new StockAboveMaxError();
    if (target < 0) throw new StockBelowZeroError();
    throw new StockBelowReservedError();
  }

  const delta = row.after - row.before;
  if (delta !== 0) {
    try {
      // A savepoint: a duplicate request id (one id on another variant, racing) must not abort the
      // caller's transaction with a raw database error.
      await tx.transaction(async (inner) => {
        await inner.insert(stockAdjustments).values({
          variantId: input.variantId,
          userId: input.userId,
          requestId,
          reason: input.reason,
          delta,
          quantityBefore: row.before,
          quantityAfter: row.after,
          note: input.note?.slice(0, 500) ?? null,
        });
      });
    } catch (error) {
      if (violatedConstraint(error) === 'stock_adjustments_request_uq') {
        throw new StockRequestReusedError();
      }
      throw error;
    }
  }
  return {
    variantId: input.variantId,
    before: row.before,
    after: row.after,
    reserved: row.reserved,
    changed: delta !== 0,
    replayed: false,
    audit: auditDraft(input, row.before, row.after),
  };
}

/** The name of the unique constraint a database error violated (the driver error may be wrapped). */
function violatedConstraint(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const code: unknown = Reflect.get(current, 'code');
    const constraint: unknown = Reflect.get(current, 'constraint');
    if (code === '23505' && typeof constraint === 'string') return constraint;
    current = Reflect.get(current, 'cause');
  }
  return null;
}

function auditDraft(
  input: AdjustStockInput,
  before: number,
  after: number,
): AdjustStockResult['audit'] {
  return {
    action: 'update',
    entity: 'product_variant',
    entityId: input.variantId,
    diff: { stock: { from: before, to: after }, reason: input.reason },
  };
}
