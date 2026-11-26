/**
 * The owner's user management on real Postgres: the last-owner rule under a race, self-change
 * refusals, sessions ended by every account change, passwords never stored in clear or audited.
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';

import { AdminNotFoundError } from '../src/catalog-admin/errors.ts';
import { beginLogin, createAdminUser, type AuthConfig } from '../src/auth/service.ts';
import {
  EmailTakenError,
  LastOwnerError,
  SelfChangeError,
  WeakPasswordDomainError,
  changeUserRole,
  createUser,
  listAdminUsers,
  liveSessionCount,
  resetUserPassword,
  setUserActive,
} from '../src/auth/users-admin.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

const config: AuthConfig = { secret: 'test-auth-secret-0123456789-abcdefghijkl' };
const PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'another-long-passphrase-2026';
const client = { ip: '203.0.113.9', userAgent: 'vitest' };

let world: TestWorld;
let db: DbHandle;
let seq = 0;

beforeEach(async () => {
  world = await createWorld();
  db = world.connect(4);
});
afterEach(async () => {
  await world.close();
});

async function user(role: 'owner' | 'admin' | 'manager' | 'content') {
  seq += 1;
  const email = `${role}${String(seq)}@example.test`;
  const { userId } = await db.db.transaction(
    async (tx) => await createAdminUser(tx, { email, password: PASSWORD, role }),
  );
  return { email, userId };
}
const login = async (email: string, password: string) =>
  await db.db.transaction(async (tx) => await beginLogin(tx, config, { email, password, client }));
const roleOf = async (userId: string) =>
  (
    await db.db.execute<{ role: string }>(
      sql`SELECT role::text AS role FROM admin_users WHERE user_id = ${userId}`,
    )
  ).rows[0]?.role;

describe('create', () => {
  it('stores a hash, the role and a working login; the password is nowhere in clear', async () => {
    const owner = await user('owner');
    const { userId } = await db.db.transaction(
      async (tx) =>
        await createUser(tx, {
          email: 'New.Person@Example.test',
          password: NEW_PASSWORD,
          role: 'manager',
          actorId: owner.userId,
        }),
    );
    expect(await roleOf(userId)).toBe('manager');
    expect((await login('new.person@example.test', NEW_PASSWORD)).ok).toBe(true);
    const everything = JSON.stringify([
      (await db.db.execute(sql`SELECT * FROM auth_credentials`)).rows,
      (await db.db.execute(sql`SELECT * FROM audit_log`)).rows,
    ]);
    expect(everything).not.toContain(NEW_PASSWORD);
    // The action writes the audit row (author and address): the domain wrote none.
    expect(
      (
        await db.db.execute(
          sql`SELECT 1 FROM audit_log WHERE entity = 'admin_user' AND entity_id = ${userId}`,
        )
      ).rows,
    ).toHaveLength(0);
  });

  it('refuses a duplicate email in any case, a weak password and one with the email name; nothing is created', async () => {
    const owner = await user('owner');
    const before = (await listAdminUsers(db.db)).length;
    const create = async (email: string, password: string) =>
      await db.db.transaction(
        async (tx) =>
          await createUser(tx, { email, password, role: 'content', actorId: owner.userId }),
      );
    await expect(create(owner.email.toUpperCase(), NEW_PASSWORD)).rejects.toBeInstanceOf(
      EmailTakenError,
    );
    await expect(create('short@example.test', 'short')).rejects.toBeInstanceOf(
      WeakPasswordDomainError,
    );
    await expect(
      create('maria.petrenko@example.test', 'xx-maria.petrenko-xx-2026'),
    ).rejects.toBeInstanceOf(WeakPasswordDomainError);
    expect((await listAdminUsers(db.db)).length).toBe(before);
  });

  it('two creations of one email at once: one account, the other a typed refusal', async () => {
    const owner = await user('owner');
    const barrier = new Barrier(2);
    const attempt = async () => {
      const h = world.connect();
      try {
        return await h.db.transaction(async (tx) => {
          await barrier.wait();
          return await createUser(tx, {
            email: 'race@example.test',
            password: NEW_PASSWORD,
            role: 'content',
            actorId: owner.userId,
          });
        });
      } catch (error) {
        return error;
      }
    };
    const results = await Promise.all([attempt(), attempt()]);
    expect(results.filter((r) => r instanceof EmailTakenError)).toHaveLength(1);
    expect(
      (await db.db.execute(sql`SELECT 1 FROM auth_users WHERE email = 'race@example.test'`)).rows,
    ).toHaveLength(1);
  });
});

describe('the list', () => {
  it('has an explicit field list: no hash, no secret, no token', async () => {
    const owner = await user('owner');
    const manager = await user('manager');
    await login(manager.email, PASSWORD);
    const rows = await listAdminUsers(db.db);
    const json = JSON.stringify(rows);
    expect(json).not.toMatch(/argon|passwordHash|secret|token|\$argon/i);
    expect(rows.find((r) => r.userId === manager.userId)).toMatchObject({
      role: 'manager',
      isActive: true,
      mfaConfirmed: false,
      liveSessions: 1,
    });
    expect(rows.find((r) => r.userId === owner.userId)?.liveSessions).toBe(0);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      'createdAt',
      'email',
      'isActive',
      'lastLoginAt',
      'liveSessions',
      'mfaConfirmed',
      'role',
      'userId',
    ]);
  });
});

describe('role, status and password', () => {
  it('a role change ends every session of that person; the same role is a no-op; a person cannot change themselves', async () => {
    const owner = await user('owner');
    const manager = await user('manager');
    await login(manager.email, PASSWORD);
    await login(manager.email, PASSWORD);
    expect(await liveSessionCount(db.db, manager.userId)).toBe(2);
    expect(
      (
        await db.db.transaction(
          async (tx) =>
            await changeUserRole(tx, {
              userId: manager.userId,
              role: 'manager',
              actorId: owner.userId,
            }),
        )
      ).changed,
    ).toBe(false);
    expect(await liveSessionCount(db.db, manager.userId)).toBe(2);
    const done = await db.db.transaction(
      async (tx) =>
        await changeUserRole(tx, {
          userId: manager.userId,
          role: 'content',
          actorId: owner.userId,
        }),
    );
    expect(done).toMatchObject({ changed: true, from: 'manager', to: 'content' });
    expect(await roleOf(manager.userId)).toBe('content');
    expect(await liveSessionCount(db.db, manager.userId)).toBe(0);
    await expect(
      db.db.transaction(
        async (tx) =>
          await changeUserRole(tx, { userId: owner.userId, role: 'admin', actorId: owner.userId }),
      ),
    ).rejects.toBeInstanceOf(SelfChangeError);
    await expect(
      db.db.transaction(
        async (tx) =>
          await changeUserRole(tx, {
            userId: '00000000-0000-4000-8000-00000000dead',
            role: 'admin',
            actorId: owner.userId,
          }),
      ),
    ).rejects.toBeInstanceOf(AdminNotFoundError);
  });

  it('the last active owner cannot be demoted or deactivated; with a second owner it can', async () => {
    const a = await user('owner');
    const b = await user('admin');
    await expect(
      db.db.transaction(
        async (tx) =>
          await changeUserRole(tx, { userId: a.userId, role: 'admin', actorId: b.userId }),
      ),
    ).rejects.toBeInstanceOf(LastOwnerError);
    await expect(
      db.db.transaction(
        async (tx) =>
          await setUserActive(tx, { userId: a.userId, active: false, actorId: b.userId }),
      ),
    ).rejects.toBeInstanceOf(LastOwnerError);
    expect(await roleOf(a.userId)).toBe('owner');
    const c = await user('owner');
    expect(
      (
        await db.db.transaction(
          async (tx) =>
            await changeUserRole(tx, { userId: a.userId, role: 'admin', actorId: c.userId }),
        )
      ).changed,
    ).toBe(true);
  });

  it('two owners demoting each other at once: exactly one owner remains (separate connections)', async () => {
    const a = await user('owner');
    const b = await user('owner');
    const barrier = new Barrier(2);
    const demote = async (target: string, actor: string) => {
      const h = world.connect();
      try {
        return await h.db.transaction(async (tx) => {
          await barrier.wait();
          return await changeUserRole(tx, { userId: target, role: 'admin', actorId: actor });
        });
      } catch (error) {
        return error;
      }
    };
    const results = await Promise.all([demote(b.userId, a.userId), demote(a.userId, b.userId)]);
    expect(results.filter((r) => r instanceof LastOwnerError)).toHaveLength(1);
    const owners = (
      await db.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM admin_users WHERE role = 'owner' AND is_active`,
      )
    ).rows[0]?.n;
    expect(owners).toBe(1);
  });

  it('deactivating ends sessions and blocks sign-in; activating restores it', async () => {
    const owner = await user('owner');
    const manager = await user('manager');
    await login(manager.email, PASSWORD);
    await db.db.transaction(
      async (tx) =>
        await setUserActive(tx, { userId: manager.userId, active: false, actorId: owner.userId }),
    );
    expect(await liveSessionCount(db.db, manager.userId)).toBe(0);
    expect((await login(manager.email, PASSWORD)).ok).toBe(false);
    expect(
      (
        await db.db.transaction(
          async (tx) =>
            await setUserActive(tx, {
              userId: manager.userId,
              active: false,
              actorId: owner.userId,
            }),
        )
      ).changed,
    ).toBe(false);
    await db.db.transaction(
      async (tx) =>
        await setUserActive(tx, { userId: manager.userId, active: true, actorId: owner.userId }),
    );
    expect((await login(manager.email, PASSWORD)).ok).toBe(true);
    await expect(
      db.db.transaction(
        async (tx) =>
          await setUserActive(tx, { userId: owner.userId, active: false, actorId: owner.userId }),
      ),
    ).rejects.toBeInstanceOf(SelfChangeError);
  });

  it('a password reset ends sessions, lifts a lockout, makes the old password useless and is never stored in clear', async () => {
    const owner = await user('owner');
    const manager = await user('manager');
    await login(manager.email, PASSWORD);
    for (let i = 0; i < 5; i += 1) await login(manager.email, 'wrong-password-wrong');
    expect((await login(manager.email, PASSWORD)).ok).toBe(false); // locked
    await db.db.transaction(
      async (tx) =>
        await resetUserPassword(tx, {
          userId: manager.userId,
          password: NEW_PASSWORD,
          actorId: owner.userId,
        }),
    );
    expect(await liveSessionCount(db.db, manager.userId)).toBe(0);
    expect((await login(manager.email, PASSWORD)).ok).toBe(false);
    expect((await login(manager.email, NEW_PASSWORD)).ok).toBe(true);
    expect(
      JSON.stringify((await db.db.execute(sql`SELECT * FROM auth_credentials`)).rows),
    ).not.toContain(NEW_PASSWORD);
    await expect(
      db.db.transaction(
        async (tx) =>
          await resetUserPassword(tx, {
            userId: manager.userId,
            password: 'short',
            actorId: owner.userId,
          }),
      ),
    ).rejects.toBeInstanceOf(WeakPasswordDomainError);
    await expect(
      db.db.transaction(
        async (tx) =>
          await resetUserPassword(tx, {
            userId: owner.userId,
            password: NEW_PASSWORD,
            actorId: owner.userId,
          }),
      ),
    ).rejects.toBeInstanceOf(SelfChangeError);
  });
});
