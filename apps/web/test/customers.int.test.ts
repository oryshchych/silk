/**
 * Customer tags and the two CSV routes through the real chain on Postgres: the role matrix, the
 * audit rows, the shape of the files, and what a role without the permission can never receive.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSession, ResolvedSession } from '@store/core/auth';
import { authUsers } from '@store/db/schema';
import { createDb, type Db, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

const USER = '00000000-0000-4000-8000-0000000000aa';
const state: { role: AdminSession['role']; signedIn: boolean; handle: Db | null } = vi.hoisted(
  () => ({
    role: 'manager',
    signedIn: true,
    handle: null,
  }),
);
const resolved = (): ResolvedSession | null =>
  state.signedIn
    ? {
        kind: 'full',
        session: { sid: 's', userId: USER, email: 'cust@example.test', role: state.role },
      }
    : null;

async function wired() {
  const { createAdminAction: create } = await import('../src/lib/admin/action');
  const { createRateLimiter: limiter } = await import('../src/lib/rate-limit');
  return {
    adminAction: create({
      originOk: () => Promise.resolve(true),
      session: () => Promise.resolve(resolved()),
      transaction: async (fn) => {
        if (state.handle === null) throw new Error('no database');
        return await state.handle.transaction(fn);
      },
      client: () => Promise.resolve('203.0.113.9'),
      limiter: limiter({ limit: 1_000, windowMs: 60_000 }),
    }),
  };
}
vi.mock('@/lib/admin/bound-action', wired);
vi.mock('../src/lib/admin/bound-action', wired);
vi.mock('@/lib/admin/session', () => ({ currentSession: () => Promise.resolve(resolved()) }));
vi.mock('@/lib/rate-limit', async () => await import('../src/lib/rate-limit'));
vi.mock('@/lib/request-limits', () => ({ clientAddressOf: () => Promise.resolve('203.0.113.9') }));
vi.mock('@/lib/db', () => ({
  getDb: () =>
    state.handle === null
      ? Promise.reject(new Error('no database'))
      : Promise.resolve(state.handle),
}));

const actions = await import('../src/actions/admin-customers');
const ordersCsv = await import('../src/app/admin/export/orders/route');
const customersCsv = await import('../src/app/admin/export/customers/route');

let testDb: TestDatabase;
let handle: DbHandle;
let key = '';
/** The first column of the first row, as text. */
const firstCell = (rows: unknown[]): string => {
  const row = rows[0];
  const values: unknown[] = typeof row === 'object' && row !== null ? Object.values(row) : [];
  const value = values[0];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 4 });
  state.handle = handle.db;
  await handle.db.insert(authUsers).values({ id: USER, email: 'cust@example.test' });
  await handle.pool.query(
    `INSERT INTO orders (order_number, customer_email, customer_phone, customer_name, delivery_method, subtotal, total, status, payment_status, captured_total)
     VALUES ('LS-2026-000001', 'Buyer@Example.com', '+380501112299', 'Іра Петренко', 'pickup', 129950, 129950, 'delivered', 'paid', 129950)`,
  );
  const result = await handle.pool.query(
    "SELECT left(encode(sha256(convert_to('buyer@example.com', 'UTF8')), 'hex'), 32) AS k",
  );
  key = firstCell(result.rows as unknown[]);
});
afterAll(async () => {
  await handle.close();
  await testDb.drop();
});
beforeEach(() => {
  state.role = 'manager';
  state.signedIn = true;
});

const count = async (text: string, params: unknown[] = []) =>
  Number(firstCell((await handle.pool.query(text, params)).rows as unknown[]));
const get = async (route: { GET: (r: Request) => Promise<Response> }, path: string) =>
  await route.GET(new Request(`https://admin.example${path}`));

describe('updateCustomerAction', () => {
  it('content is FORBIDDEN and writes nothing; bad input is INVALID_INPUT', async () => {
    state.role = 'content';
    expect(await actions.updateCustomerAction({ key, tags: ['vip'], note: '' })).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    state.role = 'manager';
    for (const input of [
      { key, tags: ['a b'], note: '' },
      { key, tags: [], note: 'x'.repeat(1001) },
      { key: 'nope', tags: [], note: '' },
      { tags: [], note: '' },
    ]) {
      expect(await actions.updateCustomerAction(input)).toEqual({
        ok: false,
        code: 'INVALID_INPUT',
      });
    }
    expect(await count('SELECT count(*) FROM customers')).toBe(0);
  });

  it('a manager tags a customer: one audit row with author and address, the note text stays out of it, a repeat writes none', async () => {
    const input = { key, tags: ['VIP', 'wholesale'], note: 'prefers evening calls' };
    expect((await actions.updateCustomerAction(input)).ok).toBe(true);
    expect((await actions.updateCustomerAction(input)).ok).toBe(true);
    expect(
      await count(
        "SELECT count(*) FROM audit_log WHERE entity = 'customer' AND entity_id = $1 AND user_id = $2 AND ip = '203.0.113.9'",
        [key, USER],
      ),
    ).toBe(1);
    const diff = JSON.stringify(
      (await handle.pool.query("SELECT diff FROM audit_log WHERE entity = 'customer'")).rows,
    );
    expect(diff).not.toContain('evening');
    expect(diff).toContain('wholesale');
    expect(await actions.updateCustomerAction({ key: 'f'.repeat(32), tags: [], note: '' })).toEqual(
      { ok: false, code: 'ADMIN_NOT_FOUND' },
    );
  });
});

describe('the CSV routes', () => {
  it('orders: 401 without a session, 403 for a manager, 400 for a bad range or cursor', async () => {
    state.signedIn = false;
    expect((await get(ordersCsv, `/admin/export/orders?from=${today}&to=${today}`)).status).toBe(
      401,
    );
    state.signedIn = true;
    expect((await get(ordersCsv, `/admin/export/orders?from=${today}&to=${today}`)).status).toBe(
      403,
    );
    state.role = 'admin';
    for (const query of [
      '',
      'from=2026-13-01&to=2026-13-02',
      `from=${today}&to=2001-01-01`,
      `from=${today}&to=${today}&after=x`,
    ]) {
      expect((await get(ordersCsv, `/admin/export/orders?${query}`)).status, query).toBe(400);
    }
    expect(await count("SELECT count(*) FROM audit_log WHERE action = 'export'")).toBe(0);
  });

  it('orders: an admin gets amounts with two decimals and no personal data, and the download is audited', async () => {
    state.role = 'admin';
    const response = await get(ordersCsv, '/admin/export/orders?from=2020-01-01&to=2099-12-31');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-disposition')).toContain(
      'orders-2020-01-01-2099-12-31.csv',
    );
    const body = await response.text();
    expect(body).toContain('LS-2026-000001');
    expect(body).toContain('1299.50');
    expect(body).not.toMatch(/buyer@example\.com|\+380|Іра/i);
    expect(
      await count(
        "SELECT count(*) FROM audit_log WHERE action = 'export' AND entity = 'order' AND user_id = $1 AND ip = '203.0.113.9'",
        [USER],
      ),
    ).toBe(1);
  });

  it('customers: 401, 403 for a manager and content, an admin gets personal data and an audit row', async () => {
    state.signedIn = false;
    expect((await get(customersCsv, '/admin/export/customers')).status).toBe(401);
    state.signedIn = true;
    for (const role of ['manager', 'content'] as const) {
      state.role = role;
      expect((await get(customersCsv, '/admin/export/customers')).status, role).toBe(403);
    }
    state.role = 'admin';
    expect(
      (await get(customersCsv, '/admin/export/customers?after=' + 'x'.repeat(400))).status,
    ).toBe(400);
    const response = await get(customersCsv, '/admin/export/customers');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('buyer@example.com');
    expect(body).toContain('1299.50');
    expect(body).toContain('vip');
    expect(
      await count("SELECT count(*) FROM audit_log WHERE action = 'export' AND entity = 'customer'"),
    ).toBe(1);
  });
});
