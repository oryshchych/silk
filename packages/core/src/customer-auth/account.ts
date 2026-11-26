/**
 * The customer account. Registration starts with an e-mail address ONLY: the buyer sets the password
 * on the page the mailed link opens, so someone who types another person's address cannot pick the
 * password of the account that person will later verify. The address counts as verified when the
 * link is used, and only then are the guest orders placed with it claimed (never on a typed claim).
 *
 * Every request that takes an address answers the same whether the account exists, is new, is an
 * admin or the request was throttled (no enumeration). Sign-in has the admin's lockout: five wrong
 * passwords lock the account for fifteen minutes, one advisory lock per account serialises
 * attempts, an unknown account still spends one password hash.
 *
 * Every function takes the transaction first and RETURNS a refusal instead of throwing, so the
 * caller commits the failure counter and the audit row of a refused attempt.
 */
import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  adminUsers,
  authCredentials,
  authEmailTokens,
  authUsers,
  customers,
  orders,
  outbox,
} from '@store/db/schema';
import type { Tx } from '@store/db/types';

import { writeAudit } from '../audit/write-audit.ts';
import { hashPassword, verifyPassword } from '../auth/crypto.ts';
import {
  assertPasswordAllowed,
  clearFailures,
  lockAccount,
  recordFailure,
  WeakPasswordError,
  type AuthConfig,
  type ClientInfo,
} from '../auth/service.ts';
import { issueEmailToken, readEmailToken, type EmailTokenPurpose } from './tokens.ts';
import { openCustomerSession, revokeCustomerSessions } from './session.ts';

export const emailSchema = z.email().max(320);
export type Locale = 'uk' | 'en';

export const TOPIC = {
  verify_email: 'email.account-verify',
  reset_password: 'email.password-reset',
} as const satisfies Record<EmailTokenPurpose, string>;

const normalise = (email: string): string => email.trim().toLowerCase();

/**
 * The branches that send nothing (unknown address, an admin, a throttled one) do the same database
 * work as the one that sends: take the lock, count, insert a queue row. The insert is rolled back
 * with a savepoint, so no decoy is ever queued. Without it the request time says which branch ran.
 */
async function decoy(tx: Tx): Promise<void> {
  const id = randomUUID();
  await tx
    .transaction(async (inner) => {
      await lockAccount(inner, id);
      await inner
        .select({ count: sql<number>`count(*)::int` })
        .from(authEmailTokens)
        .where(
          and(
            eq(authEmailTokens.userId, id),
            sql`${authEmailTokens.createdAt} > now() - interval '1 hour'`,
          ),
        );
      await inner
        .update(authEmailTokens)
        .set({ usedAt: sql`now()` })
        .where(and(eq(authEmailTokens.userId, id), sql`${authEmailTokens.usedAt} IS NULL`));
      await inner.insert(outbox).values({ topic: 'decoy', payload: { tokenId: id } });
      throw new DecoyRollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof DecoyRollback)) throw error;
    });
}

class DecoyRollback extends Error {}

async function lockRegistration(tx: Tx, email: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`register:${email}`}, 0))`);
}

/** The token row and the mail job, in the caller's transaction. The payload is the id alone. */
async function sendLink(
  tx: Tx,
  input: { userId: string; purpose: EmailTokenPurpose; locale: Locale },
): Promise<void> {
  await lockAccount(tx, input.userId);
  const tokenId = await issueEmailToken(tx, input);
  if (tokenId === null) {
    await decoy(tx);
    return;
  }
  await tx.insert(outbox).values({
    topic: TOPIC[input.purpose],
    payload: { tokenId },
    dedupKey: `account-token:${tokenId}`,
  });
}

/**
 * Step 1 of registration. A new address gets a pending account (no password yet) and a
 * verification link; an address that already has a customer account gets a password-reset link
 * instead (it explains itself in the mail); an admin address and a throttled one send nothing.
 * The answer never differs.
 */
export async function requestRegistration(
  tx: Tx,
  input: { email: string; locale: Locale; client: ClientInfo },
): Promise<void> {
  const parsed = emailSchema.safeParse(normalise(input.email));
  if (!parsed.success) return;
  const email = parsed.data;
  await lockRegistration(tx, email);
  const [existing] = await tx
    .select({
      id: authUsers.id,
      verified: sql<boolean>`${authUsers.emailVerifiedAt} IS NOT NULL`,
      isAdmin: sql<boolean>`${adminUsers.userId} IS NOT NULL`,
    })
    .from(authUsers)
    .leftJoin(adminUsers, eq(adminUsers.userId, authUsers.id))
    .where(sql`lower(${authUsers.email}) = ${email}`);
  if (existing?.isAdmin === true) {
    await decoy(tx);
    return;
  }
  if (existing?.verified === true) {
    await sendLink(tx, { userId: existing.id, purpose: 'reset_password', locale: input.locale });
    return;
  }
  let userId = existing?.id;
  if (userId === undefined) {
    const [created] = await tx.insert(authUsers).values({ email }).returning({ id: authUsers.id });
    if (created === undefined) throw new Error('user insert returned no row');
    userId = created.id;
    await writeAudit(tx, {
      userId,
      action: 'customer.registration_requested',
      entity: 'auth_user',
      entityId: userId,
      ip: input.client.ip,
    });
  }
  await sendLink(tx, { userId, purpose: 'verify_email', locale: input.locale });
}

/** Asks for a password-reset link. Only a verified customer account gets one; the answer never differs. */
export async function requestPasswordReset(
  tx: Tx,
  input: { email: string; locale: Locale; client: ClientInfo },
): Promise<void> {
  const parsed = emailSchema.safeParse(normalise(input.email));
  if (!parsed.success) return;
  const [account] = await tx
    .select({ id: authUsers.id })
    .from(authUsers)
    .innerJoin(customers, eq(customers.userId, authUsers.id))
    .leftJoin(adminUsers, eq(adminUsers.userId, authUsers.id))
    .where(
      and(
        sql`lower(${authUsers.email}) = ${parsed.data}`,
        sql`${authUsers.emailVerifiedAt} IS NOT NULL`,
        sql`${adminUsers.userId} IS NULL`,
      ),
    );
  if (account === undefined) {
    await decoy(tx);
    return;
  }
  await sendLink(tx, { userId: account.id, purpose: 'reset_password', locale: input.locale });
  await writeAudit(tx, {
    userId: account.id,
    action: 'customer.password_reset_requested',
    entity: 'auth_user',
    entityId: account.id,
    ip: input.client.ip,
  });
}

/**
 * The customer row of an account, created or attached by the verified address (the admin may
 * have tagged the address before: that row keeps its tags and gains the account).
 */
async function ensureCustomer(
  tx: Tx,
  input: { userId: string; email: string; locale: Locale },
): Promise<string> {
  const [row] = await tx
    .insert(customers)
    .values({ userId: input.userId, email: input.email, locale: input.locale })
    .onConflictDoUpdate({
      target: customers.email,
      set: { userId: sql`COALESCE(${customers.userId}, ${input.userId}::uuid)` },
    })
    .returning({ id: customers.id, userId: customers.userId });
  if (row === undefined || row.userId !== input.userId) {
    throw new Error('the customer row of this address belongs to another account');
  }
  return row.id;
}

/**
 * Guest orders placed with the account's VERIFIED address become the account's. Idempotent: it
 * runs at verification and again whenever the order list opens, so an order placed later as a guest
 * with the same address is claimed too. Returns how many orders were claimed.
 */
export async function claimGuestOrders(
  tx: Tx,
  input: { customerId: string; email: string },
): Promise<number> {
  const claimed = await tx
    .update(orders)
    .set({ customerId: input.customerId })
    .where(
      and(sql`${orders.customerId} IS NULL`, sql`lower(${orders.customerEmail}) = ${input.email}`),
    )
    .returning({ id: orders.id });
  return claimed.length;
}

export type CompleteResult =
  { ok: true; purpose: EmailTokenPurpose } | { ok: false; reason: 'invalid' | 'weak_password' };

/**
 * Step 2 of registration and the end of a password reset: a valid, unused, unexpired token and a
 * password that passes the policy. The token is claimed by one conditional UPDATE, so two parallel
 * uses of one link cannot both win.
 */
export async function completeWithToken(
  tx: Tx,
  config: AuthConfig,
  input: { token: string; password: string; client: ClientInfo },
): Promise<CompleteResult> {
  const named = readEmailToken(config.secret, input.token);
  if (named === null) return { ok: false, reason: 'invalid' };
  const [row] = await tx
    .select({
      userId: authEmailTokens.userId,
      purpose: authEmailTokens.purpose,
      locale: authEmailTokens.locale,
      email: authUsers.email,
    })
    .from(authEmailTokens)
    .innerJoin(authUsers, eq(authUsers.id, authEmailTokens.userId))
    .leftJoin(adminUsers, eq(adminUsers.userId, authUsers.id))
    .where(
      and(
        eq(authEmailTokens.id, named.id),
        sql`${authEmailTokens.usedAt} IS NULL`,
        sql`${authEmailTokens.expiresAt} > now()`,
        sql`${adminUsers.userId} IS NULL`,
      ),
    );
  if (row === undefined) return { ok: false, reason: 'invalid' };
  const email = normalise(row.email);
  try {
    assertPasswordAllowed(email, input.password);
  } catch (error) {
    if (error instanceof WeakPasswordError) return { ok: false, reason: 'weak_password' };
    throw error;
  }
  await lockAccount(tx, row.userId);
  const claimed = await tx
    .update(authEmailTokens)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(authEmailTokens.id, named.id),
        sql`${authEmailTokens.usedAt} IS NULL`,
        sql`${authEmailTokens.expiresAt} > now()`,
      ),
    )
    .returning({ id: authEmailTokens.id });
  if (claimed.length !== 1) return { ok: false, reason: 'invalid' };
  const passwordHash = await hashPassword(input.password);
  await tx
    .insert(authCredentials)
    .values({ userId: row.userId, passwordHash })
    .onConflictDoUpdate({
      target: authCredentials.userId,
      set: {
        passwordHash,
        passwordUpdatedAt: sql`now()`,
        failedAttempts: 0,
        lockedUntil: null,
      },
    });
  const locale: Locale = row.locale === 'en' ? 'en' : 'uk';
  if (row.purpose === 'verify_email') {
    await tx
      .update(authUsers)
      .set({ emailVerifiedAt: sql`COALESCE(${authUsers.emailVerifiedAt}, now())` })
      .where(eq(authUsers.id, row.userId));
    const customerId = await ensureCustomer(tx, { userId: row.userId, email, locale });
    await claimGuestOrders(tx, { customerId, email });
  } else {
    await revokeCustomerSessions(tx, row.userId);
  }
  await writeAudit(tx, {
    userId: row.userId,
    action: row.purpose === 'verify_email' ? 'customer.registered' : 'customer.password_reset',
    entity: 'auth_user',
    entityId: row.userId,
    ip: input.client.ip,
  });
  return { ok: true, purpose: row.purpose };
}

export type CustomerLoginResult = { ok: true; token: string; expiresAt: Date } | { ok: false };

export async function customerLogin(
  tx: Tx,
  config: AuthConfig,
  input: { email: string; password: string; client: ClientInfo },
): Promise<CustomerLoginResult> {
  const email = normalise(input.email);
  const [known] = await tx
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(sql`lower(${authUsers.email}) = ${email}`);
  if (known !== undefined) await lockAccount(tx, known.id);
  const [row] = await tx
    .select({
      userId: authUsers.id,
      passwordHash: authCredentials.passwordHash,
      locked: sql<boolean>`${authCredentials.lockedUntil} IS NOT NULL AND ${authCredentials.lockedUntil} > now()`,
      verified: sql<boolean>`${authUsers.emailVerifiedAt} IS NOT NULL`,
      isAdmin: sql<boolean>`${adminUsers.userId} IS NOT NULL`,
      hasCustomer: sql<boolean>`${customers.id} IS NOT NULL`,
    })
    .from(authUsers)
    .innerJoin(authCredentials, eq(authCredentials.userId, authUsers.id))
    .leftJoin(adminUsers, eq(adminUsers.userId, authUsers.id))
    .leftJoin(customers, eq(customers.userId, authUsers.id))
    .where(sql`lower(${authUsers.email}) = ${email}`);
  const usable = row !== undefined && row.verified && !row.isAdmin && row.hasCustomer;
  if (!usable || row.locked) {
    // Same cost and same answer as a wrong password.
    await verifyPassword(input.password, null);
    if (usable) {
      await writeAudit(tx, {
        userId: row.userId,
        action: 'auth.login_refused_locked',
        entity: 'auth_user',
        entityId: row.userId,
        ip: input.client.ip,
      });
    }
    return { ok: false };
  }
  if (!(await verifyPassword(input.password, row.passwordHash))) {
    await recordFailure(tx, row.userId, input.client);
    return { ok: false };
  }
  await clearFailures(tx, row.userId);
  const opened = await openCustomerSession(tx, config, {
    userId: row.userId,
    client: input.client,
  });
  await writeAudit(tx, {
    userId: row.userId,
    action: 'customer.login',
    entity: 'auth_user',
    entityId: row.userId,
    ip: input.client.ip,
  });
  return { ok: true, ...opened };
}

/** Accounts that never finished registration (a typed address nobody confirmed), older than `days`. */
export async function purgePendingAccounts(tx: Tx, days = 7): Promise<number> {
  const removed = await tx.execute(sql`
    DELETE FROM auth_users u
     WHERE u.email_verified_at IS NULL
       AND u.created_at < now() - make_interval(days => ${days})
       AND NOT EXISTS (SELECT 1 FROM auth_credentials c WHERE c.user_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM admin_users a WHERE a.user_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM customers k WHERE k.user_id = u.id)`);
  return removed.rowCount ?? 0;
}

/** Link rows that were used, or expired more than a week ago (they carry no credential: housekeeping only). */
export async function purgeEmailTokens(tx: Tx): Promise<number> {
  const removed = await tx.execute(sql`
    DELETE FROM auth_email_tokens
     WHERE used_at IS NOT NULL OR expires_at < now() - interval '7 days'`);
  return removed.rowCount ?? 0;
}
