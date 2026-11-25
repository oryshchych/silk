/**
 * What every catalog mutation hands back: its result, the audit entry the caller writes in the
 * same transaction, and the cache tags to invalidate AFTER the commit (ADR-8). The domain never
 * calls Next; the web action does, once the transaction has committed.
 */
import type { DomainError } from '../errors.ts';
import { BarcodeTakenError, DuplicateEntryError, SkuTakenError, SlugTakenError } from './errors.ts';

import type { Tx } from '@store/db/types';

export interface AuditDraft {
  action: 'create' | 'update' | 'delete';
  entity: string;
  entityId: string;
  diff: Record<string, unknown>;
}

export interface AdminOutcome<T> {
  data: T;
  audit: AuditDraft;
  tags: string[];
}

/** Fields whose VALUE never enters an audit diff: the diff only says they changed. */
const HIDDEN = new Set(['costPrice']);

/** `{ field: { from, to } }` for the listed fields that differ; hidden fields give `'changed'`. */
export function diffOf<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
  keys: readonly (keyof T & string)[],
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(key in after) || after[key] === undefined) continue;
    if (Object.is(before[key], after[key])) continue;
    diff[key] = HIDDEN.has(key) ? 'changed' : { from: before[key], to: after[key] };
  }
  return diff;
}

const CONSTRAINTS: Record<string, () => DomainError> = {
  products_slug_uq: () => new SlugTakenError(),
  categories_slug_uq: () => new SlugTakenError(),
  products_sku_uq: () => new SkuTakenError(),
  variants_sku_uq: () => new SkuTakenError(),
  variants_barcode_uq: () => new BarcodeTakenError(),
  colors_slug_uq: () => new DuplicateEntryError(),
  sizes_system_label_uq: () => new DuplicateEntryError(),
  attributes_code_uq: () => new DuplicateEntryError(),
  attribute_values_uq: () => new DuplicateEntryError(),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function constraintOf(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && isRecord(current); depth += 1) {
    if (current['code'] === '23505' && typeof current['constraint'] === 'string') {
      return current['constraint'];
    }
    current = current['cause'];
  }
  return null;
}

/**
 * Runs `fn` in a savepoint so a unique violation is turned into a typed domain error without
 * aborting the caller's transaction. Any other error propagates unchanged.
 */
export async function mapUnique<T>(tx: Tx, fn: (inner: Tx) => Promise<T>): Promise<T> {
  try {
    return await tx.transaction(fn);
  } catch (error) {
    const mapped = CONSTRAINTS[constraintOf(error) ?? ''];
    if (mapped !== undefined) throw mapped();
    throw error;
  }
}
