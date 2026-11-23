## Фаза 3 — Оплати (1–1.5 тижня)

**Мета:** гроші приходять, статус змінюється, залишки не течуть.

**Обсяг:**
- `PaymentProvider` у `packages/payments`.
- **Plata by mono** перший: створення інвойсу, вебхук з перевіркою підпису публічним ключем (кешувати), мапінг статусів.
- **WayForPay** другий: HMAC_MD5 підпис, і головне — коректно підписана відповідь на колбек, інакше ретраї годинами.
- COD з лімітом суми; банківський переказ.
- **Подарункові сертифікати — НЕ реалізуються** (заборонені на 2-й групі,
  питання №2). Лише шви з `GIFT_CARDS.md` §0: оплата як набір спроб,
  refund за спробою, відмова checkout для `gift_card`.
- `payment_events` з `UNIQUE(provider, external_id)`.
- Життєвий цикл замовлення, `order_status_history`.
- Резервація → реальне списання при `paid`; повернення на склад при `failed` / `cancelled` / `expired`.
- Повернення коштів, повні й часткові.
- **`FiscalProvider` + реалізація Checkbox** (питання №1, ADR-16): картка —
  чек після вебхука; COD — чек на товар при передачі на пошту, форма оплати
  «Післяплата»; переказ на IBAN — `not_required`. Чек повернення посилається
  на первинний. Live-активація — після акаунта Checkbox.

**Acceptance criteria** (status of 2026-11-23; evidence is by execution against local fakes of the providers; the tree is `main` after PRs #58, #59 and #60; on it `pnpm verify` 627 unit, `pnpm test:int` 400, `pnpm smoke:web` 139 checks):
- [x] `paid` is set ONLY by a verified source and a GET of `/order/success` changes nothing: `pnpm smoke:web` ("GET /order/success never changes the status", "the order is paid by the webhook only"), `payments-flow.int.test.ts` (reconciliation is a second verified source, ADR-4).
- [x] The same webhook five times is applied once: `webhook.int.test.ts` ("criterion 5", Mono and, in "WayForPay through the same pipeline", five parallel deliveries with a signed accept on every answer), `pnpm smoke:web` (five identical callbacks, one event, one history row, one email queued).
- [x] Two DIFFERENT events for one order at once (`authorized` plus `paid`) do not take stock twice and the row lock holds (ADR-4): `webhook.int.test.ts` ("authorized and paid arriving together", "equal timestamps: paid wins whichever arrives first"); stock is untouched by payment (ADR-18).
- [x] "Another card" creates a second `payment_attempts` row, never a second order and never a second reservation (ADR-11): `payments-flow.int.test.ts` ("another card", "a second request while the invoice is live reuses it", "a double click ... opens exactly one invoice"), `pnpm smoke:web` (a declined payment, then `payOrderAction`: two attempts, one order, one reservation, reserved counters unchanged).
- [x] A failing `FiscalProvider` (503) does not roll back the payment; the order gets `fiscal_status = 'failed'` and an alert: `fiscal.int.test.ts` ("a 503 ... the retry makes ONE receipt", "when the retries run out ... failed, ONE alert", "a definite refusal fails at once").
- [x] An invalid signature gives 4xx and a row in `webhook_quarantine`, NOT in `payment_events`; garbage with the right reference first, then the genuine message applies: `webhook.int.test.ts` (Mono "criterion 6" and WayForPay), `pnpm smoke:web` (400, quarantine row, no event, then 200 and paid). The quarantine is bounded (cap 5000, 14 days, `quarantine.cleanup`): `webhook.int.test.ts`, `payments-jobs.int.test.ts`.
- [x] A webhook that arrives BEFORE the redirect is processed correctly: `webhook.int.test.ts` ("criterion 7"), `pnpm smoke:web` (the order is paid before the buyer returns to the shop).
- [x] Cancellation releases the reservation and the per-variant sum matches (ADR-18: `stock_quantity` is unchanged, `reserved_quantity` equals the live reservations): `fulfilment.int.test.ts`, `checkout.int.test.ts` (expiry), `payments-flow.int.test.ts` (a confirmed COD order is not expired).
- [x] A partial refund is visible in the history: `refund.int.test.ts` (`partially_refunded`, the `refund` history row and audit), `fiscal.int.test.ts` (a partial refund also makes a one-line return receipt).
- [ ] Sandbox payment end to end on staging for both providers. NOT done: no merchant credentials exist (owner queue Q13 Mono token, Q32 WayForPay and the facts to confirm). Everything up to the provider is proven on the built app against local fakes (`pnpm smoke:web`, 125 checks).
- [ ] Every transactional email checked in DARK mode in Gmail (iOS and web) and Outlook. NOT done: needs those clients. Proven instead (`email-dark.unit.test.ts`): both colour schemes declared (`color-scheme` meta and CSS, Outlook.com `data-ogsc`/`data-ogsb` overrides), WCAG AA contrast of every text, muted and link colour on its ground in light and dark, a TEXT wordmark (no image to vanish). The owner checks the five emails in the clients (owner queue Q33).
- [x] Receipts (against the Checkbox fake): card gives a `fiscal_documents` row after the webhook; COD gives one when shipped with the "cash on delivery" payment form; a transfer is `not_required`: `fiscal.int.test.ts`. [ ] The same against the Checkbox SANDBOX: NOT done (no account, Q3, Q32).
- [ ] The return receipt carries the fiscal number of the primary receipt. Proven: the return document points at the sale (`parent_document_id`), is sent with the primary receipt id (`related_receipt_id`) and waits until the primary has a fiscal number (`fiscal.int.test.ts`). NOT proven: that Checkbox prints the number (the adapter does not send it, the real shape of a return is unconfirmed, Q32).
- [x] Gift-card seam: a direct `createOrder` with `paymentProvider = 'gift_card'` or a `gift_card` product is an error and creates no order: `create-order.int.test.ts` ("rejects the gift card provider and gift card products without creating an order").
- [x] Seam: two attempts by different providers give `captured_total` equal to the sum, and a refund goes to the provider of ITS attempt: `webhook.int.test.ts` ("a superseded attempt can still be paid late; money is summed over attempts", "a live invoice cannot be replaced ... paying both raises a double-payment alert"), `refund.int.test.ts` (routing by `payment_attempt_id`).
- [x] `grep` over `.next/static` finds no secret: `pnpm smoke:web` ("no secret value appears in .next/static": the app runs with distinctive test secrets and the whole client bundle is scanned).

**Caveats that apply to every checked line above:**
- The worker is not deployed (owner queue Q31): reconciliation, the expiry job, the receipt job, the emails and the cleanup are wired and tested on real Postgres and a real pg-boss, but nothing runs them on staging or anywhere else yet.
- The providers' behaviour is proven against local fakes that sign with the same field lists as the adapters (they prove consistency, not correctness); the facts only a sandbox can confirm are in owner queue Q32, Q36 and Q37.
- Fiscal uniqueness (one sale document per order, one return per refund) is kept by the order lock in application code; the unique indexes are a migration queued as Q35 (first thing of phase 4).

---
