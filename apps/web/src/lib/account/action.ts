import type { CustomerSession } from '@store/core/customer-session';
import type { Tx } from '@store/db/types';
import type { z } from 'zod';

import { requestOriginOk } from '../admin/bound-action';
import { getDb } from '../db';
import { createRateLimiter } from '../rate-limit';
import { checkLimit, currentClient } from '../request-limits';

import { currentCustomer } from './session';

const INVALID_CODES: readonly string[] = [
  'ADDRESS_LIMIT',
  'ALERT_AVAILABLE',
  'ALERT_LIMIT',
  'WISHLIST_FULL',
  'REVIEW_EXISTS',
  'REVIEW_RATE',
  'RETURN_ITEMS',
  'RETURN_LIMIT',
  'RETURN_REASON',
];

/** Mutations of a signed-in customer: a person edits a few things a minute, a script hundreds. */
const limiter = createRateLimiter({ limit: 60, windowMs: 60_000 });

export type CustomerActionResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; code: 'unauthorized' | 'invalid' | 'rateLimited' | 'notFound' | 'error' };

/**
 * The one way a customer's server action runs. Order matters: Origin (CSRF), then the session read
 * from the database, then the per-client limit, then the input is parsed. A request with no session is
 * refused before its body is read. The body runs in a transaction with the account (never an id from
 * the request) as the author.
 */
export async function customerAction<S extends z.ZodType, T>(
  input: unknown,
  schema: S,
  run: (
    tx: Tx,
    who: { customer: CustomerSession; ip: string | null },
    data: z.output<S>,
  ) => Promise<T>,
  options: { notFoundCodes?: readonly string[] } = {},
): Promise<CustomerActionResult<T>> {
  if (!(await requestOriginOk())) return { ok: false, code: 'error' };
  const customer = await currentCustomer();
  if (customer === null) return { ok: false, code: 'unauthorized' };
  if (!(await checkLimit(limiter, customer.customerId)).allowed) {
    return { ok: false, code: 'rateLimited' };
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'invalid' };
  const client = await currentClient();
  const ip = client === 'unknown' ? null : client;
  try {
    const db = await getDb();
    const value = await db.transaction(async (tx) => await run(tx, { customer, ip }, parsed.data));
    return { ok: true, value };
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if ((options.notFoundCodes ?? ['ADDRESS_NOT_FOUND']).includes(code)) {
      return { ok: false, code: 'notFound' };
    }
    // A refusal the person caused (a limit, a duplicate, a size that can be bought now): the UI says so, no error is logged.
    if (INVALID_CODES.includes(code) || code.startsWith('CHECKOUT_')) {
      return { ok: false, code: 'invalid' };
    }
    process.stderr.write(
      `${JSON.stringify({ level: 'error', scope: 'account-action', name: error instanceof Error ? error.name : 'unknown' })}\n`,
    );
    return { ok: false, code: 'error' };
  }
}
