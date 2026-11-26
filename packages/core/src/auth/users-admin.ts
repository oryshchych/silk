/**
 * The owner's user management (phase 5, owner queue Q41): list, create, change a role, deactivate,
 * reset a password. Every function takes the transaction first and returns what changed; the admin
 * action writes the audit row (author and address). The rules that keep the shop reachable and the
 * accounts safe live here, in the database transaction, not in the screen:
 *
 *  - a person cannot change their OWN role, deactivate or reset themselves (no self lock-out);
 *  - the LAST active owner cannot be demoted or deactivated (two owners demoting each other at the
 *    same moment are serialised by one advisory lock, so one always remains);
 *  - a role change, a deactivation and a password reset end every session of that user
 *    (`revokeAllSessions`: a revoked session never counts again, ADR-19);
 *  - a password follows the same rules as at creation and is never logged, audited or returned.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { adminUsers, authCredentials, authSessions, authUsers } from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';

import { AdminNotFoundError } from '../catalog-admin/errors.ts';
import { DomainError } from '../errors.ts';
import { hashPassword } from './crypto.ts';
import type { AdminRole } from './permissions.ts';
import { ROLES } from './permissions.ts';
import {
  assertPasswordAllowed,
  createAdminUser,
  revokeAllSessions,
  WeakPasswordError,
} from './service.ts';

export class LastOwnerError extends DomainError {
  constructor() {
    super('ADMIN_LAST_OWNER', 'The last active owner cannot be demoted or deactivated');
  }
}

export class SelfChangeError extends DomainError {
  constructor() {
    super('ADMIN_SELF_CHANGE', 'You cannot change your own role, status or password here');
  }
}

export class EmailTakenError extends DomainError {
  constructor() {
    super('ADMIN_EMAIL_TAKEN', 'An account with this email already exists');
  }
}

export class WeakPasswordDomainError extends DomainError {
  constructor() {
    super('ADMIN_WEAK_PASSWORD', 'The password does not meet the rules');
  }
}

export interface AdminUserRow {
  userId: string;
  email: string;
  role: AdminRole;
  isActive: boolean;
  /** A confirmed authenticator. */
  mfaConfirmed: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  /** Sessions that are neither revoked nor expired. */
  liveSessions: number;
}

/** Every admin account, newest first. An explicit field list: never the credential row. */
export async function listAdminUsers(db: Reader): Promise<AdminUserRow[]> {
  const result = await db.execute<{
    user_id: string;
    email: string;
    role: AdminRole;
    is_active: boolean;
    mfa: boolean;
    last_login_at: Date | null;
    created_at: Date;
    live: number;
  }>(
    sql`SELECT a.user_id::text AS user_id, u.email, a.role::text AS role, a.is_active,
               coalesce(t.confirmed_at IS NOT NULL, false) AS mfa, a.last_login_at, u.created_at,
               (SELECT count(*)::int FROM auth_sessions s
                 WHERE s.user_id = a.user_id AND s.revoked_at IS NULL AND s.expires_at > now()) AS live
          FROM admin_users a
          JOIN auth_users u ON u.id = a.user_id
          LEFT JOIN auth_totp t ON t.user_id = a.user_id
         ORDER BY u.created_at DESC, a.user_id`,
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    role: z.enum(ROLES).parse(row.role),
    isActive: row.is_active,
    mfaConfirmed: row.mfa,
    lastLoginAt: row.last_login_at === null ? null : new Date(row.last_login_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    liveSessions: row.live,
  }));
}

/** One lock for every change that decides who may sign in: it makes the "last owner" count safe. */
async function lockUsers(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('admin-users', 0))`);
}

async function activeOwners(tx: Tx): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(adminUsers)
    .where(and(eq(adminUsers.role, 'owner'), eq(adminUsers.isActive, true)));
  return row?.n ?? 0;
}

async function target(tx: Tx, userId: string, actorId: string) {
  if (userId === actorId) throw new SelfChangeError();
  const [row] = await tx
    .select({
      userId: adminUsers.userId,
      role: adminUsers.role,
      isActive: adminUsers.isActive,
      email: authUsers.email,
    })
    .from(adminUsers)
    .innerJoin(authUsers, eq(authUsers.id, adminUsers.userId))
    .where(eq(adminUsers.userId, userId));
  if (row === undefined) throw new AdminNotFoundError('user');
  return row;
}

export async function createUser(
  tx: Tx,
  input: { email: string; password: string; role: AdminRole; actorId: string },
): Promise<{ userId: string }> {
  await lockUsers(tx);
  const email = input.email.trim().toLowerCase();
  const [existing] = await tx
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(sql`lower(${authUsers.email}) = ${email}`);
  if (existing !== undefined) throw new EmailTakenError();
  try {
    return await createAdminUser(tx, { ...input, email, auditByCaller: true });
  } catch (error) {
    if (error instanceof WeakPasswordError) throw new WeakPasswordDomainError();
    throw error;
  }
}

export async function changeUserRole(
  tx: Tx,
  input: { userId: string; role: AdminRole; actorId: string },
): Promise<{ changed: boolean; from: AdminRole; to: AdminRole; email: string }> {
  await lockUsers(tx);
  const user = await target(tx, input.userId, input.actorId);
  if (user.role === input.role) {
    return { changed: false, from: user.role, to: input.role, email: user.email };
  }
  if (user.role === 'owner' && user.isActive && (await activeOwners(tx)) <= 1) {
    throw new LastOwnerError();
  }
  await tx.update(adminUsers).set({ role: input.role }).where(eq(adminUsers.userId, input.userId));
  await revokeAllSessions(tx, input.userId);
  return { changed: true, from: user.role, to: input.role, email: user.email };
}

export async function setUserActive(
  tx: Tx,
  input: { userId: string; active: boolean; actorId: string },
): Promise<{ changed: boolean; email: string }> {
  await lockUsers(tx);
  const user = await target(tx, input.userId, input.actorId);
  if (user.isActive === input.active) return { changed: false, email: user.email };
  if (!input.active && user.role === 'owner' && (await activeOwners(tx)) <= 1) {
    throw new LastOwnerError();
  }
  await tx
    .update(adminUsers)
    .set({ isActive: input.active })
    .where(eq(adminUsers.userId, input.userId));
  if (!input.active) await revokeAllSessions(tx, input.userId);
  return { changed: true, email: user.email };
}

export async function resetUserPassword(
  tx: Tx,
  input: { userId: string; password: string; actorId: string },
): Promise<{ email: string }> {
  await lockUsers(tx);
  const user = await target(tx, input.userId, input.actorId);
  try {
    assertPasswordAllowed(user.email.toLowerCase(), input.password);
  } catch (error) {
    if (error instanceof WeakPasswordError) throw new WeakPasswordDomainError();
    throw error;
  }
  await tx
    .update(authCredentials)
    .set({
      passwordHash: await hashPassword(input.password),
      passwordUpdatedAt: sql`now()`,
      failedAttempts: 0,
      lockedUntil: null,
    })
    .where(eq(authCredentials.userId, input.userId));
  await revokeAllSessions(tx, input.userId);
  return { email: user.email };
}

export const userSchemas = {
  create: z.object({
    email: z.email().max(320),
    role: z.enum(ROLES),
    password: z.string().min(1).max(128),
  }),
  role: z.object({ userId: z.uuid(), role: z.enum(ROLES) }),
  active: z.object({ userId: z.uuid(), active: z.boolean() }),
  password: z.object({ userId: z.uuid(), password: z.string().min(1).max(128) }),
};

/** Counts of live sessions per user (for tests and the screen): never the tokens. */
export async function liveSessionCount(db: Reader, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.userId, userId),
        isNull(authSessions.revokedAt),
        sql`${authSessions.expiresAt} > now()`,
      ),
    );
  return row?.n ?? 0;
}
