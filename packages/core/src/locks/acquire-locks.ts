/**
 * The only place where domain code takes row locks (ADR-22).
 *
 * Eight lock levels exist; a transaction that needs several takes them from the
 * lower number to the higher one, and within one level by ascending id. Two
 * transactions that follow the same order cannot deadlock on these rows.
 *
 * Sorting inside one call is not enough: nothing orders two calls made one
 * after another in the same transaction. So the helper tracks what the
 * transaction already holds and REJECTS an out-of-order request. A protocol
 * violation becomes a deterministic exception in development instead of a
 * deadlock once per few hundred orders in production.
 *
 * Triggers and plain UPDATE/DELETE take locks too, with no `FOR UPDATE` in the
 * text. Callers must take the parent row first (e.g. `carts` before touching
 * `cart_items`, whose trigger bumps `carts.version`).
 */
import { sql } from 'drizzle-orm';

import type { Tx } from '@store/db/types';

/** Lock levels in the mandatory acquisition order. Do not reorder. */
export const LOCK_LEVELS = [
  'carts',
  'checkout_intents',
  'orders',
  'order_items',
  'payment_attempts',
  'promo_codes',
  'gift_cards',
  'product_variants',
] as const;

export type LockKind = (typeof LOCK_LEVELS)[number];

/** Ids to lock per kind. Order inside the lists does not matter. */
export type LockSpec = Partial<Record<LockKind, readonly string[]>>;

export class LockOrderViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockOrderViolationError';
  }
}

interface HeldLocks {
  /** Highest level index taken so far. */
  level: number;
  /** Per kind: ids held, to keep ascending-id order across calls. */
  ids: Map<LockKind, Set<string>>;
}

/**
 * Per-transaction bookkeeping. Keyed by the `Tx` object: a new transaction is a
 * new object, so state never leaks between transactions.
 */
const held = new WeakMap<Tx, HeldLocks>();

function stateOf(tx: Tx): HeldLocks {
  let state = held.get(tx);
  if (state === undefined) {
    state = { level: -1, ids: new Map() };
    held.set(tx, state);
  }
  return state;
}

/**
 * Locks the requested rows in protocol order and returns the ids that exist
 * and are now locked, per kind. Missing ids are simply absent from the result:
 * the caller decides whether that is an error.
 */
export async function acquireLocks(
  tx: Tx,
  spec: LockSpec,
): Promise<Partial<Record<LockKind, string[]>>> {
  const state = stateOf(tx);
  const result: Partial<Record<LockKind, string[]>> = {};

  const requested = LOCK_LEVELS.flatMap((kind, index) => {
    const ids = spec[kind];
    if (ids === undefined || ids.length === 0) return [];
    return [{ kind, index, ids: [...new Set(ids)].sort() }];
  });

  // Validate the whole request before touching the database, so a rejected
  // call takes no locks at all.
  for (const { kind, index, ids } of requested) {
    if (index < state.level) {
      const holding = LOCK_LEVELS[state.level] ?? 'unknown';
      throw new LockOrderViolationError(
        `Cannot lock ${kind} after ${holding}: locks must be taken in ADR-22 order`,
      );
    }
    if (index === state.level) {
      const heldIds = state.ids.get(kind) ?? new Set<string>();
      const highest = [...heldIds].sort().at(-1);
      const lower = ids.find((id) => !heldIds.has(id) && highest !== undefined && id < highest);
      if (lower !== undefined) {
        throw new LockOrderViolationError(
          `Cannot lock ${kind} ${lower} after ${highest ?? ''}: ids must ascend within a level`,
        );
      }
    }
  }

  for (const { kind, index, ids } of requested) {
    const rows = await tx.execute<{ id: string }>(
      sql`SELECT id FROM ${sql.identifier(kind)}
          WHERE id IN (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
          ORDER BY id
          FOR UPDATE`,
    );
    const locked = rows.rows.map((row) => row.id);
    result[kind] = locked;
    state.level = Math.max(state.level, index);
    const heldIds = state.ids.get(kind) ?? new Set<string>();
    for (const id of locked) heldIds.add(id);
    state.ids.set(kind, heldIds);
  }

  return result;
}
