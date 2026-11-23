## Фаза 2 — Кошик, checkout, доставка (1 тиждень)

**Мета:** замовлення створюється коректно. Без оплати.

**Обсяг:**
- Гостьовий кошик через `cart_token` у httpOnly cookie, мердж при логіні.
- Розрахунок кошика тільки на сервері.
- Резервації залишків (ADR-3): `stock_reservations` + денормалізований `reserved_quantity`.
- **Ідемпотентність — серверний `checkout_intents` (ADR-11), НЕ клієнтський ключ.**
  Intent прив'язаний до `(cart_id, cart_version)` і повертається однаковим у
  всіх вкладках. Клієнтський UUID тут не працює: перезавантаження сторінки
  його втрачає і дає друге замовлення.
  Перевірка завершеного intent виконується **до** повторної резервації —
  інакше повтор успішної покупки останньої одиниці повернув би «немає
  залишку» замість наявного замовлення.
  Тригер на `cart_items` інкрементує `carts.version` (зміна дочірньої
  таблиці не оновлює батьківський рядок сама).
- Checkout однією сторінкою, три блоки, sticky summary.
- Нова Пошта: кеш міст і відділень у БД, оновлення воркером. Автокомпліт по власній БД, не по API.
- Розрахунок доставки, поріг безкоштовної, Укрпошта, самовивіз.
- Промокоди з валідацією обмежень на сервері.
- `orders` + `order_items` зі снапшотами.
- Email через Resend: підтвердження покупцю, нотифікація адміну.
- `/order/success`, `/order/failed`, `/order/track`.

**Acceptance criteria** (verified by execution on 2026-11-23, tree = `main` + #55; details in `docs/plan/CURRENT.md`):
- [x] Changing the price in devtools does not change the order total: the browser sends ids, quantities and contact data only. `pnpm smoke:web` ("a tampered price changes nothing", an order placed with `total`, `unitPrice`, `quotedTotal`, `allowUnquoted` in the body), `checkout-schemas.unit.test.ts` (unknown keys are dropped), `checkout.int.test.ts` ("a client-supplied total is ignored", "refuses with PriceChangedError when a price moves after the total was shown").
- [x] Two simultaneous requests for the last unit: one order, one clear error that lists the positions: `create-order.int.test.ts` ("criterion 1", separate connections, a barrier, and a proof that the second buyer was blocked), `pnpm smoke:web` ("ordering more than is in stock names the positions"). The list carries names and sizes, never stock numbers (a security finding: stock below the cap would leak).
- [x] A double click on "Place order" creates one order: `create-order.int.test.ts` ("five parallel submissions create exactly one order"), `pnpm smoke:web` (two simultaneous submits of one cart: both end on the order page, one access cookie).
- [x] A repeated request with the same intent returns the same order, not a duplicate: `create-order.int.test.ts` ("criterion 3: reload after the order was created", "startCheckout called in parallel returns one intent"), `pnpm smoke:web` (a replayed submit without the order cookie goes to tracking with a notice).
- [x] Two tabs of one checkout form give one order: the same intent is served to every tab and one submit wins ("criterion 2", "criterion 4" above, and the smoke double submit).
- [x] A change of the cart contents increments `cart_version` by trigger and the old intent is refused with 409: `migrate-fresh.int.test.ts` ("0006", a cart change makes an intent bound to the old version stale), `create-order.int.test.ts` ("criterion 4: the first tab gets a 409 and a new intent is issued"), `checkout.int.test.ts` (a quote for a stale intent is refused).
- [x] A 100 UAH discount over three 200 UAH lines: `SUM(line_discount)` is exactly 10000 kopiykas and `subtotal = SUM(line_total + line_discount)` (ADR-15): `checkout.int.test.ts` ("a 100 UAH discount over three 200 UAH lines is exactly 10000 kopiykas and subtotal adds up"), `pricing.unit.test.ts`.
- [x] Reservation lifetime differs for card, transfer and COD (ADR-3): `checkout.int.test.ts` ("reservation lifetime follows the method: card 30 min, transfer 24 h, COD 2 h", read from Postgres).
- [x] A series of 20 COD orders from one phone is blocked: `checkout.int.test.ts` (3 created, 17 refused, other phones unaffected; a parallel test with the phone advisory lock held by an open transaction), `pnpm smoke:web` (20 attempts from 20 different clients create 3, a single client and phone hits the rate limit).
- [x] An expired reservation is released by the worker and `reserved_quantity` equals the sum of the live reservations: `checkout.int.test.ts` (expiry runner, drift check, paid and in-flight orders left alone), `apps/worker/test/jobs.int.test.ts` (the job run by a real pg-boss). **Caveat:** the worker process is not deployed (owner item Q31), so on staging nothing runs the job yet.
- [x] A promo code with `max_uses = 1` is not applied twice in parallel: `create-order.int.test.ts` ("two checkouts racing for the last allowed use: one wins", "last promo use: the second checkout waits on the promo row and is rejected").
- [x] The city autocomplete works while the Nova Poshta API is down: it reads our own tables only. `apps/worker/test/np-sync.int.test.ts` ("autocomplete works while the carrier API is down"), `pnpm smoke:web` (the built app, no carrier access, answers `/api/np/cities`). The sync client is tested against recorded-shape fixtures only (owner item Q2: no key).
- [x] The guest cart is merged at login, not overwritten: `checkout.int.test.ts` (quantities add up, capped at 99, converted carts refused, two merges racing from separate connections, an item added by an open transaction is not lost). **Caveat:** login does not exist yet (phase 7), so this is proven at core level; nothing calls `mergeGuestCart`.
- [x] End-to-end happy path in CI: the `smoke-web` job runs the shopper's path on the BUILT app and a seeded database (add to cart, cart page, quote, place an order, order page, tracking, the guards above). **Deviation:** it is HTTP level (server actions are POSTed with the ids from the build's manifest), not a browser; Playwright is still not installed (Q6).


---
