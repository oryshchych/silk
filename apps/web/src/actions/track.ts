'use server';

import { findOrderForTracking } from '@store/core/order-lookup';
import type { TrackedOrderDto } from '@store/shared/dto/order';

import { RATE_LIMITED, type ActionFailure } from '@/lib/action-result';
import { trackSchema } from '@/lib/checkout-schemas';
import { getDb } from '@/lib/db';
import { checkLimit, limiters } from '@/lib/request-limits';

export type TrackResult = { ok: true; order: TrackedOrderDto } | ActionFailure;

/**
 * Order number plus the phone it was placed with. The number is sequential, so the answer for a
 * wrong number and a wrong phone is the same, the call is limited per client, and the phone
 * travels in a POST body, never in a URL.
 */
export async function trackOrderAction(input: unknown): Promise<TrackResult> {
  const verdict = await checkLimit(limiters.track);
  if (!verdict.allowed) {
    return { ok: false, code: RATE_LIMITED, retryAfterSeconds: verdict.retryAfterSeconds };
  }
  const parsed = trackSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'TRACK_NOT_FOUND' };
  const order = await findOrderForTracking(
    await getDb(),
    parsed.data.orderNumber,
    parsed.data.phone,
  );
  return order === null ? { ok: false, code: 'TRACK_NOT_FOUND' } : { ok: true, order };
}
