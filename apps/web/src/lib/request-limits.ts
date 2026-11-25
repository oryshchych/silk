import { headers } from 'next/headers';

import { clientAddress, UNKNOWN_CLIENT } from './client-address';
import { createRateLimiter, type RateLimiter } from './rate-limit';
import { runtimeEnv } from './runtime-env';

/**
 * Per-client limits for the checkout routes and actions (in process memory, like
 * the search limit: a guard against loops and scripts, not a guarantee across
 * instances; the shared limiter is phase 12). The client address comes ONLY from
 * `clientAddress`, which trusts exactly `TRUSTED_PROXY_HOPS` proxies.
 */
const trustedHopsOf = async (): Promise<number> => (await runtimeEnv()).TRUSTED_PROXY_HOPS ?? 1;

export const limiters = {
  cart: createRateLimiter({ limit: 60, windowMs: 60_000 }),
  quote: createRateLimiter({ limit: 60, windowMs: 60_000 }),
  /** Quotes that carry a promo code: a person tries a few, a script guesses codes. */
  quotePromo: createRateLimiter({ limit: 10, windowMs: 10 * 60_000 }),
  /** Placing orders: a person needs a handful, a script needs hundreds. */
  place: createRateLimiter({ limit: 10, windowMs: 10 * 60_000 }),
  /** COD per (phone, client): the series of fake cash-on-delivery orders (ADR-3). */
  codPhone: createRateLimiter({ limit: 5, windowMs: 60 * 60_000 }),
  track: createRateLimiter({ limit: 10, windowMs: 10 * 60_000 }),
  np: createRateLimiter({ limit: 120, windowMs: 60_000 }),
  /** Starting a card payment from the order page: a person retries a few times. */
  pay: createRateLimiter({ limit: 10, windowMs: 10 * 60_000 }),
  /** Provider callbacks per client: a provider sends a handful, retries included. */
  webhook: createRateLimiter({ limit: 600, windowMs: 60_000 }),
  /**
   * Refused (unverified) bodies STORED per minute over all clients: past it a refused message is
   * still answered 400 but not written to the quarantine. Genuine callbacks never touch it.
   */
  webhookRefused: createRateLimiter({ limit: 300, windowMs: 60_000, maxKeys: 1 }),
} as const satisfies Record<string, RateLimiter>;

/** The client key of the current request, from the trusted proxy hop. */
export async function currentClient(): Promise<string> {
  return clientAddress((await headers()).get('x-forwarded-for'), await trustedHopsOf());
}

export interface LimitVerdict {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** Checks a limiter for the current client (plus an optional suffix such as a phone number). */
export async function checkLimit(limiter: RateLimiter, suffix = ''): Promise<LimitVerdict> {
  const client = await currentClient();
  if (client === UNKNOWN_CLIENT) {
    process.stderr.write(
      `${JSON.stringify({ level: 'warn', scope: 'rate-limit', reason: 'no trustworthy client address, shared bucket' })}\n`,
    );
  }
  return limiter.check(suffix === '' ? client : `${client}|${suffix}`);
}

/** The same check for a route handler, which has the request in hand. */
export async function checkRequestLimit(
  limiter: RateLimiter,
  request: Request,
): Promise<LimitVerdict> {
  return limiter.check(
    clientAddress(request.headers.get('x-forwarded-for'), await trustedHopsOf()),
  );
}

/** The client address of a route-handler request, or null when it cannot be trusted. */
export async function clientAddressOf(request: Request): Promise<string | null> {
  const client = await requestClient(request);
  return client === UNKNOWN_CLIENT ? null : client;
}

/** The client key of a route-handler request (same trusted hop as every other limit). */
export async function requestClient(request: Request): Promise<string> {
  return clientAddress(request.headers.get('x-forwarded-for'), await trustedHopsOf());
}
