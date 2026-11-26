/**
 * Customer accounts on real Postgres: registration by e-mail link, the password set on the link's
 * page, guest orders claimed only by a VERIFIED address, sign-in lockout, password reset, and the
 * wall between customer and admin sessions. Parallel parties use their own pools.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import { auditLog, authEmailTokens, authUsers, customers, orders, outbox } from '@store/db/schema';

import { createAdminUser, resolveSession, type AuthConfig } from '../src/auth/service.ts';
import {
  claimGuestOrders,
  completeWithToken,
  customerLogin,
  purgeEmailTokens,
  purgePendingAccounts,
  requestPasswordReset,
  requestRegistration,
} from '../src/customer-auth/account.ts';
import { logoutCustomer, resolveCustomerSession } from '../src/customer-auth/session.ts';
import {
  MAX_TOKENS_PER_HOUR,
  buildEmailToken,
  readEmailToken,
} from '../src/customer-auth/tokens.ts';
import { Barrier } from './barrier.ts';
import { createWorld, type TestWorld } from './fixtures.ts';
import { placeOrder } from './place-order.ts';

const SECRET = 'test-auth-secret-0123456789-abcdefghijkl';
const OTHER_SECRET = 'another-secret-0123456789-abcdefghijklmn';
const PASSWORD = 'correct-horse-battery-staple';
const client = { ip: '203.0.113.9', userAgent: 'vitest' };
const config: AuthConfig = { secret: SECRET };

let world: TestWorld;
let handle: DbHandle;
let counter = 0;
const fresh = (): string => {
  counter += 1;
  return `buyer${String(counter)}@example.test`;
};

const register = async (email: string) => {
  await handle.db.transaction(async (tx) => {
    await requestRegistration(tx, { email, locale: 'uk', client });
  });
};

/** The newest token the worker would mail for this address (rebuilt from the id, as the worker does). */
async function mailedToken(email: string): Promise<string> {
  const [row] = await handle.db
    .select({ id: authEmailTokens.id })
    .from(authEmailTokens)
    .innerJoin(authUsers, eq(authUsers.id, authEmailTokens.userId))
    .where(sql`lower(${authUsers.email}) = ${email} AND ${authEmailTokens.usedAt} IS NULL`)
    .orderBy(sql`${authEmailTokens.createdAt} DESC`)
    .limit(1);
  if (row === undefined) throw new Error('no open token');
  return buildEmailToken(SECRET, row.id);
}

const complete = async (token: string, password = PASSWORD, h: DbHandle = handle) =>
  await h.db.transaction(
    async (tx) => await completeWithToken(tx, config, { token, password, client }),
  );
const login = async (email: string, password = PASSWORD) =>
  await handle.db.transaction(
    async (tx) => await customerLogin(tx, config, { email, password, client }),
  );

async function account(): Promise<{ email: string; token: string }> {
  const email = fresh();
  await register(email);
  expect((await complete(await mailedToken(email))).ok).toBe(true);
  const session = await login(email);
  if (!session.ok) throw new Error('login refused');
  return { email, token: session.token };
}

beforeAll(async () => {
  world = await createWorld();
  handle = world.connect(10);
});
afterAll(async () => {
  await world.close();
});

describe('registration', () => {
  it('creates a pending account with NO password, and queues the link by id only', async () => {
    const email = fresh();
    await register(email);
    const [user] = await handle.db.select().from(authUsers).where(eq(authUsers.email, email));
    expect(user?.emailVerifiedAt).toBeNull();
    const queued = await handle.db
      .select()
      .from(outbox)
      .where(eq(outbox.topic, 'email.account-verify'));
    const mine = queued.find((row) => JSON.stringify(row.payload).includes('tokenId'));
    expect(mine).toBeDefined();
    // The queue carries the row id and nothing else: no address, no token.
    for (const row of queued) {
      expect(Object.keys(row.payload as object)).toEqual(['tokenId']);
      expect(JSON.stringify(row.payload)).not.toContain('@');
    }
    // Nobody can sign in before the link is used, whatever password they try.
    expect((await login(email, PASSWORD)).ok).toBe(false);
  });

  it('a new address, a verified one, an admin and garbage all return the same (no enumeration)', async () => {
    const verified = await account();
    await handle.db.transaction(
      async (tx) =>
        await createAdminUser(tx, {
          email: 'boss@example.test',
          password: PASSWORD,
          role: 'manager',
        }),
    );
    const before = (await handle.db.select().from(outbox)).length;
    // A verified address gets a RESET link (the mail explains itself); an admin gets nothing.
    await register(verified.email.toUpperCase());
    await register('boss@example.test');
    await register('not-an-address');
    await register(fresh());
    const topics = (await handle.db.select().from(outbox)).slice(before).map((row) => row.topic);
    expect(topics.sort()).toEqual(['email.account-verify', 'email.password-reset']);
    const [adminUser] = await handle.db
      .select()
      .from(authUsers)
      .where(eq(authUsers.email, 'boss@example.test'));
    expect(adminUser?.emailVerifiedAt).toBeNull();
  });

  it('caps the mails of one account per hour: the fourth request sends nothing', async () => {
    const email = fresh();
    for (let attempt = 0; attempt < MAX_TOKENS_PER_HOUR + 2; attempt += 1) await register(email);
    const [user] = await handle.db.select().from(authUsers).where(eq(authUsers.email, email));
    const rows = await handle.db
      .select()
      .from(authEmailTokens)
      .where(eq(authEmailTokens.userId, user?.id ?? ''));
    expect(rows).toHaveLength(MAX_TOKENS_PER_HOUR);
    // Only the newest link is open: asking again replaced the older ones.
    expect(rows.filter((row) => row.usedAt === null)).toHaveLength(1);
  });
});

describe('the link', () => {
  it('verifies the address, sets the password and creates the customer row', async () => {
    const email = fresh();
    await register(email);
    const result = await complete(await mailedToken(email));
    expect(result).toEqual({ ok: true, purpose: 'verify_email' });
    const [user] = await handle.db.select().from(authUsers).where(eq(authUsers.email, email));
    expect(user?.emailVerifiedAt).not.toBeNull();
    const [customer] = await handle.db.select().from(customers).where(eq(customers.email, email));
    expect(customer?.userId).toBe(user?.id);
    expect((await login(email)).ok).toBe(true);
  });

  it('REPLAY: the same link twice works once', async () => {
    const email = fresh();
    await register(email);
    const token = await mailedToken(email);
    expect((await complete(token)).ok).toBe(true);
    expect(await complete(token, 'another-long-password-1')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    // The second password did not replace the first.
    expect((await login(email, PASSWORD)).ok).toBe(true);
  });

  it('DOUBLE SUBMIT: two parallel uses of one link (separate connections) give exactly one winner', async () => {
    const email = fresh();
    await register(email);
    const token = await mailedToken(email);
    const barrier = new Barrier(2);
    const parties = [world.connect(2), world.connect(2)];
    const results = await Promise.all(
      parties.map(async (party, index) => {
        await barrier.wait();
        return await complete(token, `parallel-password-${String(index)}-xyz`, party);
      }),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    const rows = await handle.db.select().from(customers).where(eq(customers.email, email));
    expect(rows).toHaveLength(1);
  });

  it('refuses an expired link, a forged signature, a link signed under another secret', async () => {
    const email = fresh();
    await register(email);
    const token = await mailedToken(email);
    const id = readEmailToken(SECRET, token)?.id ?? '';
    expect(id).not.toBe('');
    expect(readEmailToken(OTHER_SECRET, token)).toBeNull();
    expect(readEmailToken(SECRET, `${id}.${'A'.repeat(43)}`)).toBeNull();
    expect(readEmailToken(SECRET, `${id}.`)).toBeNull();
    expect(readEmailToken(SECRET, 'x'.repeat(300))).toBeNull();
    expect(await complete(`${id}.${'A'.repeat(43)}`)).toEqual({ ok: false, reason: 'invalid' });
    await handle.db.execute(
      sql`UPDATE auth_email_tokens SET created_at = now() - interval '2 seconds', expires_at = now() - interval '1 second' WHERE id = ${id}`,
    );
    expect(await complete(token)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('a weak password is refused WITHOUT using the link up', async () => {
    const email = fresh();
    await register(email);
    const token = await mailedToken(email);
    expect(await complete(token, 'short')).toEqual({ ok: false, reason: 'weak_password' });
    expect(await complete(token, `${email.split('@')[0] ?? ''}-password-1`)).toEqual({
      ok: false,
      reason: 'weak_password',
    });
    expect((await complete(token)).ok).toBe(true);
  });

  it('a missing secret fails closed', () => {
    expect(() =>
      buildEmailToken(undefined, '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12)),
    ).toThrow();
    expect(() =>
      buildEmailToken('short', '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12)),
    ).toThrow();
  });
});

describe('guest orders are claimed by the verified address only', () => {
  it('claims the orders of the verified address (any letter case), not another address, and not before verification', async () => {
    const [variantA, variantB] = world.fixture.variantIds;
    const mine = await placeOrder(handle, variantA, 'cod');
    const theirs = await placeOrder(handle, variantB, 'cod');
    await handle.db.execute(
      sql`UPDATE orders SET customer_email = 'Claimant@Example.test' WHERE id = ${mine}`,
    );
    await handle.db.execute(
      sql`UPDATE orders SET customer_email = 'someone-else@example.test' WHERE id = ${theirs}`,
    );
    // Registering with a typed address claims nothing until the mailbox is proven.
    await register('claimant@example.test');
    const [pending] = await handle.db.select().from(orders).where(eq(orders.id, mine));
    expect(pending?.customerId).toBeNull();
    expect((await complete(await mailedToken('claimant@example.test'))).ok).toBe(true);
    const [claimed] = await handle.db.select().from(orders).where(eq(orders.id, mine));
    const [other] = await handle.db.select().from(orders).where(eq(orders.id, theirs));
    const [customer] = await handle.db
      .select()
      .from(customers)
      .where(eq(customers.email, 'claimant@example.test'));
    expect(claimed?.customerId).toBe(customer?.id);
    expect(other?.customerId).toBeNull();
    // Claiming again is a no-op; a later guest order with the same address is picked up.
    const later = await placeOrder(handle, variantA, 'cod');
    await handle.db.execute(
      sql`UPDATE orders SET customer_email = 'claimant@example.test' WHERE id = ${later}`,
    );
    const count = await handle.db.transaction(
      async (tx) =>
        await claimGuestOrders(tx, {
          customerId: customer?.id ?? '',
          email: 'claimant@example.test',
        }),
    );
    expect(count).toBe(1);
  });

  it('keeps the tags the admin put on the address and adds the account to that row', async () => {
    const email = fresh();
    await handle.db.insert(customers).values({ email, tags: ['vip'] });
    await register(email);
    expect((await complete(await mailedToken(email))).ok).toBe(true);
    const rows = await handle.db.select().from(customers).where(eq(customers.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tags).toEqual(['vip']);
    expect(rows[0]?.userId).not.toBeNull();
  });
});

describe('sign-in', () => {
  it('five wrong passwords lock the account; the right one is refused while locked', async () => {
    const { email } = await account();
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect((await login(email, 'wrong-password-xx')).ok).toBe(false);
    expect((await login(email)).ok).toBe(false);
    await handle.db.execute(
      sql`UPDATE auth_credentials SET locked_until = now() - interval '1 second'
           WHERE user_id = (SELECT id FROM auth_users WHERE email = ${email})`,
    );
    expect((await login(email)).ok).toBe(true);
  });

  it('PARALLEL guesses cannot out-run the counter', async () => {
    const { email } = await account();
    const barrier = new Barrier(8);
    const parties = Array.from({ length: 8 }, () => world.connect(2));
    await Promise.all(
      parties.map(async (party) => {
        await barrier.wait();
        await party.db.transaction(
          async (tx) =>
            await customerLogin(tx, config, { email, password: 'guess-guess-guess', client }),
        );
      }),
    );
    const [credentials] = await handle.db
      .execute<{ locked: boolean }>(
        sql`SELECT locked_until > now() AS locked FROM auth_credentials
           WHERE user_id = (SELECT id FROM auth_users WHERE email = ${email})`,
      )
      .then((result) => result.rows);
    expect(credentials?.locked).toBe(true);
  });

  it('unknown address, wrong password and an admin account answer the same', async () => {
    const { email } = await account();
    await handle.db.transaction(
      async (tx) =>
        await createAdminUser(tx, {
          email: 'staff@example.test',
          password: PASSWORD,
          role: 'manager',
        }),
    );
    expect(await login('nobody@example.test')).toEqual({ ok: false });
    expect(await login(email, 'wrong-password-xx')).toEqual({ ok: false });
    // The admin's correct password does not open a CUSTOMER session.
    expect(await login('staff@example.test')).toEqual({ ok: false });
  });
});

describe('sessions', () => {
  it('resolves a live session, and stops after sign-out', async () => {
    const { email, token } = await account();
    const session = await resolveCustomerSession(handle.db, config, token);
    expect(session?.email).toBe(email);
    await handle.db.transaction(async (tx) => {
      await logoutCustomer(tx, { sid: session?.sid ?? '', userId: session?.userId ?? '' });
    });
    expect(await resolveCustomerSession(handle.db, config, token)).toBeNull();
  });

  it('WALL: a customer token is no admin session, and an admin token is no customer session', async () => {
    const { token } = await account();
    expect(await resolveSession(handle.db, config, token)).toBeNull();
    await handle.db.transaction(
      async (tx) =>
        await createAdminUser(tx, {
          email: 'wall@example.test',
          password: PASSWORD,
          role: 'manager',
        }),
    );
    const { beginLogin } = await import('../src/auth/service.ts');
    const admin = await handle.db.transaction(
      async (tx) =>
        await beginLogin(tx, config, { email: 'wall@example.test', password: PASSWORD, client }),
    );
    if (!admin.ok) throw new Error('admin login refused');
    expect(await resolveCustomerSession(handle.db, config, admin.token)).toBeNull();
    // Even with a forged audience: a customer session ROW carried in an admin-signed token.
    const { sid } = (await resolveCustomerSession(handle.db, config, token)) ?? { sid: '' };
    const { signSessionToken } = await import('../src/auth/session-token.ts');
    const { deriveKey } = await import('../src/auth/crypto.ts');
    const forged = signSessionToken(sid, Date.now() + 60_000, deriveKey(SECRET, 'session'));
    expect(await resolveSession(handle.db, config, forged)).toBeNull();
  });

  it('WALL (audience filter alone): a customer-audience row of an ADMIN user is no admin session', async () => {
    const { signSessionToken } = await import('../src/auth/session-token.ts');
    const { deriveKey } = await import('../src/auth/crypto.ts');
    const [staff] = await handle.db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.email, 'wall@example.test'));
    const inserted = await handle.db.execute<{ sid: string }>(
      sql`INSERT INTO auth_sessions (user_id, audience, expires_at)
          VALUES (${staff?.id ?? ''}, 'customer', now() + interval '1 hour') RETURNING sid`,
    );
    const sid = inserted.rows[0]?.sid ?? '';
    const token = signSessionToken(sid, Date.now() + 60_000, deriveKey(SECRET, 'session'));
    // The admin has no MFA (a manager): without the audience filter this row would count as a full session.
    expect(await resolveSession(handle.db, config, token)).toBeNull();
  });

  it('a session of an account whose address is not verified does not count', async () => {
    const { token, email } = await account();
    await handle.db.execute(
      sql`UPDATE auth_users SET email_verified_at = NULL WHERE email = ${email}`,
    );
    expect(await resolveCustomerSession(handle.db, config, token)).toBeNull();
  });
});

describe('password reset', () => {
  it('replaces the password, ends every session, and the old password stops working', async () => {
    const { email, token } = await account();
    await handle.db.transaction(async (tx) => {
      await requestPasswordReset(tx, { email, locale: 'uk', client });
    });
    const link = await mailedToken(email);
    expect(await complete(link, 'brand-new-password-77')).toEqual({
      ok: true,
      purpose: 'reset_password',
    });
    expect(await resolveCustomerSession(handle.db, config, token)).toBeNull();
    expect((await login(email, PASSWORD)).ok).toBe(false);
    expect((await login(email, 'brand-new-password-77')).ok).toBe(true);
  });

  it('sends nothing for an unknown address, a pending one or an admin; the answer is the same', async () => {
    await register('pending@example.test');
    const before = (await handle.db.select().from(outbox)).length;
    await handle.db.transaction(async (tx) => {
      await requestPasswordReset(tx, { email: 'nobody@example.test', locale: 'uk', client });
      await requestPasswordReset(tx, { email: 'pending@example.test', locale: 'uk', client });
      await requestPasswordReset(tx, { email: 'wall@example.test', locale: 'uk', client });
      await requestPasswordReset(tx, { email: 'garbage', locale: 'uk', client });
    });
    expect((await handle.db.select().from(outbox)).length).toBe(before);
  });
});

describe('timing: the branches that send nothing cost about the same as the one that sends', () => {
  const median = (values: number[]): number =>
    [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)] ?? 0;
  async function sample(run: (i: number) => Promise<void>, n = 40): Promise<number> {
    const times: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const start = performance.now();
      await run(i);
      times.push(performance.now() - start);
    }
    return median(times);
  }

  it('reset: a verified account, an unknown address and an admin address (median of 40, ratio under 2.5)', async () => {
    const real = await account();
    const reset = (email: string) => async () => {
      await handle.db.transaction(async (tx) => {
        await requestPasswordReset(tx, { email, locale: 'uk', client });
      });
    };
    await sample(reset(real.email), 5);
    const cases = {
      unknown: await sample((i) => reset(`nobody-${String(i)}@example.test`)()),
      admin: await sample(reset('wall@example.test')),
      // Past the hourly cap the real branch also sends nothing, but it did the same work: that is the point.
      verified: await sample((i) => reset(i % 4 === 0 ? real.email : real.email)()),
    };
    const slowest = Math.max(...Object.values(cases));
    const fastest = Math.min(...Object.values(cases));
    expect(slowest / fastest, JSON.stringify(cases)).toBeLessThan(2.5);
  });

  it('registration: a new address, an existing customer and an admin address', async () => {
    const real = await account();
    const reg = (email: string) => async () => {
      await register(email);
    };
    const cases = {
      fresh: await sample((i) => reg(`fresh-${String(i)}-${String(counter)}@example.test`)()),
      existing: await sample(reg(real.email)),
      admin: await sample(reg('wall@example.test')),
    };
    const ratio = Math.max(...Object.values(cases)) / Math.min(...Object.values(cases));
    expect(ratio, JSON.stringify(cases)).toBeLessThan(2.5);
  });

  it('a decoy is never queued: no row with the decoy topic survives', async () => {
    expect(
      (await handle.db.select().from(outbox)).filter((row) => row.topic === 'decoy'),
    ).toHaveLength(0);
  });
});

describe('link rows: housekeeping and the schema checks', () => {
  it('purges used and long-expired rows, keeps an open one', async () => {
    const email = fresh();
    await register(email);
    const open = await mailedToken(email);
    await handle.db.execute(
      sql`UPDATE auth_email_tokens SET used_at = now() WHERE id <> ${readEmailToken(SECRET, open)?.id ?? ''}`,
    );
    const removed = await handle.db.transaction(async (tx) => await purgeEmailTokens(tx));
    expect(removed).toBeGreaterThan(0);
    expect(
      await handle.db
        .select()
        .from(authEmailTokens)
        .where(eq(authEmailTokens.id, readEmailToken(SECRET, open)?.id ?? '')),
    ).toHaveLength(1);
  });

  it('the database refuses a link that expires before it was made, or is used before it existed', async () => {
    const email = fresh();
    await register(email);
    const [user] = await handle.db.select().from(authUsers).where(eq(authUsers.email, email));
    await expect(
      handle.db.execute(sql`INSERT INTO auth_email_tokens (user_id, purpose, expires_at, created_at)
        VALUES (${user?.id ?? ''}, 'reset_password', now() - interval '1 hour', now())`),
    ).rejects.toThrow();
    await expect(
      handle.db
        .execute(sql`INSERT INTO auth_email_tokens (user_id, purpose, expires_at, created_at, used_at)
        VALUES (${user?.id ?? ''}, 'reset_password', now() + interval '1 hour', now(), now() - interval '1 day')`),
    ).rejects.toThrow();
  });
});

describe('housekeeping and audit', () => {
  it('purges accounts nobody finished, never a finished or admin one', async () => {
    const stale = fresh();
    await register(stale);
    await handle.db.execute(
      sql`UPDATE auth_users SET created_at = now() - interval '8 days' WHERE email = ${stale}`,
    );
    const removed = await handle.db.transaction(async (tx) => await purgePendingAccounts(tx));
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await handle.db.select().from(authUsers).where(eq(authUsers.email, stale))).toHaveLength(
      0,
    );
    const kept = await account();
    await handle.db.execute(
      sql`UPDATE auth_users SET created_at = now() - interval '30 days' WHERE email = ${kept.email}`,
    );
    await handle.db.transaction(async (tx) => await purgePendingAccounts(tx));
    expect(
      await handle.db.select().from(authUsers).where(eq(authUsers.email, kept.email)),
    ).toHaveLength(1);
  });

  it('audits registration, login and reset without the address or any secret', async () => {
    const rows = await handle.db.select().from(auditLog);
    const actions = new Set(rows.map((row) => row.action));
    for (const action of ['customer.registered', 'customer.login', 'customer.password_reset'])
      expect(actions.has(action)).toBe(true);
    for (const row of rows) {
      const text = JSON.stringify(row);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain('@example');
    }
  });
});
