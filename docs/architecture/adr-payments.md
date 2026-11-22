# Платежі, ідемпотентність, повернення

ADR: ADR-4, ADR-11, ADR-5

### ADR-4. Фінансовий статус змінює тільке підтверджене серверне джерело

Первісне формулювання — «статус змінює **тільки** вебхук» — було надто
категоричним і мало три діри: воно не давало шляху відновлення після
втраченого callback, не описувало, як COD і банківський переказ узагалі
стають `paid`, і не покривало результати refund API.

Redirect із браузера справді ніколи нічого не змінює — його можна підробити.
Але автентифікований server-to-server запит статусу — законне джерело, і Mono
надає відповідний API.

Допустимі джерела зміни фінансового стану:
1. Вебхук провайдера з перевіреним підписом
2. `PaymentProvider.getPaymentStatus()` — активна звірка
3. Підтверджене надходження коштів для COD і переказу, з доказом і аудитом
4. Результат операції з `refund_operations`

**`delivered` не означає, що продавець отримав гроші.** Для COD це окрема
подія надходження від перевізника.

**Обов'язково:** воркер `orders:expire-unpaid` виконує звірку через
`getPaymentStatus` **перед** автоматичним скасуванням. Інакше він скасує
замовлення, яке оплачене, а вебхук не доїхав.

#### Ідемпотентність отримання ≠ ідемпотентність застосування

Первісний порядок «вставити подію, при конфлікті вийти» робив ідемпотентним
лише **отримання** повідомлення. Якщо процес упаде між вставкою події й
оновленням замовлення, повторна доставка побачить «дубль» і замовлення
назавжди залишиться неоплаченим, хоча гроші списані. Постановка листа в
чергу після коміту мала власне друге вікно втрати.

So **one transaction** covers: the verified event, the financial state change,
stock changes, history and the `outbox` row. The worker then delivers outbox
rows to pg-boss with retries. A duplicate is dropped only after the
**confirmed application** of the message (`payment_events.applied_at IS NOT
NULL`).

**Actual delivery guarantee (implemented in `apps/worker`).** The relay is
at-least-once, not "one transaction with the queue": the app role cannot write
to the `pgboss` schema, so the send runs on its own connection (OWNER_QUEUE
Q14). A re-send after a crash collapses into the existing job through the
pg-boss singleton key; once that job has finished, the consumer's side effect is
kept to one by the provider idempotency key (the outbox dedup key). Jobs that
exhaust their retries go to a dead-letter queue, and rows the relay gives up on
are reported as `stuck`.

#### Неперевірені повідомлення — в карантин, не в `payment_events`

`UNIQUE(provider, message_key)` не враховує валідність підпису. Запит зі
сміттєвим підписом і правильним `invoiceId` першим займе ключ — і справжній
платіжний вебхук потім відкинеться як дубль. Це можливо і без атаки: через
помилку перевірки підпису при першій доставці.

Тому в `payment_events` пишуться **тільки** повідомлення, що пройшли
перевірку підпису. Решта — в `webhook_quarantine` з обмеженим строком
зберігання.

#### Порядок повідомлень не гарантований

Один інвойс дає кілька повідомлень про зміну стану, і Mono прямо попереджає
про можливе порушення порядку, надаючи `modifiedDate`.

- Ідентичність **спроби оплати** і ідентичність **повідомлення** — різні
  сутності. `payment_events.message_key` дедуплікує повідомлення,
  `payment_attempts.local_reference` ідентифікує спробу.
- Для провайдера без окремого event id ключ дедуплікації будується з
  значущих **автентифікованих** полів.
- `state_version` зберігається там, де провайдер це дає. Застаріле
  повідомлення записується, але **не скасовує вже підтверджений фінансовий
  факт**.
- Перед зарахуванням перевіряється прив'язка повідомлення до спроби, merchant,
  сума і валюта.

#### Порядок операцій в обробнику

```
1. прочитати raw body ДО парсингу
2. перевірити підпис → невалідний: webhook_quarantine + 4xx
3. знайти payment_attempt за reference
4. SELECT ... FOR UPDATE на orders (потім product_variants за зростанням id)
5. insert payment_events (provider, message_key) → конфлікт і applied_at
   не NULL: вийти, але ВІДПОВІСТИ ПРАВИЛЬНО (див. нижче)
6. перевірити допустимість переходу і state_version
7. мутації + order_status_history + outbox — усе в цій транзакції
8. commit
9. відповісти у форматі провайдера
```

На гілці дубля **обов'язково** викликається `buildWebhookResponse`: для
WayForPay звичайний `200` не замінює підписаної відповіді, і без неї вони
ретраять годинами.

Локи беруться завжди в одному порядку, щоб не отримати deadlock між вебхуком,
адмінкою і воркером.

Вебхук може прийти **раніше** за redirect і раніше, ніж застосунок збереже
повернений `externalId`. Це норма, і має бути протестовано.

### ADR-11. Серверний checkout intent, не клієнтський ключ

Дві попередні версії цього ADR були неправильні. Перша змішувала створення
замовлення й спробу оплати. Друга поклала ключ на клієнта з правилом
«перегенерувати після терминальної відповіді» — і це так само ламається:
замовлення створилося, відповідь загубилася, покупець перезавантажив сторінку,
клієнтський UUID зник, новий ключ дав друге замовлення. Дві вкладки — те саме.

**Правильна модель: intent живе на сервері.**

`checkout_intents` прив'язаний до `(cart_id, cart_version)` і повертається
однаковим у всіх вкладках до завершення або явного перезапуску оформлення.
`cart_version` інкрементується тригером на будь-яку зміну `cart_items`, тому
зміна складу кошика автоматично означає новий intent.

- `owner_token` — власник (для гостя це токен кошика). Чужий intent
  використати не можна.
- `payload_fingerprint` — хеш суттєвих параметрів. Той самий intent з іншим
  payload → `409`, а не тихе повернення старого замовлення зі старою адресою.
- **Перевірка завершеного intent виконується ДО повторної резервації.**
  Інакше повтор успішної покупки останньої одиниці повернув би «немає
  залишку» замість наявного замовлення. Це неочевидно і легко зробити не в
  тому порядку.

**Спроба оплати — окрема сутність** (`payment_attempts`). Замовлення вже
існує; «не вистачило коштів, зміню карту» не викликає `createOrder` взагалі.

Спроба створюється **до** зовнішнього виклику, з власним незмінним
`local_reference`, який передається провайдеру. Якщо відповідь загубилася,
статус спроби — `unknown`, і наступний крок — **звірка через
`getPaymentStatus`, а не нова спроба**. Інакше провайдер створить другий
інвойс, покупець відкриє обидва посилання, і обидві оплати можуть пройти.

Перемикання провайдера не має залишати попередню спробу платоспроможною:
перед створенням нової попередня закривається або скасовується у провайдера.

**Converted carts (contract).** Once an intent completes, its cart is
terminal: `carts.converted_at` is set and `setCartItem` throws `CART_CONVERTED`.
`startCheckout` on that cart returns the completed intent with its `orderId`, so
a reload shows the order. The cart token is the guest credential and is never
reused for a second purchase: on `CART_CONVERTED` (or after showing the order)
the web layer mints a NEW token, sets a new cookie, and the next cart is a new
row. Tokens are minted by the server (16..64 URL-safe characters), never chosen
by the client.

### ADR-5. Снапшоти в замовленнях

`order_items` зберігає `name_snapshot`, `sku_snapshot`, `size_label`, `color_name`, `unit_price`. Замовлення дворічної давнини мусить показувати ціну й назву на момент покупки, навіть якщо товар видалено. `product_id` та `variant_id` — nullable FK з `ON DELETE SET NULL`.
