## Фаза 7 — Кабінет, відгуки, повернення (1–1.5 тижня)

**Обсяг:**
- Кабінет: замовлення з трекінгом, повторне замовлення, профіль, адреси, розсилка.
- **Мої розміри** → підсвітка «твій розмір» у каталозі, попередження про відсутність.
- Список бажань, підписка «повідомити про наявність» + розсилка воркером.
- Відгуки: тільки від верифікованих покупців, `fit_feedback` → «68% кажуть, що відповідає», модерація.
- **Запити на повернення й обмін** — окрема сутність `return_requests` з позиціями, причинами й статусами. У попередній версії плану це було обіцяно в UI, але не мало таблиці.

**Критерії приймання:**
- [x] Відгук може залишити лише той, хто купив саме цей товар (verified by `reviews.int`: own order, product line, shipped/delivered/paid; mutation without the customer scope fails; not exercised over HTTP)
- [x] Агрегація посадки рахується з реальних `fit_feedback` (verified by `reviews.int`: counters rebuilt from approved rows in the decision transaction under one lock per product; smoke compares `AggregateRating` with the visible count)
- [x] Підписка на наявність відпрацьовує при поповненні складу (verified by `wishlist-alerts.int`, worker `back-in-stock.int` and `customer-topics-delivered.int` through a real relay and pg-boss; the e-mail provider was a fake)
- [x] Запит на повернення створюється, обробляється в адмінці, змінює залишки при прийманні (verified by `returns.int` 27 tests and the smoke-admin return checks; stock changes only at the receipt, the refund pays what was received)

---
