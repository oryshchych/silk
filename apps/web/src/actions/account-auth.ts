'use server';

import {
  completeWithToken,
  customerLogin,
  requestPasswordReset,
  requestRegistration,
} from '@store/core/customer-auth';
import { logoutCustomer } from '@store/core/customer-session';
import type { ClientInfo } from '@store/core/auth';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { requestOriginOk } from '@/lib/admin/bound-action';
import { authConfig, cookiesAreSecure } from '@/lib/admin/config';
import { customerCookieName, customerCookieOptions } from '@/lib/account/cookies';
import { currentCustomer } from '@/lib/account/session';
import { getDb } from '@/lib/db';
import { href, paths } from '@/lib/paths';
import { createRateLimiter, type RateLimiter } from '@/lib/rate-limit';
import { checkLimit, currentClient } from '@/lib/request-limits';
import { createSemaphore } from '@/lib/semaphore';

/**
 * Credential actions of the customer account. None needs a session (nobody has one yet); what
 * protects them: the Origin check, a per-client limit (here AND in `proxy.ts`), the account lockout
 * and the per-account mail cap in `@store/core/customer-auth`, and an answer that never says whether
 * an address has an account.
 */
export type AccountFormState =
  | { status: 'idle' }
  | { status: 'sent' }
  | { status: 'error'; code: 'invalid' | 'weak' | 'rateLimited' | 'error' };

const credentialWork = createSemaphore(3, 6);
const loginLimiter = createRateLimiter({ limit: 10, windowMs: 10 * 60_000 });
/** Mails: a person asks once or twice; a script asks for thousands of inboxes. */
const registerLimiter = createRateLimiter({ limit: 10, windowMs: 60 * 60_000 });
const forgotLimiter = createRateLimiter({ limit: 10, windowMs: 60 * 60_000 });
const setLimiter = createRateLimiter({ limit: 10, windowMs: 10 * 60_000 });

const locale = z.enum(['uk', 'en']);
const emailField = z.string().trim().min(3).max(320).pipe(z.email());
const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1).max(256),
  locale,
});
const mailSchema = z.object({ email: emailField, locale });
const setSchema = z.object({
  token: z.string().min(1).max(200),
  password: z.string().min(1).max(256),
  locale,
});

async function clientInfo(): Promise<ClientInfo> {
  const list = await headers();
  const ip = await currentClient();
  return { ip: ip === 'unknown' ? null : ip, userAgent: list.get('user-agent') };
}

type Gate = { ok: true } | { ok: false; code: 'error' | 'rateLimited' };

/** Origin first, then the per-client limit, both before anything touches the database. */
async function gate(limiter: RateLimiter): Promise<Gate> {
  if (!(await requestOriginOk())) return { ok: false, code: 'error' };
  if (!(await checkLimit(limiter)).allowed) return { ok: false, code: 'rateLimited' };
  return { ok: true };
}

async function setSession(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(
    customerCookieName(await cookiesAreSecure()),
    token,
    customerCookieOptions(expiresAt, await cookiesAreSecure()),
  );
}

export async function customerLoginAction(input: unknown): Promise<AccountFormState> {
  const allowed = await gate(loginLimiter);
  if (!allowed.ok) return { status: 'error', code: allowed.code };
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) return { status: 'error', code: 'invalid' };
  const config = await authConfig();
  const db = await getDb();
  const client = await clientInfo();
  const result = await credentialWork.run(
    async () =>
      await db.transaction(
        async (tx) =>
          await customerLogin(tx, config, {
            email: parsed.data.email,
            password: parsed.data.password,
            client,
          }),
      ),
  );
  if (!result.ran) return { status: 'error', code: 'rateLimited' };
  if (!result.value.ok) return { status: 'error', code: 'invalid' };
  await setSession(result.value.token, result.value.expiresAt);
  redirect(href(parsed.data.locale, paths.account));
}

/** Step 1 of registration: an address only. The answer is the same for every address. */
export async function registerAction(input: unknown): Promise<AccountFormState> {
  const allowed = await gate(registerLimiter);
  if (!allowed.ok) return { status: 'error', code: allowed.code };
  const parsed = mailSchema.safeParse(input);
  if (!parsed.success) return { status: 'error', code: 'invalid' };
  const db = await getDb();
  const client = await clientInfo();
  await db.transaction(async (tx) => {
    await requestRegistration(tx, {
      email: parsed.data.email,
      locale: parsed.data.locale,
      client,
    });
  });
  return { status: 'sent' };
}

export async function forgotPasswordAction(input: unknown): Promise<AccountFormState> {
  const allowed = await gate(forgotLimiter);
  if (!allowed.ok) return { status: 'error', code: allowed.code };
  const parsed = mailSchema.safeParse(input);
  if (!parsed.success) return { status: 'error', code: 'invalid' };
  const db = await getDb();
  const client = await clientInfo();
  await db.transaction(async (tx) => {
    await requestPasswordReset(tx, {
      email: parsed.data.email,
      locale: parsed.data.locale,
      client,
    });
  });
  return { status: 'sent' };
}

/** Step 2 of registration and the end of a reset: the link's token and the new password. */
export async function setPasswordAction(input: unknown): Promise<AccountFormState> {
  const allowed = await gate(setLimiter);
  if (!allowed.ok) return { status: 'error', code: allowed.code };
  const parsed = setSchema.safeParse(input);
  if (!parsed.success) return { status: 'error', code: 'invalid' };
  const config = await authConfig();
  const db = await getDb();
  const client = await clientInfo();
  const result = await credentialWork.run(
    async () =>
      await db.transaction(
        async (tx) =>
          await completeWithToken(tx, config, {
            token: parsed.data.token,
            password: parsed.data.password,
            client,
          }),
      ),
  );
  if (!result.ran) return { status: 'error', code: 'rateLimited' };
  if (!result.value.ok) {
    return { status: 'error', code: result.value.reason === 'weak_password' ? 'weak' : 'invalid' };
  }
  redirect(`${href(parsed.data.locale, '/account/login')}?done=1`);
}

export async function customerLogoutAction(input: unknown): Promise<void> {
  const parsed = z.object({ locale }).safeParse(input);
  const chosen = parsed.success ? parsed.data.locale : 'uk';
  // A foreign page must not be able to sign a visitor out: nothing happens without the Origin check.
  if (await requestOriginOk()) {
    const customer = await currentCustomer();
    if (customer !== null) {
      const db = await getDb();
      await db.transaction(async (tx) => {
        await logoutCustomer(tx, { sid: customer.sid, userId: customer.userId });
      });
    }
    const store = await cookies();
    store.delete({ name: customerCookieName(await cookiesAreSecure()), path: '/' });
  }
  redirect(href(chosen, '/account/login'));
}
