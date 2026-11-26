## 4. Схема даних — огляд

Повне визначення в `schema.ts`. Тут — карта зв'язків і призначення.

```
categories ──┐
             ├─< products ──< product_images
             │       │
             │       ├──< product_variants >── sizes
             │       │            │        >── colors
             │       │            │
             │       │            ├──< stock_reservations >── orders
             │       │            └──< stock_notifications
             │       │
             │       ├──< product_attribute_values >── attribute_values >── attributes
             │       ├──< reviews
             │       ├──< related_products
             │       └──< wishlist_items
             │
customers ──┬──< addresses
            ├──< orders ──< order_items
            │       ├──< order_status_history
            │       ├──< payment_events
            │       └──< return_requests ──< return_request_items >── order_items
            ├──< carts ──< cart_items
            ├──< reviews
            └──< wishlist_items

promo_codes ──< promo_code_redemptions >── orders
gift_cards ──< gift_card_transactions >── orders, payment_attempts
orders ──< payment_attempts ──< payment_events
      ├──< refund_operations
      ├──< shipment_operations
      └──< fiscal_documents ──┐ (parent_document_id: чек повернення → чек продажу)
carts ──< checkout_intents >── orders
auth_users ──┬──< auth_credentials · auth_totp · auth_recovery_codes
             ├──< auth_sessions        (audience: admin | customer; a customer session never counts in the admin)
             └──< auth_email_tokens    (verify_email | reset_password; single use, no credential stored:
                                        the token is <id>.<HMAC(id)> under a key derived from AUTH_SECRET)
customers.user_id ── auth_users (account); customers_email_lower CHECK; orders_email_lower_idx claims guest orders
outbox · webhook_quarantine · legal_documents
products ──< product_views          (джерело для воронки і звіту
                                     «переглядали, але не купували»)

Довідники й службове:
np_settlements ──< np_warehouses
settings · redirects · pages · blog_posts · banners
admin_users · audit_log · newsletter_subscribers · jobs (pg-boss)
```

### Інваріанти, які тримає БД, а не код

- `UNIQUE (product_id, size_id, color_id)` на `product_variants` — неможливо створити дубль варіанта
- `CHECK (stock_quantity >= 0)`, `CHECK (reserved_quantity >= 0)`
- `UNIQUE (idempotency_key)` на `orders` — подвійна відправка checkout не створює друге замовлення (ADR-11)
- `UNIQUE (provider, external_id)` на `payment_events` — ідемпотентність вебхуків
- `UNIQUE (promo_code_id, order_id)` та `UNIQUE (promo_code_id, customer_id)` (частковий, коли є ліміт на клієнта) — промокод не застосується двічі
- `UNIQUE (product_id, customer_id)` на `reviews` — один відгук на товар від клієнта
- `CHECK (rating BETWEEN 1 AND 5)`
- `slug` unique на `products`, `categories`, `pages`, `blog_posts`
- FK з осмисленими `ON DELETE`: `RESTRICT` там, де видалення має бути заблоковане; `SET NULL` для снапшотів; `CASCADE` тільки для справді залежних сутностей (`product_images`, `cart_items`)

Правило: **якщо інваріант можна виразити в схемі — він виражається в схемі.**
Перевірка в застосунку не захищає від паралельних запитів, воркера й ручного SQL.

**Зворотний бік цього правила**, який варто тримати в голові: обмеження, що
блокує легітимну операційну дію, гірше за його відсутність. Три місця, де це
враховано свідомо:

- `CHECK (reserved_quantity <= stock_quantity)` **відсутній навмисно.** Виглядає
  правильно, але створює тупик: під час інвентаризації адмін може виявити, що
  реального товару менше, ніж зарезервовано — і не зможе виправити цифру, поки
  не скасує чужі замовлення. Замість обмеження — воркер `stock:reconcile`
  алертить, рішення приймає людина.
- `CHECK` на арифметику `orders.total` включає `adjustment_total`, інакше будь-яка
  ручна доплата або компенсація з адмінки була б неможлива.
- `CHECK` на `order_items.line_total` враховує `line_discount` і допускає нуль —
  для акцій «3 за ціною 2» і подарунків до замовлення.

### Індекси, які мають бути з першого дня

```
products (category_id, is_active, published_at DESC)
products USING gin (search_vector)
products USING gin (name_uk gin_trgm_ops)
product_variants (product_id) · (size_id) · (color_id)
product_variants (product_id) WHERE stock_quantity - reserved_quantity > 0
orders (created_at DESC) · (status) · (customer_id) · (order_number)
orders (payment_status) WHERE payment_status = 'pending'
order_items (order_id) · (product_id) · (variant_id)
stock_reservations (expires_at) WHERE released_at IS NULL
payment_events (order_id, created_at DESC)
np_warehouses (settlement_ref)
np_settlements USING gin (name_uk gin_trgm_ops)
audit_log (entity, entity_id, created_at DESC)
```

---

## 5. Розміри — модель

Найбільш недооцінена частина домену.

```
sizes:
  system    'bra' | 'panty' | 'apparel' | 'onesize'
  label     '75B', 'M', 'XL'      -- те, що бачить покупець (UA)
  band      75                    -- лише для 'bra', для фільтра по обхвату
  cup       'B'                   -- лише для 'bra', для фільтра по чашці
  eu_label  '75B'
  us_label  '34B'
  sort_order
```

`band` і `cup` окремими колонками — тому що фільтр «обхват 75» і фільтр «чашка B» мусять працювати незалежно. Якщо тримати тільки `label`, доведеться парсити рядок у запиті.

**Калькулятор розміру** живе в `packages/core/catalog/bra-size.ts` як чиста функція: `(underbust: number, bust: number) => { band, cup, label }`. Покрита unit-тестами на межових значеннях. Це прямо впливає на відсоток повернень, тому це домен, а не UI-хелпер.

**Агрегація посадки:** `reviews.fit_feedback` ('small' | 'true' | 'large') → на PDP «68% кажуть, що відповідає». Рахувати з реальних відгуків, не вигадувати.

---

## `stock_adjustments` (phase 4)

History of MANUAL stock changes made through `adjustStock` (`packages/core/src/stock`): receipt,
write-off, stocktake, correction, import. One row per change in the same transaction as the atomic
`UPDATE` of `product_variants.stock_quantity`: variant, author, reason, delta, quantity before and
after (`after = before + delta` is a CHECK), plus an optional unique `request_id` (a retried request changes nothing). The table is append-only: the app role has no UPDATE, DELETE or TRUNCATE, and a trigger stops every role. A change that would leave less than the reserved quantity is refused (Q44). Orders do not write here (ADR-18: reservations and
shipping have their own records). The variant cannot be deleted while it has history (RESTRICT):
products are deactivated, not deleted.

> Phase 5 (migration 0014): `fiscal_documents` has `CHECK fiscal_docs_return_has_refund`: a return receipt always names the refund operation it returns (the unique index alone allowed NULL). `payment_attempts_open_idx` is gone; `payment_attempts_reconcile_idx` serves the reconcile job.
