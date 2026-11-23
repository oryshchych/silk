/**
 * Nova Poshta directory, read from OUR database (the worker keeps it fresh).
 * Autocomplete never calls the carrier API: it keeps working when that API is
 * down (phase 2 criterion). User text only ever reaches Postgres as a bound
 * parameter, with LIKE wildcards escaped.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';

import { npSettlements, npWarehouses } from '@store/db/schema';
import type { Reader } from '@store/db/types';

import { DeliveryInvalidError } from '../errors.ts';
import { queryRows } from '../catalog/sql.ts';

export const MIN_CITY_QUERY = 2;
export const MAX_CITY_QUERY = 60;
const CITY_LIMIT = 10;
const WAREHOUSE_LIMIT = 50;

export interface SettlementOption {
  ref: string;
  name: string;
  area: string | null;
  region: string | null;
  type: string | null;
}

export interface WarehouseOption {
  ref: string;
  number: string;
  description: string;
  type: 'branch' | 'postomat' | 'cargo';
}

const settlementRow = z.object({
  ref: z.string(),
  name_uk: z.string(),
  area_name_uk: z.string().nullable(),
  region_name_uk: z.string().nullable(),
  settlement_type_uk: z.string().nullable(),
});

/** Escapes `\`, `%` and `_` so user text is matched literally. */
export const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (char) => `\\${char}`);

/** Normalised autocomplete text, or null when it is too short or too long to search. */
export function normalizeCityQuery(raw: string): string | null {
  // A NUL byte cannot be stored in text and would fail the query: such text is not a search.
  if (raw.includes('\0')) return null;
  const text = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  return text.length >= MIN_CITY_QUERY && text.length <= MAX_CITY_QUERY ? text : null;
}

/** Cities by name: prefix matches first, then bigger networks (more branches). */
export async function searchSettlements(reader: Reader, raw: string): Promise<SettlementOption[]> {
  const text = normalizeCityQuery(raw);
  if (text === null) return [];
  const rows = await queryRows(
    reader,
    settlementRow,
    sql`SELECT ref, name_uk, area_name_uk, region_name_uk, settlement_type_uk
          FROM np_settlements
         WHERE name_uk ILIKE ${`%${escapeLike(text)}%`}
         ORDER BY (name_uk ILIKE ${`${escapeLike(text)}%`}) DESC, warehouses_count DESC, name_uk
         LIMIT ${CITY_LIMIT}`,
  );
  return rows.map((row) => ({
    ref: row.ref,
    name: row.name_uk,
    area: row.area_name_uk,
    region: row.region_name_uk,
    type: row.settlement_type_uk,
  }));
}

const warehouseRow = z.object({
  ref: z.string(),
  number: z.string(),
  description_uk: z.string(),
  type: z.enum(['branch', 'postomat', 'cargo']),
});

/** Active branches and parcel lockers of one city, optionally narrowed by text (number or address). */
export async function searchWarehouses(
  reader: Reader,
  settlementRef: string,
  raw: string,
): Promise<WarehouseOption[]> {
  if (raw.includes('\0') || settlementRef.includes('\0')) return [];
  const text = raw.normalize('NFC').trim().slice(0, MAX_CITY_QUERY);
  const filter = text === '' ? sql`` : sql` AND description_uk ILIKE ${`%${escapeLike(text)}%`}`;
  const rows = await queryRows(
    reader,
    warehouseRow,
    sql`SELECT ref, number, description_uk, type
          FROM np_warehouses
         WHERE settlement_ref = ${settlementRef} AND is_active AND type <> 'cargo'${filter}
         ORDER BY CASE WHEN number ~ '^[0-9]+$' THEN number::int END NULLS LAST, number
         LIMIT ${WAREHOUSE_LIMIT}`,
  );
  return rows.map((row) => ({
    ref: row.ref,
    number: row.number,
    description: row.description_uk,
    type: row.type,
  }));
}

export interface ResolvedNpPoint {
  settlementRef: string;
  settlementName: string;
  warehouseRef: string | null;
  warehouseName: string | null;
}

/**
 * Checks the buyer's choice against the directory and returns the names to
 * snapshot on the order. The warehouse must belong to the city and be active.
 */
export async function resolveNpPoint(
  reader: Reader,
  input: { settlementRef?: string | undefined; warehouseRef?: string | undefined },
  needWarehouse: boolean,
): Promise<ResolvedNpPoint> {
  if (input.settlementRef === undefined) throw new DeliveryInvalidError('city is required');
  const [settlement] = await reader
    .select({ ref: npSettlements.ref, name: npSettlements.nameUk })
    .from(npSettlements)
    .where(eq(npSettlements.ref, input.settlementRef));
  if (settlement === undefined) throw new DeliveryInvalidError('unknown city');
  if (!needWarehouse) {
    return {
      settlementRef: settlement.ref,
      settlementName: settlement.name,
      warehouseRef: null,
      warehouseName: null,
    };
  }
  if (input.warehouseRef === undefined) throw new DeliveryInvalidError('branch is required');
  const [warehouse] = await reader
    .select({ ref: npWarehouses.ref, name: npWarehouses.descriptionUk })
    .from(npWarehouses)
    .where(
      and(
        eq(npWarehouses.ref, input.warehouseRef),
        eq(npWarehouses.settlementRef, settlement.ref),
        eq(npWarehouses.isActive, true),
        ne(npWarehouses.type, 'cargo'),
      ),
    );
  if (warehouse === undefined) throw new DeliveryInvalidError('unknown branch for this city');
  return {
    settlementRef: settlement.ref,
    settlementName: settlement.name,
    warehouseRef: warehouse.ref,
    warehouseName: warehouse.name,
  };
}
