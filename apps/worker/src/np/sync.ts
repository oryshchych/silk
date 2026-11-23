/**
 * Nova Poshta directory sync (`np:sync-settlements`, nightly): keeps `np_settlements` and
 * `np_warehouses` fresh so the checkout autocomplete never needs the carrier API.
 *
 * Safety: pages are upserted one transaction each, and what the carrier no longer lists is
 * only deactivated AFTER every page was fetched without error. A run that fails halfway, or
 * one whose branch count collapses compared with what we hold, changes nothing beyond the
 * pages already upserted (and never deactivates anything).
 */
import { sql } from 'drizzle-orm';

import { npSettlements, npWarehouses } from '@store/db/schema';
import type { Tx } from '@store/db/types';

import type { NovaPoshtaDirectory } from './client.ts';

export interface TransactionRunner {
  transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

export interface NpSyncResult {
  cities: number;
  branches: number;
  deactivated: number;
}

export class NpSyncAbortedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NpSyncAbortedError';
  }
}

const PAGE_SIZE = 500;
/** A sync that returns fewer than this share of the branches we hold is treated as broken. */
const MIN_SHARE_PERCENT = 50;
const MAX_PAGES = 500;

export async function syncNpDirectory(
  runner: TransactionRunner,
  directory: NovaPoshtaDirectory,
  options: { pageSize?: number } = {},
): Promise<NpSyncResult> {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const started = await runner.transaction(async (tx) => {
    const row = await tx.execute<{ now: string }>(sql`SELECT clock_timestamp()::text AS now`);
    const held = await tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM np_warehouses WHERE is_active`,
    );
    return { at: row.rows[0]?.now ?? '', held: held.rows[0]?.n ?? 0 };
  });

  let cities = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const rows = await directory.cities(page, pageSize);
    if (rows.length > 0) {
      await runner.transaction(async (tx) => {
        await tx
          .insert(npSettlements)
          .values(
            rows.map((city) => ({
              ref: city.ref,
              nameUk: city.name,
              areaNameUk: city.area,
              settlementTypeUk: city.type,
            })),
          )
          .onConflictDoUpdate({
            target: npSettlements.ref,
            set: {
              nameUk: sql`excluded.name_uk`,
              areaNameUk: sql`excluded.area_name_uk`,
              settlementTypeUk: sql`excluded.settlement_type_uk`,
              syncedAt: sql`now()`,
            },
          });
      });
    }
    cities += rows.length;
    if (rows.length < pageSize) break;
  }

  let branches = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const rows = await directory.branches(page, pageSize);
    if (rows.length > 0) {
      await runner.transaction(async (tx) => {
        await tx
          .insert(npWarehouses)
          .values(
            rows.map((branch) => ({
              ref: branch.ref,
              settlementRef: branch.cityRef,
              number: branch.number,
              descriptionUk: branch.description,
              type: branch.kind,
              maxWeightKg: branch.maxWeightKg,
              latitude: branch.latitude,
              longitude: branch.longitude,
              isActive: branch.isActive,
            })),
          )
          .onConflictDoUpdate({
            target: npWarehouses.ref,
            set: {
              settlementRef: sql`excluded.settlement_ref`,
              number: sql`excluded.number`,
              descriptionUk: sql`excluded.description_uk`,
              type: sql`excluded.type`,
              maxWeightKg: sql`excluded.max_weight_kg`,
              latitude: sql`excluded.latitude`,
              longitude: sql`excluded.longitude`,
              isActive: sql`excluded.is_active`,
              syncedAt: sql`now()`,
            },
          });
      });
    }
    branches += rows.length;
    if (rows.length < pageSize) break;
  }

  if (started.held > 0 && branches * 100 < started.held * MIN_SHARE_PERCENT) {
    throw new NpSyncAbortedError('the carrier returned far fewer branches than we hold');
  }

  return await runner.transaction(async (tx) => {
    const gone = await tx.execute(
      sql`UPDATE np_warehouses SET is_active = false
           WHERE is_active AND synced_at < ${started.at}::timestamptz
          RETURNING ref`,
    );
    await tx.execute(
      sql`UPDATE np_settlements s SET warehouses_count = c.n
            FROM (SELECT s2.ref, count(w.ref)::int AS n
                    FROM np_settlements s2
                    LEFT JOIN np_warehouses w
                           ON w.settlement_ref = s2.ref AND w.is_active AND w.type <> 'cargo'
                   GROUP BY s2.ref) c
           WHERE s.ref = c.ref AND s.warehouses_count <> c.n`,
    );
    return { cities, branches, deactivated: gone.rows.length };
  });
}
