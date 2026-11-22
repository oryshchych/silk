/**
 * Allowed `orders.status` transitions (docs/architecture/05-payment-flow.md
 * section 7). Anything not listed is refused by the operations that move the
 * status; a refused transition is an error, never a silent no-op.
 *
 * SKELETON DEVIATION: `pending` and `confirmed` may go straight to `shipped`,
 * because the one-step admin transitions (confirmed, processing) arrive with
 * phase 5. The history records the jump. Remove those two entries then.
 */
export type OrderStatus =
  'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'returned';

export const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['confirmed', 'shipped', 'cancelled'],
  confirmed: ['processing', 'shipped', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['returned'],
  cancelled: [],
  returned: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
