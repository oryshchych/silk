/**
 * 15 замовлень, що покривають усі `order_status` і всі `payment_status`.
 * Кожен сценарій узгоджений із семантикою складу (ADR-18) і оплат (ADR-11):
 *
 *   резерв `ttl`      — створено, чекає оплати / підтвердження COD (expires_at за TTL)
 *   резерв `held`     — оплачено або COD підтверджено: тримається до відправлення
 *   резерв `shipped`  — відправлено: резерв закрито, склад уже зменшено
 *   резерв `cancelled` / `expired` — закрито без зміни складу
 */
type Provider = 'mono' | 'wayforpay' | 'cod' | 'bank_transfer';
export type OrderStatus =
  'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'returned';
export type PaymentStatus =
  'pending' | 'authorized' | 'paid' | 'failed' | 'expired' | 'refunded' | 'partially_refunded';
export type AttemptOutcome = 'pending' | 'authorized' | 'paid' | 'failed' | 'expired';
type Reservation = 'ttl' | 'held' | 'shipped' | 'cancelled' | 'expired';
type Delivery = 'np_warehouse' | 'np_courier' | 'pickup';

export interface Scenario {
  status: OrderStatus;
  payment: PaymentStatus;
  provider: Provider;
  /** Спроби оплати по порядку; остання — поточна (`current_payment_attempt_id`). */
  attempts: AttemptOutcome[];
  reservation: Reservation;
  daysAgo: number;
  /** Індекс клієнта або null — гість. */
  customer: number | null;
  lines: number;
  delivery: Delivery;
  promo?: 'WELCOME10' | 'MINUS200' | 'FREESHIP' | 'BRAS15';
  /** Повернення: `full` — усі позиції й повний refund, `partial` — одна позиція. */
  returns?: { status: 'requested' | 'refunded' | 'closed'; scope: 'full' | 'partial' };
}

export const SCENARIOS: Scenario[] = [
  // Щойно створені: резерв із TTL методу оплати (ADR-3).
  {
    status: 'pending',
    payment: 'pending',
    provider: 'mono',
    attempts: ['pending'],
    reservation: 'ttl',
    daysAgo: 0,
    customer: 0,
    lines: 1,
    delivery: 'np_warehouse',
  },
  {
    status: 'pending',
    payment: 'pending',
    provider: 'cod',
    attempts: ['pending'],
    reservation: 'ttl',
    daysAgo: 0,
    customer: null,
    lines: 2,
    delivery: 'np_warehouse',
  },
  // Підтверджені: COD менеджером; картка — лише авторизація (холд).
  {
    status: 'confirmed',
    payment: 'pending',
    provider: 'cod',
    attempts: ['pending'],
    reservation: 'held',
    daysAgo: 1,
    customer: 1,
    lines: 1,
    delivery: 'np_courier',
  },
  {
    status: 'confirmed',
    payment: 'authorized',
    provider: 'wayforpay',
    attempts: ['authorized'],
    reservation: 'held',
    daysAgo: 1,
    customer: 2,
    lines: 2,
    delivery: 'np_warehouse',
    promo: 'BRAS15',
  },
  // «Не вистачило коштів → інша карта»: дві спроби, одне замовлення (ADR-11).
  {
    status: 'processing',
    payment: 'paid',
    provider: 'wayforpay',
    attempts: ['failed', 'paid'],
    reservation: 'held',
    daysAgo: 2,
    customer: 7,
    lines: 2,
    delivery: 'np_warehouse',
    promo: 'WELCOME10',
  },
  {
    status: 'shipped',
    payment: 'paid',
    provider: 'mono',
    attempts: ['paid'],
    reservation: 'shipped',
    daysAgo: 5,
    customer: 3,
    lines: 1,
    delivery: 'np_warehouse',
  },
  {
    status: 'shipped',
    payment: 'pending',
    provider: 'cod',
    attempts: ['pending'],
    reservation: 'shipped',
    daysAgo: 4,
    customer: null,
    lines: 1,
    delivery: 'np_warehouse',
  },
  {
    status: 'delivered',
    payment: 'paid',
    provider: 'mono',
    attempts: ['paid'],
    reservation: 'shipped',
    daysAgo: 12,
    customer: 4,
    lines: 2,
    delivery: 'np_warehouse',
    promo: 'FREESHIP',
  },
  {
    status: 'delivered',
    payment: 'paid',
    provider: 'cod',
    attempts: ['paid'],
    reservation: 'shipped',
    daysAgo: 15,
    customer: 5,
    lines: 2,
    delivery: 'np_warehouse',
  },
  {
    status: 'delivered',
    payment: 'paid',
    provider: 'bank_transfer',
    attempts: ['paid'],
    reservation: 'shipped',
    daysAgo: 20,
    customer: 6,
    lines: 3,
    delivery: 'pickup',
    promo: 'MINUS200',
  },
  // Скасовані: резерв закрито, склад не змінюється (ADR-18).
  {
    status: 'cancelled',
    payment: 'expired',
    provider: 'mono',
    attempts: ['expired'],
    reservation: 'expired',
    daysAgo: 6,
    customer: 0,
    lines: 1,
    delivery: 'np_warehouse',
  },
  {
    status: 'cancelled',
    payment: 'failed',
    provider: 'wayforpay',
    attempts: ['failed'],
    reservation: 'cancelled',
    daysAgo: 7,
    customer: null,
    lines: 1,
    delivery: 'np_warehouse',
  },
  // Повернення: повне, часткове й щойно подане.
  {
    status: 'returned',
    payment: 'refunded',
    provider: 'mono',
    attempts: ['paid'],
    reservation: 'shipped',
    daysAgo: 25,
    customer: 1,
    lines: 2,
    delivery: 'np_warehouse',
    returns: { status: 'closed', scope: 'full' },
  },
  {
    status: 'delivered',
    payment: 'partially_refunded',
    provider: 'mono',
    attempts: ['paid'],
    reservation: 'shipped',
    daysAgo: 22,
    customer: 3,
    lines: 2,
    delivery: 'np_warehouse',
    returns: { status: 'refunded', scope: 'partial' },
  },
  {
    status: 'delivered',
    payment: 'paid',
    provider: 'wayforpay',
    attempts: ['paid'],
    reservation: 'shipped',
    daysAgo: 9,
    customer: 4,
    lines: 1,
    delivery: 'np_warehouse',
    returns: { status: 'requested', scope: 'partial' },
  },
];

/** Шлях статусу замовлення до цільового — для `order_status_history`. */
export function statusPath(target: OrderStatus): OrderStatus[] {
  if (target === 'cancelled') return ['pending', 'cancelled'];
  const forward: OrderStatus[] = ['pending', 'confirmed', 'processing', 'shipped', 'delivered'];
  if (target === 'returned') return [...forward, 'returned'];
  return forward.slice(0, forward.indexOf(target) + 1);
}
