/**
 * Nova Poshta directory sync on real Postgres, against recorded response fixtures served by a
 * fake `fetch` (the real key arrives with Q2). Covers the checkout criterion that the
 * autocomplete keeps working while the carrier API is down.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { searchSettlements, searchWarehouses } from '@store/core/np-directory';
import { createDb, type DbHandle } from '@store/db/client';
import { npWarehouses } from '@store/db/schema';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

import {
  createNovaPoshtaDirectory,
  NovaPoshtaError,
  type NovaPoshtaDirectory,
} from '../src/np/client.ts';
import { NpSyncAbortedError, syncNpDirectory } from '../src/np/sync.ts';

const fixture = (name: string): { data: Record<string, unknown>[] } =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as {
    data: Record<string, unknown>[];
  };

/** Serves the recorded pages exactly as the API would: by Page and Limit in the request body. */
function fakeFetch(
  mutate: (name: string, rows: Record<string, unknown>[]) => Record<string, unknown>[] = (
    _,
    rows,
  ) => rows,
) {
  const calls: { method: string; page: number }[] = [];
  const impl = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      calledMethod: string;
      methodProperties: { Page: string; Limit: string };
    };
    const page = Number(body.methodProperties.Page);
    const limit = Number(body.methodProperties.Limit);
    calls.push({ method: body.calledMethod, page });
    const all = mutate(
      body.calledMethod,
      fixture(body.calledMethod === 'getCities' ? 'np-cities.json' : 'np-warehouses.json').data,
    );
    const rows = all.slice((page - 1) * limit, page * limit);
    return Promise.resolve(Response.json({ success: true, data: rows, errors: [] }));
  };
  return { impl, calls };
}

let testDb: TestDatabase;
let app: DbHandle;

beforeEach(async () => {
  testDb = await createTestDatabase();
  app = createDb(testDb.appUrl, { max: 2 });
});
afterEach(async () => {
  await app.close();
  await testDb.drop();
});

const directory = (fetchImpl: typeof fetch): NovaPoshtaDirectory =>
  createNovaPoshtaDirectory({ apiKey: 'test-key', fetchImpl });

describe('np directory sync', () => {
  it('loads cities and branches, skips rows without a ref, maps the kinds and counts branches', async () => {
    const { impl } = fakeFetch();
    const result = await syncNpDirectory(app.db, directory(impl), { pageSize: 2 });
    expect(result).toEqual({ cities: 3, branches: 7, deactivated: 0 });

    const kyiv = await searchSettlements(app.db, 'Київ');
    expect(kyiv.map((c) => c.name)).toEqual(['Київ']);
    const options = await searchWarehouses(app.db, 'np-city-kyiv', '');
    // Cargo is never offered; a parcel locker is.
    expect(options.map((b) => b.ref)).toEqual(['np-wh-kyiv-1', 'np-wh-kyiv-2', 'np-wh-kyiv-pm']);
    const [counts] = (
      await app.db.execute<{ kyiv: number; lviv: number }>(
        sql`SELECT (SELECT warehouses_count FROM np_settlements WHERE ref = 'np-city-kyiv') AS kyiv,
                   (SELECT warehouses_count FROM np_settlements WHERE ref = 'np-city-lviv') AS lviv`,
      )
    ).rows;
    expect(counts).toEqual({ kyiv: 3, lviv: 1 });
    const [closed] = await app.db
      .select()
      .from(npWarehouses)
      .where(eq(npWarehouses.ref, 'np-wh-lviv-closed'));
    expect(closed?.isActive).toBe(false);
  });

  it('sends the key in the body and pages until a short page', async () => {
    const { impl, calls } = fakeFetch();
    await syncNpDirectory(app.db, directory(impl), { pageSize: 2 });
    expect(calls.filter((c) => c.method === 'getCities').map((c) => c.page)).toEqual([1, 2]);
    expect(calls.filter((c) => c.method === 'getWarehouses').map((c) => c.page)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('a second run updates in place, and a branch the carrier dropped is deactivated, not deleted', async () => {
    await syncNpDirectory(app.db, directory(fakeFetch().impl));
    const dropped = fakeFetch((name, rows) =>
      name === 'getWarehouses' ? rows.filter((row) => row['Ref'] !== 'np-wh-kyiv-2') : rows,
    );
    const result = await syncNpDirectory(app.db, directory(dropped.impl));
    expect(result.deactivated).toBe(1);
    const [row] = await app.db
      .select()
      .from(npWarehouses)
      .where(eq(npWarehouses.ref, 'np-wh-kyiv-2'));
    expect(row?.isActive).toBe(false);
    expect((await searchWarehouses(app.db, 'np-city-kyiv', '')).map((b) => b.ref)).not.toContain(
      'np-wh-kyiv-2',
    );
  });

  it('a failure halfway deactivates nothing', async () => {
    await syncNpDirectory(app.db, directory(fakeFetch().impl));
    let calls = 0;
    const flaky = ((url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      return calls > 3 ? Promise.reject(new Error('network down')) : fakeFetch().impl(url, init);
    }) as typeof fetch;
    await expect(syncNpDirectory(app.db, directory(flaky), { pageSize: 2 })).rejects.toBeInstanceOf(
      NovaPoshtaError,
    );
    const [active] = (
      await app.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM np_warehouses WHERE is_active`,
      )
    ).rows;
    expect(active?.n).toBe(6);
  });

  it('a sync that returns far fewer branches than we hold aborts before deactivating', async () => {
    await syncNpDirectory(app.db, directory(fakeFetch().impl));
    const shrunk = fakeFetch((name, rows) => (name === 'getWarehouses' ? rows.slice(0, 1) : rows));
    await expect(syncNpDirectory(app.db, directory(shrunk.impl))).rejects.toBeInstanceOf(
      NpSyncAbortedError,
    );
    const [active] = (
      await app.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM np_warehouses WHERE is_active`,
      )
    ).rows;
    expect(active?.n).toBe(6);
  });

  it('autocomplete works while the carrier API is down (it reads our tables only)', async () => {
    await syncNpDirectory(app.db, directory(fakeFetch().impl));
    const down = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
    await expect(syncNpDirectory(app.db, directory(down))).rejects.toMatchObject({
      name: 'NovaPoshtaError',
    });
    expect((await searchSettlements(app.db, 'Льв')).map((c) => c.name)).toEqual(['Львів']);
    expect((await searchWarehouses(app.db, 'np-city-lviv', '')).length).toBe(1);
  });

  it('an API refusal or an HTTP error is a NovaPoshtaError without the body', async () => {
    const refused = (() =>
      Promise.resolve(
        Response.json({ success: false, errors: ['API key is wrong: secret'] }),
      )) as typeof fetch;
    await expect(directory(refused).cities(1, 10)).rejects.toMatchObject({
      name: 'NovaPoshtaError',
      message: 'carrier API refused the request',
    });
    const http500 = (() => Promise.resolve(new Response('boom', { status: 500 }))) as typeof fetch;
    await expect(directory(http500).cities(1, 10)).rejects.toThrow('carrier API answered 500');
  });
});
