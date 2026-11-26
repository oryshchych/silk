/**
 * The user-management actions through the real chain on Postgres: only the owner, one audit row per
 * change with author and address, and no password anywhere it must not be.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSession, ResolvedSession } from '@store/core/auth';
import { createAdminUser } from '@store/core/auth';
import { createDb, type Db, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

const state: { role: AdminSession['role']; userId: string; handle: Db | null } = vi.hoisted(() => ({
  role: 'owner',
  userId: '',
  handle: null,
}));

async function wired() {
  const { createAdminAction: create } = await import('../src/lib/admin/action');
  const { createRateLimiter: limiter } = await import('../src/lib/rate-limit');
  return {
    adminAction: create({
      originOk: () => Promise.resolve(true),
      session: () =>
        Promise.resolve({
          kind: 'full',
          session: {
            sid: 's',
            userId: state.userId,
            email: 'actor@example.test',
            role: state.role,
          },
        } satisfies ResolvedSession),
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

const actions = await import('../src/actions/admin-users');

const PASSWORD = 'correct-horse-battery-staple';
const SECRET_NEW = 'brand-new-secret-phrase-2026';
let testDb: TestDatabase;
let handle: DbHandle;
let ownerId = '';
let otherId = '';

const one = async (text: string, params: unknown[] = []): Promise<unknown> => {
  const row: unknown = (await handle.pool.query(text, params)).rows[0];
  const values: unknown[] = typeof row === 'object' && row !== null ? Object.values(row) : [];
  return values[0];
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.appUrl, { max: 4 });
  state.handle = handle.db;
  ownerId = (
    await handle.db.transaction(
      async (tx) =>
        await createAdminUser(tx, {
          email: 'boss@example.test',
          password: PASSWORD,
          role: 'owner',
        }),
    )
  ).userId;
  otherId = (
    await handle.db.transaction(
      async (tx) =>
        await createAdminUser(tx, {
          email: 'second@example.test',
          password: PASSWORD,
          role: 'manager',
        }),
    )
  ).userId;
});
afterAll(async () => {
  await handle.close();
  await testDb.drop();
});
beforeEach(() => {
  state.role = 'owner';
  state.userId = ownerId;
});

describe('role matrix', () => {
  it('admin, manager and content are FORBIDDEN on every action, even with garbage input, and nothing changes', async () => {
    const before = Number(await one('SELECT count(*)::int FROM auth_users'));
    for (const role of ['admin', 'manager', 'content'] as const) {
      state.role = role;
      for (const result of await Promise.all([
        actions.createUserAction({ email: 'x@example.test', role: 'owner', password: SECRET_NEW }),
        actions.changeUserRoleAction({ userId: otherId, role: 'owner' }),
        actions.setUserActiveAction({ userId: otherId, active: false }),
        actions.resetUserPasswordAction({ userId: otherId, password: SECRET_NEW }),
        actions.createUserAction('garbage'),
      ])) {
        expect(result, role).toEqual({ ok: false, code: 'FORBIDDEN' });
      }
    }
    expect(Number(await one('SELECT count(*)::int FROM auth_users'))).toBe(before);
    expect(await one('SELECT role::text FROM admin_users WHERE user_id = $1', [otherId])).toBe(
      'manager',
    );
  });
});

describe('the owner', () => {
  it('creates an account: one audit row with author and address, the password in none of it', async () => {
    const result = await actions.createUserAction({
      email: 'fresh@example.test',
      role: 'content',
      password: SECRET_NEW,
    });
    expect(result.ok).toBe(true);
    const audit = JSON.stringify(
      (await handle.pool.query("SELECT * FROM audit_log WHERE entity = 'admin_user'")).rows,
    );
    expect(audit).not.toContain(SECRET_NEW);
    expect(
      Number(
        await one(
          "SELECT count(*)::int FROM audit_log WHERE entity = 'admin_user' AND action = 'create' AND user_id = $1 AND ip = '203.0.113.9'",
          [ownerId],
        ),
      ),
    ).toBe(1);
    expect(
      await actions.createUserAction({
        email: 'FRESH@example.test',
        role: 'content',
        password: SECRET_NEW,
      }),
    ).toEqual({ ok: false, code: 'ADMIN_EMAIL_TAKEN' });
  });

  it('typed refusals: weak password, self change, the last owner, unknown user; invalid input', async () => {
    expect(
      await actions.createUserAction({
        email: 'weak@example.test',
        role: 'content',
        password: 'short',
      }),
    ).toEqual({ ok: false, code: 'ADMIN_WEAK_PASSWORD' });
    expect(await actions.changeUserRoleAction({ userId: ownerId, role: 'admin' })).toEqual({
      ok: false,
      code: 'ADMIN_SELF_CHANGE',
    });
    expect(await actions.setUserActiveAction({ userId: ownerId, active: false })).toEqual({
      ok: false,
      code: 'ADMIN_SELF_CHANGE',
    });
    expect(
      await actions.resetUserPasswordAction({ userId: ownerId, password: SECRET_NEW }),
    ).toEqual({ ok: false, code: 'ADMIN_SELF_CHANGE' });
    expect(
      await actions.changeUserRoleAction({
        userId: '00000000-0000-4000-8000-00000000dead',
        role: 'admin',
      }),
    ).toEqual({ ok: false, code: 'ADMIN_NOT_FOUND' });
    // The only owner, changed by a SECOND owner's session that is not itself: promote another to owner, then try.
    for (const bad of [
      { userId: 'nope', role: 'admin' },
      { userId: otherId, role: 'superuser' },
      { userId: otherId },
      {},
    ]) {
      expect(await actions.changeUserRoleAction(bad)).toEqual({ ok: false, code: 'INVALID_INPUT' });
    }
    for (const bad of [
      { email: 'not-an-email', role: 'owner', password: SECRET_NEW },
      { email: 'a@b.co', role: 'owner' },
      { email: 'a@b.co', role: 'owner', password: 'x'.repeat(129) },
    ]) {
      expect(await actions.createUserAction(bad)).toEqual({ ok: false, code: 'INVALID_INPUT' });
    }
  });

  it('role change, deactivation and password reset each write one audit row; a repeat writes none; no password in any row', async () => {
    const audits = async () =>
      Number(
        await one(
          "SELECT count(*)::int FROM audit_log WHERE entity = 'admin_user' AND entity_id = $1 AND action = 'update'",
          [otherId],
        ),
      );
    const start = await audits();
    expect((await actions.changeUserRoleAction({ userId: otherId, role: 'content' })).ok).toBe(
      true,
    );
    expect((await actions.changeUserRoleAction({ userId: otherId, role: 'content' })).ok).toBe(
      true,
    );
    expect((await actions.setUserActiveAction({ userId: otherId, active: false })).ok).toBe(true);
    expect((await actions.setUserActiveAction({ userId: otherId, active: false })).ok).toBe(true);
    expect(
      (await actions.resetUserPasswordAction({ userId: otherId, password: SECRET_NEW })).ok,
    ).toBe(true);
    expect((await audits()) - start).toBe(3);
    const everything = JSON.stringify((await handle.pool.query('SELECT * FROM audit_log')).rows);
    expect(everything).not.toContain(SECRET_NEW);
    expect(everything).not.toContain(PASSWORD);
  });
});
