/**
 * Admin authentication (ADR-19). Sessions are signed tokens that name a row of `auth_sessions`;
 * the row, the user's `is_active`, role and MFA state are read from the database on EVERY request.
 *
 * Login is two steps for roles that need MFA (owner, admin) and for anyone who enrolled TOTP:
 *  1. password -> a PENDING session (`mfa_satisfied_at` NULL, 10 minutes): proves nothing, opens
 *     only the TOTP page;
 *  2. TOTP (or a recovery code) -> a NEW session (the pending one is revoked: no fixation) that
 *     counts everywhere.
 * Password and TOTP failures share one counter per account: five in a row lock the account for
 * fifteen minutes. A denial never says why (unknown account, wrong password and a locked account
 * look the same, and an unknown account still spends one password hash).
 *
 * Every function takes the transaction first and RETURNS a refusal instead of throwing: the
 * caller commits, so the failure counter and the audit row of a refused attempt are kept.
 */
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  adminUsers,
  authCredentials,
  authRecoveryCodes,
  authSessions,
  authTotp,
  authUsers,
} from '@store/db/schema';
import type { Reader, Tx } from '@store/db/types';

import { writeAudit } from '../audit/write-audit.ts';
import {
  constantTimeEqual,
  decryptSecret,
  deriveKey,
  encryptSecret,
  hashPassword,
  recoveryHash,
  verifyPassword,
} from './crypto.ts';
import { MFA_REQUIRED_ROLES, type AdminRole } from './permissions.ts';
import { readSessionToken, signSessionToken } from './session-token.ts';
import { generateTotpSecret, matchTotp, otpauthUri } from './totp.ts';
import { randomBytes } from 'node:crypto';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
export const PENDING_MINUTES = 10;
export const SESSION_HOURS = 12;
const RECOVERY_CODE_COUNT = 10;

export interface AuthConfig {
  /** `AUTH_SECRET`; a missing or short one makes every function throw (fails closed). */
  secret: string | undefined;
  /** Issuer shown in the authenticator app. */
  issuer?: string;
  /** Wall clock in ms, for TOTP only (tests move it). Database time decides everything else. */
  nowMs?: () => number;
}

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export type NextStep = 'totp' | 'enroll' | 'done';

export type LoginResult =
  { ok: true; token: string; expiresAt: Date; next: NextStep } | { ok: false };

export type MfaResult =
  { ok: true; token: string; expiresAt: Date; recoveryCodes?: string[] } | { ok: false };

export interface AdminSession {
  sid: string;
  userId: string;
  email: string;
  role: AdminRole;
}

export type ResolvedSession =
  | { kind: 'full'; session: AdminSession }
  | { kind: 'pending'; session: AdminSession; next: 'totp' | 'enroll' };

const nowOf = (config: AuthConfig): number => (config.nowMs ?? Date.now)();
const sessionKey = (config: AuthConfig): Buffer => deriveKey(config.secret, 'session');
const totpKey = (config: AuthConfig): Buffer => deriveKey(config.secret, 'totp');
const recoveryKey = (config: AuthConfig): Buffer => deriveKey(config.secret, 'recovery');
const needsMfa = (role: AdminRole, totpConfirmed: boolean): boolean =>
  MFA_REQUIRED_ROLES.includes(role) || totpConfirmed;

export const passwordSchema = z
  .string()
  .min(12, 'at least 12 characters')
  .max(128, 'at most 128 characters');

// ─── sessions ──────────────────────────────────────────────────────────────────────────────────

async function openSession(
  tx: Tx,
  config: AuthConfig,
  input: { userId: string; client: ClientInfo; full: boolean; mfaDone: boolean },
): Promise<{ token: string; expiresAt: Date; sid: string }> {
  const ttl = input.full
    ? sql`now() + make_interval(hours => ${SESSION_HOURS})`
    : sql`now() + make_interval(mins => ${PENDING_MINUTES})`;
  const [row] = await tx
    .insert(authSessions)
    .values({
      userId: input.userId,
      // Only a session that really passed the second step says so: a password-only session of a
      // role without MFA must not count as MFA-satisfied when the role (or TOTP) changes later.
      mfaSatisfiedAt: input.mfaDone ? sql`now()` : null,
      expiresAt: ttl,
      ip: input.client.ip?.slice(0, 45) ?? null,
      userAgent: input.client.userAgent?.slice(0, 300) ?? null,
    })
    .returning({ sid: authSessions.sid, expiresAt: authSessions.expiresAt });
  if (row === undefined) throw new Error('session insert returned no row');
  return {
    sid: row.sid,
    expiresAt: row.expiresAt,
    token: signSessionToken(row.sid, row.expiresAt.getTime(), sessionKey(config)),
  };
}

async function revokeSessionRow(tx: Tx, sid: string): Promise<void> {
  await tx
    .update(authSessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(authSessions.sid, sid), isNull(authSessions.revokedAt)));
}

/** The session a token names, with the user's CURRENT role and state; null when it does not count. */
export async function resolveSession(
  db: Reader,
  config: AuthConfig,
  token: string | null | undefined,
): Promise<ResolvedSession | null> {
  if (token === null || token === undefined || token === '') return null;
  const parsed = readSessionToken(token, sessionKey(config), nowOf(config));
  if (parsed === null) return null;
  const [row] = await db
    .select({
      sid: authSessions.sid,
      userId: authSessions.userId,
      email: authUsers.email,
      role: adminUsers.role,
      mfaSatisfiedAt: authSessions.mfaSatisfiedAt,
      totpConfirmed: sql<boolean>`${authTotp.confirmedAt} IS NOT NULL`,
    })
    .from(authSessions)
    .innerJoin(authUsers, eq(authUsers.id, authSessions.userId))
    .innerJoin(adminUsers, eq(adminUsers.userId, authSessions.userId))
    .leftJoin(authTotp, eq(authTotp.userId, authSessions.userId))
    .where(
      and(
        eq(authSessions.sid, parsed.sid),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, sql`now()`),
        eq(adminUsers.isActive, true),
      ),
    );
  if (row === undefined) return null;
  const session: AdminSession = {
    sid: row.sid,
    userId: row.userId,
    email: row.email,
    role: row.role,
  };
  if (!needsMfa(row.role, row.totpConfirmed) || row.mfaSatisfiedAt !== null) {
    return { kind: 'full', session };
  }
  return { kind: 'pending', session, next: row.totpConfirmed ? 'totp' : 'enroll' };
}

export async function logout(tx: Tx, input: { sid: string; userId: string }): Promise<void> {
  await revokeSessionRow(tx, input.sid);
  await writeAudit(tx, {
    userId: input.userId,
    action: 'auth.logout',
    entity: 'auth_session',
    entityId: input.sid,
  });
}

/** After a password or role change: every session of the user stops counting. */
export async function revokeAllSessions(tx: Tx, userId: string): Promise<void> {
  await tx
    .update(authSessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
}

/**
 * Serialises everything that touches one account's credentials (password attempts, TOTP steps,
 * the failure counter) for the rest of the transaction. A transaction-scoped advisory lock rather
 * than `FOR UPDATE`: it is taken BEFORE the account row is read, so the read already sees what the
 * previous holder committed, and it covers an account that has no row yet to lock. Accounts are
 * independent of every ADR-22 lock level, and one transaction only ever takes one of these.
 */
async function lockAccount(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`auth:${userId}`}, 0))`);
}

/** Every session of the user except the one in use ("sign out other devices"). Returns how many ended. */
export async function revokeOtherSessions(
  tx: Tx,
  input: { userId: string; keepSid: string },
): Promise<number> {
  const ended = await tx
    .update(authSessions)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(authSessions.userId, input.userId),
        isNull(authSessions.revokedAt),
        sql`${authSessions.sid} <> ${input.keepSid}::uuid`,
      ),
    )
    .returning({ sid: authSessions.sid });
  return ended.length;
}

// ─── failure counter and lockout ───────────────────────────────────────────────────────────────

/** Counts one failure; the fifth locks the account. Returns true when this failure locked it. */
async function recordFailure(tx: Tx, userId: string, client: ClientInfo): Promise<boolean> {
  const [row] = await tx
    .update(authCredentials)
    .set({
      failedAttempts: sql`CASE WHEN ${authCredentials.failedAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS}
        THEN 0 ELSE ${authCredentials.failedAttempts} + 1 END`,
      lockedUntil: sql`CASE WHEN ${authCredentials.failedAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS}
        THEN now() + make_interval(mins => ${LOCK_MINUTES}) ELSE ${authCredentials.lockedUntil} END`,
    })
    .where(eq(authCredentials.userId, userId))
    .returning({ lockedNow: sql<boolean>`${authCredentials.failedAttempts} = 0` });
  const locked = row?.lockedNow ?? false;
  await writeAudit(tx, {
    userId,
    action: locked ? 'auth.locked' : 'auth.login_failed',
    entity: 'auth_user',
    entityId: userId,
    ip: client.ip,
  });
  return locked;
}

const clearFailures = async (tx: Tx, userId: string): Promise<void> => {
  await tx
    .update(authCredentials)
    .set({ failedAttempts: 0, lockedUntil: null })
    .where(eq(authCredentials.userId, userId));
};

// ─── step 1: password ──────────────────────────────────────────────────────────────────────────

export async function beginLogin(
  tx: Tx,
  config: AuthConfig,
  input: { email: string; password: string; client: ClientInfo },
): Promise<LoginResult> {
  sessionKey(config); // a missing secret throws before anything is looked up
  const email = input.email.trim().toLowerCase();
  const [known] = await tx
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(sql`lower(${authUsers.email}) = ${email}`);
  // Serialises attempts on one account: a parallel burst cannot out-run the counter.
  if (known !== undefined) await lockAccount(tx, known.id);
  const [row] = await tx
    .select({
      userId: authUsers.id,
      passwordHash: authCredentials.passwordHash,
      locked: sql<boolean>`${authCredentials.lockedUntil} IS NOT NULL AND ${authCredentials.lockedUntil} > now()`,
      role: adminUsers.role,
      isActive: adminUsers.isActive,
      totpConfirmed: sql<boolean>`${authTotp.confirmedAt} IS NOT NULL`,
    })
    .from(authUsers)
    .innerJoin(authCredentials, eq(authCredentials.userId, authUsers.id))
    .innerJoin(adminUsers, eq(adminUsers.userId, authUsers.id))
    .leftJoin(authTotp, eq(authTotp.userId, authUsers.id))
    .where(sql`lower(${authUsers.email}) = ${email}`);

  if (row === undefined || !row.isActive || row.locked) {
    // Same cost and same answer as a wrong password.
    await verifyPassword(input.password, null);
    if (row !== undefined && row.isActive) {
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
  const totpConfirmed = row.totpConfirmed;
  const mfa = needsMfa(row.role, totpConfirmed);
  // A correct password must NOT reset the counter when a second step follows: otherwise "right
  // password, four wrong codes" repeated forever never locks anything. `promote` clears it once
  // the second step has passed.
  if (!mfa) await clearFailures(tx, row.userId);
  const opened = await openSession(tx, config, {
    userId: row.userId,
    client: input.client,
    full: !mfa,
    mfaDone: false,
  });
  if (!mfa) await markLogin(tx, row.userId, input.client);
  return {
    ok: true,
    token: opened.token,
    expiresAt: opened.expiresAt,
    next: mfa ? (totpConfirmed ? 'totp' : 'enroll') : 'done',
  };
}

async function markLogin(tx: Tx, userId: string, client: ClientInfo): Promise<void> {
  await tx
    .update(adminUsers)
    .set({ lastLoginAt: sql`now()` })
    .where(eq(adminUsers.userId, userId));
  await writeAudit(tx, {
    userId,
    action: 'auth.login',
    entity: 'auth_user',
    entityId: userId,
    ip: client.ip,
  });
}

// ─── step 2: TOTP, recovery code, enrolment ────────────────────────────────────────────────────

interface PendingContext {
  userId: string;
  sid: string;
  locked: boolean;
}

/** The pending session of a token, with the account locked (`lockAccount`). */
async function lockPending(
  tx: Tx,
  config: AuthConfig,
  token: string,
): Promise<PendingContext | null> {
  const parsed = readSessionToken(token, sessionKey(config), nowOf(config));
  if (parsed === null) return null;
  const [owner] = await tx
    .select({ userId: authSessions.userId })
    .from(authSessions)
    .where(eq(authSessions.sid, parsed.sid));
  if (owner === undefined) return null;
  await lockAccount(tx, owner.userId);
  const [row] = await tx
    .select({
      userId: authSessions.userId,
      sid: authSessions.sid,
      locked: sql<boolean>`${authCredentials.lockedUntil} IS NOT NULL AND ${authCredentials.lockedUntil} > now()`,
      mfaSatisfiedAt: authSessions.mfaSatisfiedAt,
      isActive: adminUsers.isActive,
      role: adminUsers.role,
      totpConfirmed: sql<boolean>`${authTotp.confirmedAt} IS NOT NULL`,
    })
    .from(authSessions)
    .innerJoin(authCredentials, eq(authCredentials.userId, authSessions.userId))
    .innerJoin(adminUsers, eq(adminUsers.userId, authSessions.userId))
    .leftJoin(authTotp, eq(authTotp.userId, authSessions.userId))
    .where(
      and(
        eq(authSessions.sid, parsed.sid),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, sql`now()`),
      ),
    );
  if (row === undefined || !row.isActive || row.mfaSatisfiedAt !== null) return null;
  // A session of a role that needs no MFA is not "pending" and has no second step to take.
  if (!needsMfa(row.role, row.totpConfirmed)) return null;
  return { userId: row.userId, sid: row.sid, locked: row.locked };
}

/** The pending session is replaced by a full one (a new `sid`). */
async function promote(
  tx: Tx,
  config: AuthConfig,
  context: PendingContext,
  client: ClientInfo,
): Promise<{ token: string; expiresAt: Date }> {
  await revokeSessionRow(tx, context.sid);
  await clearFailures(tx, context.userId);
  const opened = await openSession(tx, config, {
    userId: context.userId,
    client,
    full: true,
    mfaDone: true,
  });
  await markLogin(tx, context.userId, client);
  return { token: opened.token, expiresAt: opened.expiresAt };
}

/** Consumes the step of a valid code once; false when the code is wrong or already used. */
async function consumeTotpStep(
  tx: Tx,
  config: AuthConfig,
  userId: string,
  code: string,
  requireConfirmed: boolean,
): Promise<boolean> {
  const [totp] = await tx
    .select({
      secretEncrypted: authTotp.secretEncrypted,
      confirmedAt: authTotp.confirmedAt,
      lastUsedStep: authTotp.lastUsedStep,
    })
    .from(authTotp)
    .where(eq(authTotp.userId, userId));
  if (totp === undefined || (requireConfirmed && totp.confirmedAt === null)) return false;
  const secret = decryptSecret(totp.secretEncrypted, totpKey(config), userId);
  if (secret === null) return false;
  const step = matchTotp(secret, code, nowOf(config), totp.lastUsedStep);
  if (step === null) return false;
  const claimed = await tx
    .update(authTotp)
    .set({ lastUsedStep: step })
    .where(
      and(
        eq(authTotp.userId, userId),
        sql`(${authTotp.lastUsedStep} IS NULL OR ${authTotp.lastUsedStep} < ${step})`,
      ),
    )
    .returning({ userId: authTotp.userId });
  return claimed.length === 1;
}

export async function verifyTotpLogin(
  tx: Tx,
  config: AuthConfig,
  input: { token: string; code: string; client: ClientInfo },
): Promise<MfaResult> {
  const context = await lockPending(tx, config, input.token);
  if (context === null || context.locked) return { ok: false };
  if (!(await consumeTotpStep(tx, config, context.userId, input.code, true))) {
    await recordFailure(tx, context.userId, input.client);
    return { ok: false };
  }
  return { ok: true, ...(await promote(tx, config, context, input.client)) };
}

/** `xxxxx-xxxxx-xxxxx-xxxxx`, lower-case hex: 80 bits each, HMAC'd at rest, single use. */
function newRecoveryCode(): string {
  const hex = randomBytes(10).toString('hex');
  return [0, 5, 10, 15].map((i) => hex.slice(i, i + 5)).join('-');
}
const normalizeRecovery = (code: string): string => code.trim().toLowerCase().replace(/\s+/g, '');

export async function verifyRecoveryLogin(
  tx: Tx,
  config: AuthConfig,
  input: { token: string; code: string; client: ClientInfo },
): Promise<MfaResult> {
  const context = await lockPending(tx, config, input.token);
  if (context === null || context.locked) return { ok: false };
  const used = await tx
    .update(authRecoveryCodes)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(authRecoveryCodes.userId, context.userId),
        eq(
          authRecoveryCodes.codeHash,
          recoveryHash(normalizeRecovery(input.code), recoveryKey(config)),
        ),
        isNull(authRecoveryCodes.usedAt),
      ),
    )
    .returning({ id: authRecoveryCodes.id });
  if (used.length !== 1) {
    await recordFailure(tx, context.userId, input.client);
    return { ok: false };
  }
  await writeAudit(tx, {
    userId: context.userId,
    action: 'auth.recovery_code_used',
    entity: 'auth_user',
    entityId: context.userId,
    ip: input.client.ip,
  });
  return { ok: true, ...(await promote(tx, config, context, input.client)) };
}

export interface EnrolmentStart {
  secret: string;
  uri: string;
}

/**
 * A fresh, UNCONFIRMED secret for a pending session of someone who has no confirmed TOTP.
 * Calling it again replaces the unconfirmed one; a confirmed secret is never touched.
 */
export async function startTotpEnrolment(
  tx: Tx,
  config: AuthConfig,
  input: { token: string },
): Promise<EnrolmentStart | null> {
  const context = await lockPending(tx, config, input.token);
  if (context === null) return null;
  const [user] = await tx
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, context.userId));
  if (user === undefined) return null;
  const secret = generateTotpSecret();
  const stored = await tx
    .insert(authTotp)
    .values({
      userId: context.userId,
      secretEncrypted: encryptSecret(secret, totpKey(config), context.userId),
    })
    .onConflictDoUpdate({
      target: authTotp.userId,
      set: {
        secretEncrypted: encryptSecret(secret, totpKey(config), context.userId),
        lastUsedStep: null,
      },
      setWhere: isNull(authTotp.confirmedAt),
    })
    .returning({ userId: authTotp.userId });
  if (stored.length !== 1) return null;
  return { secret, uri: otpauthUri(secret, user.email, config.issuer ?? 'Silk admin') };
}

/** Confirms the enrolment with a first code, issues the recovery codes (shown once) and a full session. */
export async function confirmTotpEnrolment(
  tx: Tx,
  config: AuthConfig,
  input: { token: string; code: string; client: ClientInfo },
): Promise<MfaResult> {
  const context = await lockPending(tx, config, input.token);
  if (context === null || context.locked) return { ok: false };
  if (!(await consumeTotpStep(tx, config, context.userId, input.code, false))) {
    await recordFailure(tx, context.userId, input.client);
    return { ok: false };
  }
  const confirmed = await tx
    .update(authTotp)
    .set({ confirmedAt: sql`now()` })
    .where(and(eq(authTotp.userId, context.userId), isNull(authTotp.confirmedAt)))
    .returning({ userId: authTotp.userId });
  if (confirmed.length !== 1) return { ok: false };
  await tx
    .update(adminUsers)
    .set({ totpEnabled: true })
    .where(eq(adminUsers.userId, context.userId));
  await tx.delete(authRecoveryCodes).where(eq(authRecoveryCodes.userId, context.userId));
  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await tx.insert(authRecoveryCodes).values(
    recoveryCodes.map((code) => ({
      userId: context.userId,
      codeHash: recoveryHash(code, recoveryKey(config)),
    })),
  );
  await writeAudit(tx, {
    userId: context.userId,
    action: 'auth.totp_enrolled',
    entity: 'auth_user',
    entityId: context.userId,
    ip: input.client.ip,
  });
  const promoted = await promote(tx, config, context, input.client);
  return { ok: true, ...promoted, recoveryCodes };
}

// ─── accounts ──────────────────────────────────────────────────────────────────────────────────

export class WeakPasswordError extends Error {
  constructor(reason: string) {
    super(`password refused: ${reason}`);
    this.name = 'WeakPasswordError';
  }
}

export async function adminUserExists(db: Reader, email: string): Promise<boolean> {
  const rows = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(sql`lower(${authUsers.email}) = ${email.trim().toLowerCase()}`);
  return rows.length > 0;
}

/** Creates an admin user (a seed or the owner's CLI; there is no public sign-up). */
export async function createAdminUser(
  tx: Tx,
  input: { email: string; password: string; role: AdminRole; actorId?: string | null },
): Promise<{ userId: string }> {
  const email = z.email().parse(input.email.trim().toLowerCase());
  const password = passwordSchema.safeParse(input.password);
  if (!password.success)
    throw new WeakPasswordError(password.error.issues[0]?.message ?? 'invalid');
  const namePart = email.split('@')[0] ?? email;
  // Only a name long enough to mean something: a one-letter name would refuse most passwords.
  if (namePart.length >= 4 && input.password.toLowerCase().includes(namePart)) {
    throw new WeakPasswordError('must not contain the email name');
  }
  const [user] = await tx.insert(authUsers).values({ email }).returning({ id: authUsers.id });
  if (user === undefined) throw new Error('user insert returned no row');
  await tx
    .insert(authCredentials)
    .values({ userId: user.id, passwordHash: await hashPassword(input.password) });
  await tx.insert(adminUsers).values({ userId: user.id, role: input.role });
  await writeAudit(tx, {
    userId: input.actorId ?? null,
    action: 'create',
    entity: 'admin_user',
    entityId: user.id,
    diff: { role: input.role },
  });
  return { userId: user.id };
}

/**
 * Lifts a lock (the owner's recovery from a lockout, `pnpm admin:unlock`). Audited; the failure
 * counter restarts. Returns false when no such account exists.
 */
export async function unlockAccount(tx: Tx, input: { email: string }): Promise<boolean> {
  const email = input.email.trim().toLowerCase();
  const [user] = await tx
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(sql`lower(${authUsers.email}) = ${email}`);
  if (user === undefined) return false;
  await lockAccount(tx, user.id);
  await clearFailures(tx, user.id);
  await writeAudit(tx, {
    userId: null,
    action: 'auth.unlocked',
    entity: 'auth_user',
    entityId: user.id,
  });
  return true;
}

/** Constant-time check that a posted value equals an expected one (CSRF tokens, origins). */
export const sameSecret = constantTimeEqual;
