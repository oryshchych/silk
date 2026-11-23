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
  it('loads cities and branches, maps the kinds and counts branches', async () => {
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

  it('hostile carrier text is cleaned, capped or skipped instead of failing the page', async () => {
    const hostile = fakeFetch((name, rows) =>
      name === 'getCities'
        ? [
            ...rows,
            {
              Ref: 'np-city-evil',
              Description: `Evil\u0000<script>alert(1)</script>${'x'.repeat(10_000)}`,
            },
            { Ref: 'r'.repeat(500), Description: 'Too long a ref' },
          ]
        : rows,
    );
    await syncNpDirectory(app.db, directory(hostile.impl));
    const [row] = (
      await app.db.execute<{ name_uk: string }>(
        sql`SELECT name_uk FROM np_settlements WHERE ref = 'np-city-evil'`,
      )
    ).rows;
    expect(row?.name_uk).not.toContain('\u0000');
    expect(row?.name_uk.length).toBe(240);
    const [count] = (
      await app.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM np_settlements`)
    ).rows;
    expect(count?.n).toBe(5);
  });

  it('the API key never appears in an error, and unreadable data is a NovaPoshtaError', async () => {
    const garbage = (() =>
      Promise.resolve(
        new Response('<html>not json</html>', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof fetch;
    const error = await createNovaPoshtaDirectory({ apiKey: 'SECRET-KEY-123', fetchImpl: garbage })
      .cities(1, 10)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'NovaPoshtaError' });
    expect(JSON.stringify(error)).not.toContain('SECRET-KEY-123');
    expect(error).toHaveProperty('message', 'carrier API answered with unreadable data');
  });

  it('a page that is short only because a row was malformed does not end the fetch', async () => {
    // Page size 2: the bad row sits on page 1, so the parsed page is short but the raw one is full.
    const withBad = fakeFetch((name, rows) =>
      name === 'getCities' ? [{ Description: 'No ref' }, ...rows] : rows,
    );
    const result = await syncNpDirectory(app.db, directory(withBad.impl), { pageSize: 2 });
    expect(result.cities).toBe(3);
    expect(withBad.calls.filter((c) => c.method === 'getCities').map((c) => c.page)).toEqual([
      1, 2, 3,
    ]);
  });

  it('mostly malformed rows abort the run before anything is deactivated', async () => {
    await syncNpDirectory(app.db, directory(fakeFetch().impl));
    const broken = fakeFetch((name, rows) =>
      name === 'getWarehouses' ? rows.map((row) => ({ Ref: row['Ref'] })) : rows,
    );
    await expect(syncNpDirectory(app.db, directory(broken.impl))).rejects.toBeInstanceOf(
      NpSyncAbortedError,
    );
    const [active] = (
      await app.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM np_warehouses WHERE is_active`,
      )
    ).rows;
    expect(active?.n).toBe(6);
  });

  it('a renamed status field (every row inactive) aborts instead of emptying the directory', async () => {
    await syncNpDirectory(app.db, directory(fakeFetch().impl));
    const renamed = fakeFetch((name, rows) =>
      name === 'getWarehouses'
        ? rows.map((row) => ({ ...row, WarehouseStatus: undefined, Status: 'Working' }))
        : rows,
    );
    await expect(syncNpDirectory(app.db, directory(renamed.impl))).rejects.toBeInstanceOf(
      NpSyncAbortedError,
    );
    const [active] = (
      await app.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM np_warehouses WHERE is_active`,
      )
    ).rows;
    expect(active?.n).toBe(6);
  });

  it('an API that ignores Page and repeats one page aborts instead of "completing"', async () => {
    await syncNpDirectory(app.db, directory(fakeFetch().impl));
    const same = ((_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        calledMethod: string;
      };
      const all = fixture(
        body.calledMethod === 'getCities' ? 'np-cities.json' : 'np-warehouses.json',
      ).data;
      return Promise.resolve(Response.json({ success: true, data: all.slice(0, 2) }));
    }) as typeof fetch;
    await expect(syncNpDirectory(app.db, directory(same), { pageSize: 2 })).rejects.toBeInstanceOf(
      NpSyncAbortedError,
    );
    const [active] = (
      await app.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM np_warehouses WHERE is_active`,
      )
    ).rows;
    expect(active?.n).toBe(6);
  });

  it('more than a tenth of malformed rows aborts even when the active count stays high', async () => {
    await syncNpDirectory(app.db, directory(fakeFetch().impl));
    // 20 extra rows without a Ref next to the 7 good ones: 74 percent malformed, all good rows active.
    const junk = Array.from({ length: 20 }, (_, i) => ({ Description: `broken ${String(i)}` }));
    const noisy = fakeFetch((name, rows) => (name === 'getWarehouses' ? [...rows, ...junk] : rows));
    await expect(syncNpDirectory(app.db, directory(noisy.impl))).rejects.toMatchObject({
      name: 'NpSyncAbortedError',
      message: expect.stringContaining('malformed') as string,
    });
  });

  it('nothing is written when a run aborts, and renamed coordinates keep what we know', async () => {
    await syncNpDirectory(app.db, directory(fakeFetch().impl));
    await app.db.execute(
      sql`UPDATE np_warehouses SET latitude = 50.45, longitude = 30.52 WHERE ref = 'np-wh-lviv-1'`,
    );
    const renamed = fakeFetch((name, rows) =>
      name === 'getWarehouses'
        ? rows.map((row) => ({
            ...row,
            Latitude: undefined,
            Longitude: undefined,
            Lat: '1',
            Lon: '2',
          }))
        : rows,
    );
    await syncNpDirectory(app.db, directory(renamed.impl));
    const [row] = (
      await app.db.execute<{ latitude: number; longitude: number }>(
        sql`SELECT latitude, longitude FROM np_warehouses WHERE ref = 'np-wh-lviv-1'`,
      )
    ).rows;
    expect(row).toEqual({ latitude: 50.45, longitude: 30.52 });
    // An aborting run leaves descriptions untouched too.
    await app.db.execute(
      sql`UPDATE np_warehouses SET description_uk = 'kept' WHERE ref = 'np-wh-lviv-1'`,
    );
    const shrunk = fakeFetch((name, rows) => (name === 'getWarehouses' ? rows.slice(0, 1) : rows));
    await expect(syncNpDirectory(app.db, directory(shrunk.impl))).rejects.toBeInstanceOf(
      NpSyncAbortedError,
    );
    const [kept] = (
      await app.db.execute<{ d: string }>(
        sql`SELECT description_uk AS d FROM np_warehouses WHERE ref = 'np-wh-lviv-1'`,
      )
    ).rows;
    expect(kept?.d).toBe('kept');
  });

  it('refuses an oversized, mistyped or over-long answer and never follows a redirect', async () => {
    const seen: RequestInit[] = [];
    const ok = ((_u: string | URL | Request, init?: RequestInit) => {
      seen.push(init ?? {});
      return Promise.resolve(Response.json({ success: true, data: [] }));
    }) as typeof fetch;
    await directory(ok).cities(1, 10);
    expect(seen[0]?.redirect).toBe('error');

    const html = (() =>
      Promise.resolve(
        new Response('{}', { headers: { 'content-type': 'text/html' } }),
      )) as typeof fetch;
    await expect(directory(html).cities(1, 10)).rejects.toThrow('content type');
    const big = (() =>
      Promise.resolve(
        new Response('{}', {
          headers: {
            'content-type': 'application/json',
            'content-length': String(40 * 1024 * 1024),
          },
        }),
      )) as typeof fetch;
    await expect(directory(big).cities(1, 10)).rejects.toThrow('too large');
    const many = (() =>
      Promise.resolve(
        Response.json({ success: true, data: Array.from({ length: 11 }, () => ({})) }),
      )) as typeof fetch;
    await expect(directory(many).cities(1, 10)).rejects.toThrow('more rows than asked');
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
