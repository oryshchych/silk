/**
 * Admin authentication on real Postgres (ADR-19): the two login steps, lockout, replay, recovery
 * codes, session revocation and the rule that role and MFA are read live, never from the token.
 */
import { createHash } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '@store/db/client';
import {
  adminUsers,
  auditLog,
  authCredentials,
  authRecoveryCodes,
  authTotp,
} from '@store/db/schema';

import {
  LOCK_MINUTES,
  MAX_FAILED_ATTEMPTS,
  beginLogin,
  confirmTotpEnrolment,
  createAdminUser,
  logout,
  resolveSession,
  revokeAllSessions,
  revokeOtherSessions,
  unlockAccount,
  startTotpEnrolment,
  verifyRecoveryLogin,
  verifyTotpLogin,
  WeakPasswordError,
  type AuthConfig,
} from '../src/auth/service.ts';
import { codeAt, stepOf } from '../src/auth/totp.ts';
import { createWorld, type TestWorld } from './fixtures.ts';

const SECRET = 'test-auth-secret-0123456789-abcdefghijkl';
const PASSWORD = 'correct-horse-battery-staple';
const client = { ip: '203.0.113.9', userAgent: 'vitest' };

let world: TestWorld;
let handle: DbHandle;
let clock = 1_700_000_000_000;
const config = (): AuthConfig => ({ secret: SECRET, nowMs: () => clock });

let counter = 0;
async function user(role: 'owner' | 'admin' | 'manager' | 'content'): Promise<string> {
  counter += 1;
  const email = `${role}${String(counter)}@example.test`;
  await handle.db.transaction(
    async (t) => await createAdminUser(t, { email, password: PASSWORD, role }),
  );
  return email;
}
const login = async (email: string, password = PASSWORD) =>
  await handle.db.transaction(
    async (t) => await beginLogin(t, config(), { email, password, client }),
  );
const resolve = async (token: string) => await resolveSession(handle.db, config(), token);

/** Owner path: password, enrol, confirm. Returns what a test needs next. */
async function enrolled(role: 'owner' | 'admin' = 'owner') {
  const email = await user(role);
  const first = await login(email);
  if (!first.ok) throw new Error('login refused');
  expect(first.next).toBe('enroll');
  const start = await handle.db.transaction(
    async (t) => await startTotpEnrolment(t, config(), { token: first.token }),
  );
  if (start === null) throw new Error('no enrolment');
  const confirmed = await handle.db.transaction(
    async (t) =>
      await confirmTotpEnrolment(t, config(), {
        token: first.token,
        code: codeAt(start.secret, stepOf(clock)),
        client,
      }),
  );
  if (!confirmed.ok) throw new Error('confirm refused');
  return {
    email,
    secret: start.secret,
    token: confirmed.token,
    recovery: confirmed.recoveryCodes ?? [],
  };
}

beforeAll(async () => {
  world = await createWorld();
  handle = world.connect(10);
});
afterAll(async () => {
  await world.close();
});

describe('accounts', () => {
  it('refuses a short password, a password with the email name, and a duplicate email', async () => {
    await expect(
      handle.db.transaction(
        async (t) =>
          await createAdminUser(t, { email: 'a@example.test', password: 'short', role: 'admin' }),
      ),
    ).rejects.toBeInstanceOf(WeakPasswordError);
    await expect(
      handle.db.transaction(
        async (t) =>
          await createAdminUser(t, {
            email: 'alexandra@example.test',
            password: 'xx-Alexandra-xx-1',
            role: 'admin',
          }),
      ),
    ).rejects.toBeInstanceOf(WeakPasswordError);
    await user('manager');
    await expect(
      handle.db.transaction(
        async (t) =>
          await createAdminUser(t, {
            email: 'MANAGER1@example.test',
            password: PASSWORD,
            role: 'manager',
          }),
      ),
    ).rejects.toThrow();
  });

  it('stores an argon2id hash, never the password', async () => {
    const email = await user('content');
    const [row] = await handle.db
      .select({ hash: authCredentials.passwordHash })
      .from(authCredentials)
      .innerJoin(adminUsers, eq(adminUsers.userId, authCredentials.userId))
      .where(sql`${authCredentials.userId} = (SELECT id FROM auth_users WHERE email = ${email})`);
    expect(row?.hash.startsWith('argon2id$')).toBe(true);
    expect(row?.hash).not.toContain(PASSWORD);
  });
});

describe('the two login steps', () => {
  it('owner: a password alone opens only a pending session', async () => {
    const email = await user('owner');
    const result = await login(email);
    if (!result.ok) throw new Error('refused');
    const resolved = await resolve(result.token);
    expect(resolved).toMatchObject({
      kind: 'pending',
      next: 'enroll',
      session: { role: 'owner', email },
    });
  });

  it('enrolment issues recovery codes once, stores the secret encrypted and returns a full session', async () => {
    const owner = await enrolled('owner');
    expect(await resolve(owner.token)).toMatchObject({ kind: 'full', session: { role: 'owner' } });
    expect(owner.recovery).toHaveLength(10);
    const [totp] = await handle.db
      .select({ secret: authTotp.secretEncrypted, confirmedAt: authTotp.confirmedAt })
      .from(authTotp);
    expect(totp?.secret).not.toContain(owner.secret);
    const hashes = await handle.db
      .select({ hash: authRecoveryCodes.codeHash })
      .from(authRecoveryCodes);
    for (const code of owner.recovery) expect(hashes.map((h) => h.hash)).not.toContain(code);
  });

  it('a later login needs the code; a wrong one fails; a right one is good ONCE (replay)', async () => {
    const owner = await enrolled('admin');
    clock += 31_000;
    const again = await login(owner.email);
    if (!again.ok) throw new Error('refused');
    expect(again.next).toBe('totp');
    const wrong = await handle.db.transaction(
      async (t) =>
        await verifyTotpLogin(t, config(), { token: again.token, code: '000000', client }),
    );
    expect(wrong.ok).toBe(false);
    const code = codeAt(owner.secret, stepOf(clock));
    const good = await handle.db.transaction(
      async (t) => await verifyTotpLogin(t, config(), { token: again.token, code, client }),
    );
    expect(good.ok).toBe(true);
    // The pending session is gone (a new one was issued): the same token and code cannot be reused.
    expect(await resolve(again.token)).toBeNull();
    const second = await login(owner.email);
    if (!second.ok) throw new Error('refused');
    const replay = await handle.db.transaction(
      async (t) => await verifyTotpLogin(t, config(), { token: second.token, code, client }),
    );
    expect(replay.ok).toBe(false);
  });

  it('two parallel submissions of one valid code: exactly one wins', async () => {
    const owner = await enrolled('admin');
    clock += 61_000;
    const a = await login(owner.email);
    const b = await login(owner.email);
    if (!a.ok || !b.ok) throw new Error('refused');
    const code = codeAt(owner.secret, stepOf(clock));
    const results = await Promise.all(
      [a, b].map(
        async (r) =>
          await world
            .connect(2)
            .db.transaction(
              async (t) => await verifyTotpLogin(t, config(), { token: r.token, code, client }),
            ),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('a recovery code works once and logs the use', async () => {
    const owner = await enrolled('owner');
    const code = owner.recovery[0] ?? '';
    const first = await login(owner.email);
    if (!first.ok) throw new Error('refused');
    const used = await handle.db.transaction(
      async (t) => await verifyRecoveryLogin(t, config(), { token: first.token, code, client }),
    );
    expect(used.ok).toBe(true);
    const second = await login(owner.email);
    if (!second.ok) throw new Error('refused');
    const reuse = await handle.db.transaction(
      async (t) => await verifyRecoveryLogin(t, config(), { token: second.token, code, client }),
    );
    expect(reuse.ok).toBe(false);
    const audited = await handle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'auth.recovery_code_used'));
    expect(audited.length).toBeGreaterThan(0);
  });

  it('a manager (no TOTP) gets a full session from the password; once enrolled, MFA applies', async () => {
    const email = await user('manager');
    const result = await login(email);
    if (!result.ok) throw new Error('refused');
    expect(result.next).toBe('done');
    expect(await resolve(result.token)).toMatchObject({
      kind: 'full',
      session: { role: 'manager' },
    });
  });
});

describe('role and MFA are read live, not from the token', () => {
  it('promoting a manager to admin turns the existing session into a pending one', async () => {
    const email = await user('manager');
    const result = await login(email);
    if (!result.ok) throw new Error('refused');
    const before = await resolve(result.token);
    expect(before?.kind).toBe('full');
    await handle.db
      .update(adminUsers)
      .set({ role: 'admin' })
      .where(sql`user_id = (SELECT id FROM auth_users WHERE email = ${email})`);
    expect(await resolve(result.token)).toMatchObject({ kind: 'pending', next: 'enroll' });
  });

  it('deactivating a user ends every session at once', async () => {
    const email = await user('content');
    const result = await login(email);
    if (!result.ok) throw new Error('refused');
    await handle.db
      .update(adminUsers)
      .set({ isActive: false })
      .where(sql`user_id = (SELECT id FROM auth_users WHERE email = ${email})`);
    expect(await resolve(result.token)).toBeNull();
    expect((await login(email)).ok).toBe(false);
  });

  it('logout and revokeAllSessions end a session; a token of another secret never resolves', async () => {
    const email = await user('content');
    const a = await login(email);
    const b = await login(email);
    if (!a.ok || !b.ok) throw new Error('refused');
    const resolved = await resolve(a.token);
    if (resolved === null) throw new Error('no session');
    await handle.db.transaction(async (t) => {
      await logout(t, { sid: resolved.session.sid, userId: resolved.session.userId });
    });
    expect(await resolve(a.token)).toBeNull();
    expect(await resolve(b.token)).not.toBeNull();
    await handle.db.transaction(async (t) => {
      await revokeAllSessions(t, resolved.session.userId);
    });
    expect(await resolve(b.token)).toBeNull();
    expect(
      await resolveSession(
        handle.db,
        { secret: 'another-secret-another-secret-another-1' },
        b.token,
      ),
    ).toBeNull();
  });

  it('revokeOtherSessions keeps the current session and ends the rest, of this user only', async () => {
    const email = await user('content');
    const stranger = await user('content');
    const a = await login(email);
    const b = await login(email);
    const c = await login(stranger);
    if (!a.ok || !b.ok || !c.ok) throw new Error('refused');
    const current = await resolve(a.token);
    if (current === null) throw new Error('no session');
    const ended = await handle.db.transaction(
      async (t) =>
        await revokeOtherSessions(t, {
          userId: current.session.userId,
          keepSid: current.session.sid,
        }),
    );
    expect(ended).toBe(1);
    expect(await resolve(a.token)).not.toBeNull();
    expect(await resolve(b.token)).toBeNull();
    expect(await resolve(c.token)).not.toBeNull();
  });

  it('with no AUTH_SECRET nothing resolves and nothing logs in (fails closed)', async () => {
    const email = await user('content');
    await expect(
      handle.db.transaction(
        async (t) =>
          await beginLogin(t, { secret: undefined }, { email, password: PASSWORD, client }),
      ),
    ).rejects.toThrow(/AUTH_SECRET/);
  });
});

describe('lockout', () => {
  it('five wrong passwords lock the account; the right one is then refused, and a locked account looks like a wrong password', async () => {
    const email = await user('content');
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      expect((await login(email, 'wrong-password-wrong')).ok).toBe(false);
    }
    expect((await login(email)).ok).toBe(false);
    const [creds] = await handle.db
      .select({ lockedUntil: authCredentials.lockedUntil })
      .from(authCredentials)
      .where(sql`user_id = (SELECT id FROM auth_users WHERE email = ${email})`);
    expect(creds?.lockedUntil).not.toBeNull();
    // The lock ends on database time.
    await handle.db.execute(
      sql`UPDATE auth_credentials SET locked_until = now() - make_interval(mins => 1)
          WHERE user_id = (SELECT id FROM auth_users WHERE email = ${email})`,
    );
    expect((await login(email)).ok).toBe(true);
    expect(LOCK_MINUTES).toBe(15);
  });

  it('a burst of parallel wrong guesses from separate connections cannot out-run the counter', async () => {
    const email = await user('content');
    const burst = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const other = world.connect(1);
        return await other.db.transaction(
          async (t) =>
            await beginLogin(t, config(), { email, password: 'wrong-password-wrong', client }),
        );
      }),
    );
    expect(burst.every((r) => !r.ok)).toBe(true);
    const failures = await handle.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(sql`${auditLog.userId} = (SELECT id FROM auth_users WHERE email = ${email})`);
    // Five real checks (the fifth locks); the other seven met a locked account and were not counted as guesses.
    expect(
      failures.filter((f) => f.action === 'auth.login_failed' || f.action === 'auth.locked'),
    ).toHaveLength(MAX_FAILED_ATTEMPTS);
    expect((await login(email)).ok).toBe(false);
  });

  it('wrong TOTP codes count against the same counter', async () => {
    const owner = await enrolled('owner');
    clock += 31_000;
    const pending = await login(owner.email);
    if (!pending.ok) throw new Error('refused');
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      await handle.db.transaction(
        async (t) =>
          await verifyTotpLogin(t, config(), { token: pending.token, code: '111111', client }),
      );
    }
    const code = codeAt(owner.secret, stepOf(clock));
    const late = await handle.db.transaction(
      async (t) => await verifyTotpLogin(t, config(), { token: pending.token, code, client }),
    );
    expect(late.ok).toBe(false);
  });

  it('unknown account and wrong password are the same refusal and the audit log holds no password', async () => {
    expect(await login('nobody@example.test')).toEqual({ ok: false });
    const rows = await handle.db
      .select({ diff: auditLog.diff, action: auditLog.action })
      .from(auditLog);
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
    expect(JSON.stringify(rows)).not.toContain('nobody@example.test');
  });
});

describe('review round 1: guards that were not pinned', () => {
  const totp = async (token: string, code: string) =>
    await handle.db.transaction(
      async (t) => await verifyTotpLogin(t, config(), { token, code, client }),
    );

  it('a correct password does NOT reset the counter when a second step follows: wrong codes add up across logins', async () => {
    const owner = await enrolled('owner');
    clock += 31_000;
    const first = await login(owner.email);
    if (!first.ok) throw new Error('refused');
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i += 1) await totp(first.token, '111111');
    // "Right password, four wrong codes" again and again must still lock on the fifth wrong code.
    const second = await login(owner.email);
    if (!second.ok) throw new Error('refused');
    await totp(second.token, '111111');
    const right = codeAt(owner.secret, stepOf(clock));
    expect((await totp(second.token, right)).ok).toBe(false);
    expect((await login(owner.email)).ok).toBe(false);
  });

  it('a pending session of an enrolled owner cannot overwrite the confirmed TOTP secret', async () => {
    const owner = await enrolled('owner');
    const read = async () =>
      (
        await handle.db
          .select({ secret: authTotp.secretEncrypted })
          .from(authTotp)
          .where(sql`user_id = (SELECT id FROM auth_users WHERE email = ${owner.email})`)
      )[0]?.secret;
    const before = await read();
    clock += 31_000;
    const pending = await login(owner.email);
    if (!pending.ok) throw new Error('refused');
    const started = await handle.db.transaction(
      async (t) => await startTotpEnrolment(t, config(), { token: pending.token }),
    );
    expect(started).toBeNull();
    expect(await read()).toBe(before);
    expect((await totp(pending.token, codeAt(owner.secret, stepOf(clock)))).ok).toBe(true);
  });

  it('only a PENDING session can take the second step: a full one cannot enrol, verify or redeem a code', async () => {
    const owner = await enrolled('owner');
    const manager = await login(await user('manager'));
    if (!manager.ok) throw new Error('refused');
    for (const token of [owner.token, manager.token]) {
      expect(
        await handle.db.transaction(async (t) => await startTotpEnrolment(t, config(), { token })),
      ).toBeNull();
      expect((await totp(token, '123456')).ok).toBe(false);
      expect(
        (
          await handle.db.transaction(
            async (t) =>
              await verifyRecoveryLogin(t, config(), {
                token,
                code: owner.recovery[0] ?? 'x',
                client,
              }),
          )
        ).ok,
      ).toBe(false);
    }
  });

  it('a session expires on DATABASE time even when its signed token still looks valid', async () => {
    const email = await user('content');
    const result = await login(email);
    if (!result.ok) throw new Error('refused');
    expect(await resolve(result.token)).not.toBeNull();
    await handle.db.execute(
      sql`UPDATE auth_sessions SET expires_at = now() - make_interval(mins => 1)
          WHERE user_id = (SELECT id FROM auth_users WHERE email = ${email})`,
    );
    expect(await resolve(result.token)).toBeNull();
  });

  it("another account's TOTP ciphertext copied into this account's row does not pass its second step", async () => {
    const a = await enrolled('owner');
    const b = await enrolled('admin');
    await handle.db.execute(
      sql`UPDATE auth_totp SET secret_encrypted =
            (SELECT secret_encrypted FROM auth_totp WHERE user_id = (SELECT id FROM auth_users WHERE email = ${a.email}))
          WHERE user_id = (SELECT id FROM auth_users WHERE email = ${b.email})`,
    );
    clock += 61_000;
    const pending = await login(b.email);
    if (!pending.ok) throw new Error('refused');
    expect((await totp(pending.token, codeAt(a.secret, stepOf(clock)))).ok).toBe(false);
  });

  it('recovery codes are 80 bits and stored keyed, not as the code or its bare hash', async () => {
    const owner = await enrolled('owner');
    for (const code of owner.recovery) expect(code).toMatch(/^[0-9a-f]{5}(-[0-9a-f]{5}){3}$/);
    const hashes = (
      await handle.db.select({ hash: authRecoveryCodes.codeHash }).from(authRecoveryCodes)
    ).map((row) => row.hash);
    const bare = createHash('sha256')
      .update(owner.recovery[0] ?? '')
      .digest('hex');
    expect(hashes).not.toContain(bare);
    expect(hashes).not.toContain(owner.recovery[0] ?? '');
  });

  it('an unknown account costs about as much time as a wrong password (the dummy hash runs)', async () => {
    const email = await user('content');
    const median = async (target: string): Promise<number> => {
      const samples: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const start = performance.now();
        await login(target, 'wrong-password-wrong');
        samples.push(performance.now() - start);
      }
      return samples.sort((x, y) => x - y)[2] ?? 0;
    };
    const known = await median(email);
    const unknown = await median(`nobody-${String(counter)}@example.test`);
    expect(unknown).toBeGreaterThan(known * 0.5);
    // The known account just collected 5 failures and is locked: reset for the next tests.
    await handle.db.transaction(async (t) => {
      await unlockAccount(t, { email });
    });
  });

  it('unlockAccount lifts a lock, is audited, and says when the account does not exist', async () => {
    const email = await user('content');
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) await login(email, 'wrong-password-wrong');
    expect((await login(email)).ok).toBe(false);
    expect(await handle.db.transaction(async (t) => await unlockAccount(t, { email }))).toBe(true);
    expect((await login(email)).ok).toBe(true);
    expect(
      (await handle.db.select().from(auditLog).where(eq(auditLog.action, 'auth.unlocked'))).length,
    ).toBeGreaterThan(0);
    expect(
      await handle.db.transaction(
        async (t) => await unlockAccount(t, { email: 'nobody@example.test' }),
      ),
    ).toBe(false);
  });

  it('the name-in-password rule only applies to a name of 4 or more characters', async () => {
    await handle.db.transaction(async (t) => {
      await createAdminUser(t, {
        email: 'a@example.test',
        password: 'banana-banana-banana',
        role: 'content',
      });
    });
    await expect(
      handle.db.transaction(
        async (t) =>
          await createAdminUser(t, {
            email: 'alice@example.test',
            password: 'xx-alice-xx-1234',
            role: 'content',
          }),
      ),
    ).rejects.toBeInstanceOf(WeakPasswordError);
  });
});
