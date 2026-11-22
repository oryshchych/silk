import { describe, expect, it } from 'vitest';

import type { Tx } from '@store/db/types';

import { acquireLocks, LockOrderViolationError } from './acquire-locks.ts';

const A = '00000000-0000-7000-8000-00000000000a';
const B = '00000000-0000-7000-8000-00000000000b';

/** Records the table of every lock query and answers with the ids it was given. */
function fakeTx(): { tx: Tx; calls: string[] } {
  const calls: string[] = [];
  const tx = {
    execute: (query: { queryChunks: unknown[] }) => {
      const table = /"value":"([a-z_]+)"/.exec(JSON.stringify(query.queryChunks))?.[1] ?? 'unknown';
      calls.push(table);
      const ids = JSON.stringify(query.queryChunks).match(/[0-9a-f]{8}-[0-9a-f-]{27}/g) ?? [];
      return Promise.resolve({ rows: ids.map((id) => ({ id })) });
    },
  } as unknown as Tx;
  return { tx, calls };
}

describe('acquireLocks ordering', () => {
  it('takes levels in ADR-22 order regardless of key order in the spec', async () => {
    const { tx, calls } = fakeTx();
    await acquireLocks(tx, { product_variants: [A], orders: [A], carts: [A], promo_codes: [A] });
    expect(calls).toEqual(['carts', 'orders', 'promo_codes', 'product_variants']);
  });

  it('rejects a lower level after a higher one, deterministically', async () => {
    const { tx, calls } = fakeTx();
    await acquireLocks(tx, { promo_codes: [A] });
    await expect(acquireLocks(tx, { orders: [A] })).rejects.toBeInstanceOf(LockOrderViolationError);
    // the rejected call must not have taken anything
    expect(calls).toEqual(['promo_codes']);
  });

  it('rejects an id below one already held at the same level', async () => {
    const { tx } = fakeTx();
    await acquireLocks(tx, { product_variants: [B] });
    await expect(acquireLocks(tx, { product_variants: [A] })).rejects.toBeInstanceOf(
      LockOrderViolationError,
    );
  });

  it('allows re-locking a held id and a higher level', async () => {
    const { tx, calls } = fakeTx();
    await acquireLocks(tx, { orders: [A] });
    await acquireLocks(tx, { orders: [A], product_variants: [A] });
    expect(calls).toEqual(['orders', 'orders', 'product_variants']);
  });

  it('keeps state per transaction', async () => {
    const first = fakeTx();
    const second = fakeTx();
    await acquireLocks(first.tx, { product_variants: [A] });
    await expect(acquireLocks(second.tx, { carts: [A] })).resolves.toBeDefined();
  });

  it('ignores empty lists', async () => {
    const { tx, calls } = fakeTx();
    await acquireLocks(tx, { carts: [], orders: [] });
    expect(calls).toEqual([]);
  });
});
