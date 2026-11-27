/**
 * Promo-code writes. Every function takes the transaction first (AGENTS.md 4b.1) and locks the code's
 * row through `acquireLocks` (ADR-22, level 6), the same row checkout and cancellation lock, so an edit
 * and a redemption cannot interleave. The freeze rule (docs/PROMO_CODES.md section 7) is decided HERE from
 * the database, never from the form: a code with any redemption keeps its type, value and scope.
 */
import { eq, sql } from 'drizzle-orm';

import { categories, products, promoCodes } from '@store/db/schema';
import type { Tx } from '@store/db/types';

import { acquireLocks } from '../locks/acquire-locks.ts';
import {
  PromoCodeTakenError,
  PromoDatesError,
  PromoLimitBelowUsedError,
  PromoLockedError,
  PromoNotFoundError,
  PromoTimeError,
  PromoScopeTargetError,
} from './errors.ts';
import type { PromoBulkInput, PromoCreateInput, PromoFields, PromoUpdateInput } from './schemas.ts';

/** Wall-clock Kyiv text to an instant, decided by Postgres. */
const instant = (value: string | null) =>
  value === null ? sql`NULL` : sql`((${value})::timestamp AT TIME ZONE 'Europe/Kyiv')`;

/**
 * A wall-clock time must survive the round trip instant -> Kyiv wall clock: the hour skipped at the spring
 * change (e.g. 2026-03-29T03:30) comes back an hour later and is refused. The ambiguous autumn hour has two
 * valid instants; Postgres takes the first (summer time), which is documented in docs/PROMO_CODES.md.
 */
async function assertRealWallClocks(tx: Tx, values: readonly (string | null)[]): Promise<void> {
  for (const value of values) {
    if (value === null) continue;
    const result = await tx.execute<{ real: boolean }>(
      sql`SELECT ((${value})::timestamp AT TIME ZONE 'Europe/Kyiv') AT TIME ZONE 'Europe/Kyiv' = (${value})::timestamp AS real`,
    );
    if (result.rows[0]?.real !== true) throw new PromoTimeError();
  }
}

async function assertScopeTarget(tx: Tx, fields: PromoFields): Promise<void> {
  if (fields.scopeCategoryId !== null) {
    const [row] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, fields.scopeCategoryId));
    if (row === undefined) throw new PromoScopeTargetError();
  }
  if (fields.scopeProductId !== null) {
    const [row] = await tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, fields.scopeProductId));
    if (row === undefined) throw new PromoScopeTargetError();
  }
}

function pgCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  if ('code' in error && typeof error.code === 'string') return error.code;
  return 'cause' in error ? pgCode(error.cause) : null;
}

export async function createPromo(
  tx: Tx,
  userId: string,
  input: PromoCreateInput,
): Promise<{ id: string; code: string }> {
  await assertScopeTarget(tx, input);
  await assertRealWallClocks(tx, [input.startsAt, input.endsAt]);
  const inserted = await tx
    .insert(promoCodes)
    .values({
      code: input.code,
      description: input.description,
      type: input.type,
      value: input.value,
      maxDiscountAmount: input.maxDiscountAmount,
      minOrderTotal: input.minOrderTotal,
      maxUses: input.maxUses,
      perCustomerLimit: input.perCustomerLimit,
      scope: input.scope,
      scopeCategoryId: input.scopeCategoryId,
      scopeProductId: input.scopeProductId,
      stackable: input.stackable,
      excludesDiscountedItems: input.excludesDiscountedItems,
      firstOrderOnly: input.firstOrderOnly,
      excludesGiftCards: input.excludesGiftCards,
      startsAt: sql`${instant(input.startsAt)}`,
      endsAt: sql`${instant(input.endsAt)}`,
      isActive: input.isActive,
      createdByUserId: userId,
    })
    .onConflictDoNothing()
    .returning({ id: promoCodes.id, code: promoCodes.code });
  const row = inserted[0];
  if (row === undefined) throw new PromoCodeTakenError();
  return row;
}

type Row = typeof promoCodes.$inferSelect;

/** The fields a redeemed code may not change, with their current and wanted values. */
function frozenChanges(row: Row, wanted: PromoFields): string[] {
  const pairs: [string, unknown, unknown][] = [
    ['type', row.type, wanted.type],
    ['value', row.value, wanted.value],
    ['scope', row.scope, wanted.scope],
    ['scopeCategoryId', row.scopeCategoryId, wanted.scopeCategoryId],
    ['scopeProductId', row.scopeProductId, wanted.scopeProductId],
  ];
  return pairs.filter(([, now, next]) => now !== next).map(([name]) => name);
}

async function hasRedemptions(tx: Tx, id: string): Promise<boolean> {
  const result = await tx.execute<{ used: boolean }>(
    sql`SELECT EXISTS (SELECT 1 FROM promo_code_redemptions WHERE promo_code_id = ${id}::uuid) AS used`,
  );
  return result.rows[0]?.used === true;
}

export interface PromoChange {
  changed: boolean;
  /** Name -> [before, after] for what really changed (money in kopiykas). */
  diff: Record<string, [unknown, unknown]>;
}

const SCALARS = [
  'description',
  'maxDiscountAmount',
  'minOrderTotal',
  'maxUses',
  'perCustomerLimit',
  'stackable',
  'excludesDiscountedItems',
  'firstOrderOnly',
  'excludesGiftCards',
  'isActive',
  'type',
  'value',
  'scope',
  'scopeCategoryId',
  'scopeProductId',
] as const;

export async function updatePromo(tx: Tx, input: PromoUpdateInput): Promise<PromoChange> {
  const locked = await acquireLocks(tx, { promo_codes: [input.id] });
  if (locked.promo_codes?.[0] === undefined) throw new PromoNotFoundError();
  const [row] = await tx.select().from(promoCodes).where(eq(promoCodes.id, input.id));
  if (row === undefined) throw new PromoNotFoundError();

  const frozen = frozenChanges(row, input);
  if (frozen.length > 0 && ((await hasRedemptions(tx, row.id)) || row.usesCount > 0)) {
    throw new PromoLockedError(frozen);
  }
  if (input.maxUses !== null && input.maxUses < row.usesCount) throw new PromoLimitBelowUsedError();
  await assertScopeTarget(tx, input);
  await assertRealWallClocks(tx, [input.startsAt, input.endsAt]);

  const diff: Record<string, [unknown, unknown]> = {};
  for (const name of SCALARS) {
    if (row[name] !== input[name]) diff[name] = [row[name], input[name]];
  }
  // Both ends are compared as instants by Postgres in the same statement below.
  const dates = await tx.execute<{ start_same: boolean; end_same: boolean }>(
    sql`SELECT starts_at IS NOT DISTINCT FROM ${instant(input.startsAt)} AS start_same,
               ends_at IS NOT DISTINCT FROM ${instant(input.endsAt)} AS end_same
          FROM promo_codes WHERE id = ${row.id}::uuid`,
  );
  if (dates.rows[0]?.start_same !== true) diff['startsAt'] = [row.startsAt, input.startsAt];
  if (dates.rows[0]?.end_same !== true) diff['endsAt'] = [row.endsAt, input.endsAt];
  if (Object.keys(diff).length === 0) return { changed: false, diff };

  try {
    await tx
      .update(promoCodes)
      .set({
        description: input.description,
        type: input.type,
        value: input.value,
        maxDiscountAmount: input.maxDiscountAmount,
        minOrderTotal: input.minOrderTotal,
        maxUses: input.maxUses,
        perCustomerLimit: input.perCustomerLimit,
        scope: input.scope,
        scopeCategoryId: input.scopeCategoryId,
        scopeProductId: input.scopeProductId,
        stackable: input.stackable,
        excludesDiscountedItems: input.excludesDiscountedItems,
        firstOrderOnly: input.firstOrderOnly,
        excludesGiftCards: input.excludesGiftCards,
        startsAt: sql`${instant(input.startsAt)}`,
        endsAt: sql`${instant(input.endsAt)}`,
        isActive: input.isActive,
        updatedAt: sql`now()`,
      })
      .where(eq(promoCodes.id, row.id));
  } catch (error) {
    if (pgCode(error) === '23514') throw new PromoDatesError();
    if (pgCode(error) === '23503') throw new PromoScopeTargetError();
    throw error;
  }
  return { changed: true, diff };
}

export interface BulkResult {
  /** The codes that really changed (a repeat changes nothing and has no audit row). */
  changed: { id: string; code: string }[];
}

/** Deactivate codes, or move the end of codes that end earlier than the new end. One lock call, ascending ids. */
export async function bulkUpdatePromos(tx: Tx, input: PromoBulkInput): Promise<BulkResult> {
  const ids = [...new Set(input.ids)];
  await acquireLocks(tx, { promo_codes: ids });
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const result =
    input.op === 'deactivate'
      ? await tx.execute<{ id: string; code: string }>(
          sql`UPDATE promo_codes SET is_active = false, updated_at = now()
               WHERE id IN (${idList}) AND is_active RETURNING id, code`,
        )
      : await tx.execute<{ id: string; code: string }>(
          sql`UPDATE promo_codes SET ends_at = ${instant(input.endsAt)}, updated_at = now()
               WHERE id IN (${idList}) AND ends_at IS NOT NULL
                 AND ends_at < ${instant(input.endsAt)}
                 AND (starts_at IS NULL OR starts_at < ${instant(input.endsAt)})
               RETURNING id, code`,
        );
  return { changed: result.rows };
}
