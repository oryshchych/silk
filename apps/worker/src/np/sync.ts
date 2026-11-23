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
/** A sync that returns fewer ACTIVE branches than this share of those we hold is treated as broken. */
const MIN_SHARE_PERCENT = 80;
/** More malformed rows than this share of everything the API sent means its shape changed. */
const MAX_DROPPED_PERCENT = 10;
const MAX_PAGES = 500;
const CHUNK = 1000;

/** Pages of one kind until a short page. Aborts on a repeated page and when the page limit is hit. */
async function fetchAll<T extends { ref: string }>(
  fetchPage: (page: number) => Promise<{ rows: T[]; raw: number }>,
  pageSize: number,
  what: string,
): Promise<{ rows: Map<string, T>; raw: number }> {
  const byRef = new Map<string, T>();
  let rawTotal = 0;
  let previous = '';
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { rows, raw } = await fetchPage(page);
    rawTotal += raw;
    // An API that ignores `Page` answers the same page every time: refuse instead of "completing".
    const signature = rows.map((row) => row.ref).join('|');
    if (page > 1 && signature !== '' && signature === previous) {
      throw new NpSyncAbortedError(`the carrier repeated a page of ${what}`);
    }
    previous = signature;
    for (const row of rows) byRef.set(row.ref, row);
    if (raw < pageSize) return { rows: byRef, raw: rawTotal };
  }
  throw new NpSyncAbortedError(`the page limit was reached while fetching ${what}`);
}

/**
 * Everything is fetched and checked BEFORE the first write; the writes are one transaction. A
 * run that aborts (partial fetch, repeated page, malformed rows, too few active branches)
 * changes nothing at all.
 */
export async function syncNpDirectory(
  runner: TransactionRunner,
  directory: NovaPoshtaDirectory,
  options: { pageSize?: number } = {},
): Promise<NpSyncResult> {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const held = await runner.transaction(async (tx) => {
    const row = await tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM np_warehouses WHERE is_active`,
    );
    return row.rows[0]?.n ?? 0;
  });

  const cities = await fetchAll((page) => directory.cities(page, pageSize), pageSize, 'cities');
  const branches = await fetchAll(
    (page) => directory.branches(page, pageSize),
    pageSize,
    'branches',
  );

  const sent = cities.raw + branches.raw;
  const dropped = sent - cities.rows.size - branches.rows.size;
  if (dropped * 100 > sent * MAX_DROPPED_PERCENT) {
    throw new NpSyncAbortedError('too many malformed rows: the carrier data changed shape');
  }
  // Distinct ACTIVE refs: a renamed status field turns every row inactive, a repeated page repeats.
  const active = [...branches.rows.values()].filter((branch) => branch.isActive).length;
  if (held > 0 && active * 100 < held * MIN_SHARE_PERCENT) {
    throw new NpSyncAbortedError('the carrier returned far fewer active branches than we hold');
  }

  return await runner.transaction(async (tx) => {
    const cityList = [...cities.rows.values()];
    for (let i = 0; i < cityList.length; i += CHUNK) {
      await tx
        .insert(npSettlements)
        .values(
          cityList.slice(i, i + CHUNK).map((city) => ({
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
    }
    const branchList = [...branches.rows.values()];
    for (let i = 0; i < branchList.length; i += CHUNK) {
      await tx
        .insert(npWarehouses)
        .values(
          branchList.slice(i, i + CHUNK).map((branch) => ({
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
            // A renamed coordinate field must not wipe what we know: keep the old value on null.
            maxWeightKg: sql`coalesce(excluded.max_weight_kg, np_warehouses.max_weight_kg)`,
            latitude: sql`coalesce(excluded.latitude, np_warehouses.latitude)`,
            longitude: sql`coalesce(excluded.longitude, np_warehouses.longitude)`,
            isActive: sql`excluded.is_active`,
            syncedAt: sql`now()`,
          },
        });
    }
    const gone = await tx.execute(
      sql`UPDATE np_warehouses SET is_active = false
           WHERE is_active AND synced_at < now()
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
    return {
      cities: cities.rows.size,
      branches: branches.rows.size,
      deactivated: gone.rows.length,
    };
  });
}
