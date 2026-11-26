/**
 * The two buttons that close a refund whose answer is unknown. The outcome is MONEY: "the money was
 * returned" moves the order's refunded total, enqueues a fiscal return receipt and emails the buyer,
 * so a button that says "not returned" must never be read as "returned". The outcome therefore
 * travels as the value of the clicked button (`name="outcome"`), is parsed strictly here, and
 * anything that is not exactly one of the two values produces NO action at all.
 */
export const REFUND_OUTCOMES = { sent: 'succeeded', notSent: 'failed' } as const;
export type RefundOutcome = (typeof REFUND_OUTCOMES)[keyof typeof REFUND_OUTCOMES];
export const OUTCOME_FIELD = 'outcome';

export function parseOutcome(value: unknown): RefundOutcome | null {
  if (value === REFUND_OUTCOMES.sent) return REFUND_OUTCOMES.sent;
  if (value === REFUND_OUTCOMES.notSent) return REFUND_OUTCOMES.notSent;
  return null;
}

/** The argument of `resolveRefundAction`, or null when the submitter says nothing we recognise. */
export function resolvePayload(
  operationId: string,
  submitted: unknown,
  note: string,
): { operationId: string; outcome: RefundOutcome; note: string } | null {
  const outcome = parseOutcome(submitted);
  return outcome === null ? null : { operationId, outcome, note };
}
