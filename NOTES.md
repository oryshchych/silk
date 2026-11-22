# NOTES.md

Дотичні проблеми, помічені під час роботи й свідомо НЕ виправлені в тій
самій задачі (AGENTS.md §1: не розширювати обсяг).

## Сесія 2 — схема БД і міграції (2026-10-04)

- **Складений FK `refund_operations (payment_attempt_id, order_id)`** →
  `payment_attempts (id, order_id)`. Згаданий у REVIEW_TRIAGE разом із
  `fiscal_documents`, але в задачу не входив. Потрібен UNIQUE (id, order_id)
  на `payment_attempts`.
- **Чек повернення має посилатися саме на чек `kind = 'sale'`.** Складений FK
  гарантує те саме замовлення, але не тип батьківського документа. FK цього
  не виразить (потрібна колонка-константа або тригер) — рішення за людиною.
- **Частковий UNIQUE для ліміту промокоду на клієнта** (schema.ts, блок SQL,
  п. 8) — сформульовано розмито («залежно від per_customer_limit»), не зроблено.
- **`search_norm` відсутня в Drizzle-схемі** — колонка додана ручною
  міграцією 0003, тому в типах `products` її немає; запити — через `sql```.
- **Шапка `schema.ts`** досі каже «PostgreSQL 16» і перелічує три розширення
  без `pgcrypto`. Файл не чіпали.
- **`.claude/`**: скіли, агенти і хуки створені (хуки — 2026-11-22). Дрібне:
  `post-edit-verify` запускає type-aware eslint на кожну правку (кілька секунд);
  якщо заважатиме — звузити до файлів, що змінились у git. `guard-production`
  не розбирає обгортки (`ssh host '…'`, `bash -c`).
- **`migrate:upgrade` і `migrate:safety` (squawk)** — не зроблені.
- **Ізоляція інтеграційних тестів через `CREATE DATABASE ... TEMPLATE`**
  (DEVELOPMENT.md §5) — globalSetup поки дає одну БД на прогін.

## Відповіді бухгалтера (2026-10-26) — наслідки на потім

- **COD: паперовий чек у коробку.** Чек на товар пробивається при передачі
  посилки на пошту й вкладається в коробку — потрібен друк чека в потоці
  комплектації (фаза 5, адмінка замовлень). Обладнання / формат — рішення людини.
- **Форма оплати в чеку** («Картка», «Післяплата») — у `fiscal_documents`
  окремої колонки немає. Вирішити у фазі 3: колонка + міграція чи поле
  в `items_snapshot` / payload провайдера.
- **Таблиці сертифікатів лишаються в схемі** без коду, який їх пише. knip /
  рецензія можуть пропонувати їх видалити — не видаляти (`GIFT_CARDS.md` §0).

## Крок 2 фази 0 — клієнт БД і seed (2026-10-26)

- **Seed без фото товарів** — `product_images` порожня: медіа живе в R2
  (`packages/media`), якого ще немає. Додати разом із ним, з `alt`, `width`,
  `height`.
- **Seed без адрес клієнтів, auth-користувачів і адмінів** — з'являться
  разом з auth (ADR-19) і адмінкою (фаза 4); адмін-акаунт для staging
  знадобиться до фази 4.
- **`settings.reservation_ttl`** (ADR-3) не заповнюється: TTL у seed
  захардкоджені тими самими значеннями (30 хв / 2 год / 24 год). Перенести
  в `settings` разом із кодом резервування (фаза 0.5).
- **`pnpm audit`**: 2 low + 3 moderate, high — 0.

## Крок 4 фази 0 — apps/web (2026-10-26)

- **`eslint-plugin-jsx-a11y`** не підтримує ESLint 10 (peer `≤ 9`) — відкладено;
  повернути, щойно вийде сумісна версія (фаза 12 має a11y-критерій).
- **Playwright** ще не налаштований: «`/` і `/en` віддають різний текст»
  перевірено `next start` + curl. E2E — разом із першим реальним флоу.
- **hreflang / canonical відносні** — потрібен `metadataBase` з
  `NEXT_PUBLIC_SITE_URL` і x-default (фаза 6, SEO).
- **Сторінка 404 не локалізована** (дефолтна Next).
- **Шрифти й палітра — тимчасові** (системні шрифти, нейтральні токени);
  назва `LACE & SILK` — заглушка до рішення власника.

## Крок 6 — Docker-образ вітрини (2026-10-26)

- **`apps/web/public/` немає** — Dockerfile його не копіює. Коли з'являться
  статичні файли (favicon, robots.txt), додати `COPY .../public`.
- **`worker` тимчасово прибрано з compose** (рішення власника 2026-10-26):
  `apps/worker` ще немає. Повернути в `docker-compose.yml` і обидва
  оверлеї разом із кодом воркера (фаза 0.5); попередній блок — в історії git.
- Образ — 386 МБ (arm64), більшість — `node:24-slim`. Оптимізувати не
  поспішаємо.

## Крок 6 — деплой staging (2026-10-27)

- **Production ще посилається на `env_file: [.env.backup]`** (сервіс
  `backup` у `docker-compose.production.yml`). Dokploy створює лише `.env` —
  перед запуском production перевести backup на явний перелік змінних, як web.
- **Dokploy запускає compose власною командою** (поле Command у Advanced):
  `-f docker-compose.yml -f docker-compose.staging.yml`, бо за замовчуванням
  бере один файл.

## Бекапи (2026-10-27)

- **Зараз — щоденний `pg_dump` у R2** (`infra/dump`, критерій фази 0).
  **Перед запуском production** — безперервне архівування WAL через
  pgBackRest (`infra/backup`, `infra/postgres/pgbackrest.conf`): він ще ніколи
  не запускався, потребує `archive_mode`/`archive_command` у Postgres і
  доступу backup-контейнера до сокета БД (`09-topology.md`, RPO).
- **Ключ R2 може видаляти копії** (R2 не розділяє write і delete). Захист —
  lifecycle-правило й, за бажанням, Bucket lock у Cloudflare.
- `pg_dump` іде суперкористувачем (потрібен доступ до схеми `pgboss`).
  Кандидат на окрему read-only роль разом із роллю для MCP.

## Бекапи на R2 — перша перевірка (2026-11-22)

- Debian-rclone 1.60 давав `501 NotImplemented` на R2 після кожного
  завантаження (зайвий запит); `--s3-no-head` це лікував, але rclone
  оновлено до 1.76.0 з офіційного образу (digest) — без прапорців.
- У bucket діє lifecycle-правило видалення через 30 днів (бачимо в
  заголовку `X-Amz-Expiration`). Токен не має права `GetBucketVersioning`
  — rclone пише про це в лог лише при видаленні, це не помилка.

## Phase 0.5, slice 4: createOrder (2026-11-22)

- **Product-level fields are not serialized against checkout.** ADR-22 has no lock level for
  `products`, so an admin edit of `base_price` / `kind` can be one commit newer than the order
  snapshot. `is_active` is re-checked inside the reserving UPDATE. Decision for phase 4: admin
  price and activation actions should lock the product's variants via `acquireLocks`.
- **Shipping is always 0 in createOrder** (carrier tariffs arrive with Nova Poshta, phase 3+).
- **No runtime validation of contact fields in core** (email, phone, name lengths). The edge
  (server action, zod) must validate; the provider list must be checked against the enabled
  providers in `settings.payment_providers`.
- **Account-bound promos** (`per_customer_limit`, `first_order_only`) are refused for guests until
  accounts exist; `promo_code_redemptions.customer_id` is not set yet.
- **Converted carts are terminal.** After an order the cart token cannot take new items
  (`CART_CONVERTED`); the web layer must mint a new token and cookie on that error.
