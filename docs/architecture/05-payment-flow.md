## 6. Потік оплати

```
Клієнт → server action createOrder()
  └─ транзакція:
       1. перерахувати кошик з БД (ціни з БД, не з запиту)
       2. валідувати промокод з усіма обмеженнями
       3. атомарно зарезервувати всі позиції
       4. insert orders + order_items (снапшоти)
       5. insert promo_code_redemptions
     commit
  └─ PaymentProvider.createPayment(order)
  └─ redirect на сторінку провайдера

Провайдер → POST /api/webhooks/{provider}
  1. прочитати raw body ДО парсингу (потрібне для перевірки підпису)
  2. перевірити підпис → невалідний: 4xx + лог
  3. insert payment_events (provider, external_id) → конфлікт: 200 і вихід
  4. транзакція: змапити статус, оновити order і captured_total.
     РЕЗЕРВ НЕ ЗВІЛЬНЯЄТЬСЯ і stock_quantity НЕ змінюється (ADR-18):
     оплата лише знімає expires_at. Списання складу — при shipped.
     insert order_status_history + outbox
  5. поставити задачу в pg-boss: email клієнту
  6. відповісти провайдеру у ЙОГО форматі
     (WayForPay вимагає підписаний JSON, інакше ретраїть)

Браузер → /order/success/{number}
  polling статусу, ніяких мутацій
```

`PaymentProvider`:

```ts
interface PaymentProvider {
  readonly code: 'mono' | 'wayforpay';

  /**
   * Приймає СПРОБУ, не замовлення. Спроба вже створена в БД зі своїм
   * localReference (ADR-11), тому при втраті відповіді ми знаємо, що
   * питати, і не створюємо другий інвойс.
   *
   * Може повернути externalIdUnknown: для Mono lookup статусу робиться за
   * invoiceId, а не за нашим reference, тому «загублена відповідь» —
   * окремий результат, а не помилка.
   */
  createPayment(attempt: PaymentAttempt): Promise<
    | { ok: true; redirectUrl: string; externalId: string }
    | { ok: false; externalIdUnknown: true }
  >;

  /** Активна звірка. Обов'язкова: вебхук може не доїхати (ADR-4) */
  getPaymentStatus(attempt: PaymentAttempt): Promise<PaymentStatusResult>;

  verifyWebhook(rawBody: string, headers: Headers): Promise<WebhookResult | null>;

  /**
   * Приймає RefundOperation з власним localReference, не (order, amount).
   * Таймаут → state 'unknown' → звірка, НЕ повторний виклик.
   */
  refund(op: RefundOperation): Promise<RefundResult>;

  /** Викликається ЗАВЖДИ, включно з гілкою дубля (WayForPay ретраїть) */
  buildWebhookResponse(result: WebhookResult | { duplicate: true }): Response;
}
```

Провайдер вмикається тумблером у `settings`. Це дає можливість порівняти реальні комісії Mono і WayForPay на власному обороті й обрати дешевшу, а також перемкнутись за хвилину, якщо одну з них вимкнули.

---

## 7. Статуси

**`orders.status`** (фулфілмент):
`pending → confirmed → processing → shipped → delivered`
плюс `cancelled` (з будь-якого до `shipped`), `returned` (з `delivered`).

**`orders.payment_status`** (гроші):
`pending → authorized → paid`, плюс `failed`, `expired`, `refunded`, `partially_refunded`.

Два поля, а не одне. Замовлення може бути `paid` + `processing`, або `pending` + `confirmed` (COD). Спроба зліпити це в один enum завжди закінчується станами типу `paid_but_not_shipped_and_partially_refunded`.

Переходи описані як таблиця дозволених пар у `packages/core/orders/transitions.ts`. Недозволений перехід кидає помилку. Кожен перехід пише в `order_status_history` з автором і коментарем.

---
