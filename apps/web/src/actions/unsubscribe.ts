'use server';

import { unsubscribeByToken } from '@store/core/account-alerts';
import { unsubscribeMarketingByToken } from '@store/core/marketing';
import { z } from 'zod';

import { requestOriginOk } from '@/lib/admin/bound-action';
import { authConfig } from '@/lib/admin/config';
import { getDb } from '@/lib/db';
import { createRateLimiter } from '@/lib/rate-limit';
import { checkLimit } from '@/lib/request-limits';

const limiter = createRateLimiter({ limit: 20, windowMs: 10 * 60_000 });

export type UnsubscribeResult =
  { status: 'done' } | { status: 'error'; code: 'invalid' | 'rateLimited' };

/**
 * The link in a back-in-stock mail. No session: the signed alert id IS the credential. Opening the page
 * changes nothing (a mail scanner may fetch it); this POST does. A forged or foreign token does nothing.
 */
export async function unsubscribeStockAlertAction(input: unknown): Promise<UnsubscribeResult> {
  const parsed = z.object({ token: z.string().min(1).max(200) }).safeParse(input);
  if (!parsed.success) return { status: 'error', code: 'invalid' };
  // The link is opened in the browser and its button posts from the same site: a foreign Origin is refused.
  if (!(await requestOriginOk())) return { status: 'error', code: 'invalid' };
  if (!(await checkLimit(limiter)).allowed) return { status: 'error', code: 'rateLimited' };
  const config = await authConfig();
  const db = await getDb();
  const ok = await db.transaction(
    async (tx) => await unsubscribeByToken(tx, config.secret, parsed.data.token),
  );
  return ok ? { status: 'done' } : { status: 'error', code: 'invalid' };
}

/**
 * The link in a marketing mail (cart reminder, newsletter): the signed subscriber id is the credential.
 * Same rules as the alert link: opening the page changes nothing, this POST does; a foreign Origin, a
 * forged token or a flood does nothing. Withdrawing twice is still "done".
 */
export async function unsubscribeMarketingAction(input: unknown): Promise<UnsubscribeResult> {
  const parsed = z.object({ token: z.string().min(1).max(200) }).safeParse(input);
  if (!parsed.success) return { status: 'error', code: 'invalid' };
  if (!(await requestOriginOk())) return { status: 'error', code: 'invalid' };
  if (!(await checkLimit(limiter)).allowed) return { status: 'error', code: 'rateLimited' };
  const config = await authConfig();
  const db = await getDb();
  const ok = await db.transaction(
    async (tx) => await unsubscribeMarketingByToken(tx, config.secret, parsed.data.token),
  );
  return ok ? { status: 'done' } : { status: 'error', code: 'invalid' };
}
