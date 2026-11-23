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

## Phase 0.5, slice 5: payments package (2026-11-22)

- **Mono adapter is tested only against a local fake** (real HTTP, real EC key, webhooks signed
  like the real service). It has not been run against the sandbox: that needs the owner's token.
  Facts to confirm there: the shape of a partial `reversed` webhook (the adapter maps `reversed`
  to `refunded` and leaves refund state to `refund_operations`), whether `modifiedDate` is always
  present, and whether `/invoice/cancel` returns an id of its own.
- **Webhook body must be read as bytes** (`arrayBuffer()`, not `text()`) in the route handler.
- **Core must reject** a webhook whose `currency` is not UAH, whose amount differs from the
  attempt, or whose `localReference` matches no attempt (`webhook_quarantine`).
- **Provider routing for refunds** (by the attempt's provider, GIFT_CARDS.md section 0) is enforced
  in core, with a test, in the refund slice.

## Phase 0.5, slice 6: webhook handling (2026-11-22)

- **Provider-side cancel of a superseded invoice is not implemented.** Until it exists, a new
  attempt is refused while the previous invoice is live (`PAYMENT_ATTEMPT_STILL_OPEN`); it can be
  replaced once it expired (the buyer who abandoned the page waits for the 30 min validity).
- **Adjusted captures are not applied from a webhook** (a second `success` with a different
  `finalAmount` is recorded as "no change"); reconcile with `getPaymentStatus` in the worker.
- **A stale rule for providers without `modifiedDate`:** the contract requires a state version;
  WayForPay must supply one or core needs another ordering signal.
- **No merchant check** (ADR-4): Mono has no merchant field; WayForPay needs one.
- **Quarantine abuse:** unverified bodies are stored as hash plus a 2 KB prefix, but the route
  still needs per-IP rate limiting (edge, slice 8) and `quarantine:cleanup` retention (worker).
- **Alerts** (`alert.payment-mismatch`, `alert.late-payment`, `alert.double-payment`) are outbox
  topics; the relay and the Telegram consumer arrive with the worker.
- **`recordAttemptResult` maps every failure to read the provider answer to `unknown`**, which blocks a
  new attempt (`PAYMENT_ATTEMPT_UNRESOLVED`) until reconciliation. A "definitely not created"
  outcome (a 4xx refusal) is not distinguished yet; `payments:reconcile-open` must close such attempts.
- **Double click:** an attempt with no invoice younger than 60 s cannot be superseded
  (`PAYMENT_ATTEMPT_STILL_OPEN`); the web layer should return the existing attempt's redirect.

## Retro review of PRs #1-#14 (2026-11-22): open nits

Fixed in PRs: dump failure detection, nested `.env` in `.dockerignore`, seed target guard,
`parseFloat`/`toFixed` lint ban, `-0`. Owner decisions are in `docs/plan/OWNER_QUEUE.md` (RR1-RR6).
Left as notes:

- **`money/no-arithmetic` has no RuleTester test and returns `{}` silently when type information
  is missing** (`eslint-rules/money.js:33`). It should throw, and have cases for `m / 3`, `m += x`,
  `m++`, `-m`, one-sided `Money`, and passing cases for comparisons.
- **`packages/db/seed/orders.ts` does raw `number` arithmetic on totals** (`subtotalOf`, order
  body, `reduce`) next to the money-typed `applyPromo`. Type them as `Money`.
- **`allocate` / `percentOf` have only point-example tests.** Add a property test (sum exact,
  share <= weight, zero weights get zero) and document that ties break by input index, so callers
  pass weights sorted by `id` (ADR-15).
- **`moneyDto` accepts negatives and values above the Postgres integer max**; add a non-negative
  variant for price and total fields. The DTO lint selector misses aliased `looseObject` imports.
- **`proxy.ts` `isPage` regex** skips locale routing for paths with a dot (a slug like
  `bra-1.5` would 404). Fix before the PDP.
- **`01-roles.sh` and `docker-compose.yml`** interpolate passwords into SQL and into the
  `DATABASE_URL` without escaping: keep passwords to `[A-Za-z0-9]` or encode them.
- **Base images are not pinned by digest** (`node:24-slim`, `postgres:18`, `alpine`,
  `mailpit:latest`); the local compose publishes Postgres on all interfaces (bind `127.0.0.1`).
- **`APP_ENV=local` is accepted by the deployed compose** and turns the staging gate off; refuse it
  when `NODE_ENV=production` outside loopback. `AUTH_SECRET` has no minimum length.
- **Migrations**: `: any` in `schema.ts` self-references needs a reason comment; the ownership
  test checks only `pg_class` (add functions and text-search objects); composite FKs from 0004
  have no index on the referencing side.
- **A Next.js tool rewrites `apps/web/AGENTS.md`** (heading level) during `pnpm verify`; the
  generated mirror then differs from `ai/` in the working tree.
- Missing `not-found` page, no `Sitemap:` line, no security headers: phase 1 / 6 (see RR6).

## Phase 0.5, slice 7: outbox relay (2026-11-22)

- **Worker deployment is not wired**: no `apps/worker` Dockerfile, no compose service, no `main.ts`
  (no loop that calls `relayOutbox` on a timer), no env variable for the `store_boss` URL. This
  slice delivers the relay, queue setup (`startBoss`, `createSchema: false` because `store_boss`
  cannot CREATE in the database), `registerWorkers` and tests. The deploy wiring belongs with the
  first worker task that has to run on staging.
- **No real email sender yet**: `deliverJob` takes a `MessageSender`; the Resend adapter arrives
  with `packages/email`. The "once" guarantee rests on the provider idempotency key, which a
  provider keeps for a limited time (about 24 h for Resend). A retry after a longer outage can
  send twice; a consumer-side "sent" record keyed by the dedup key would close that gap.
- **Stuck rows are reported, not yet alerted**: `relayOutbox` returns `stuck` (rows at the attempt
  limit). The loop that calls it must raise an alert (Telegram) when `stuck > 0`; money alerts are
  themselves outbox topics, so this alert must not go through the same outbox.
- **Job payloads live in `pgboss.job`** until pg-boss retention ends (14 days by default): keep personal
  data out of outbox payloads (today only an order id) and let the consumer load it when it sends.
- **Retry tuning**: mail and alert queues retry 20 times with backoff capped at 1 h (about half a
  day of provider outage); the dead-letter queue keeps jobs 30 days. Tracked as Q15 (watcher).
- **Dead-letter queue** `outbox.dead` collects jobs whose consumer retries ran out; it needs the
  same kind of watcher.
- **`exclusive` queues** collapse a re-send only while the first job is queued or active; they are
  a duplicate guard, not a delivery guarantee. Delivery relies on retries, the dead-letter queue and
  the idempotency key.
- **A hung send** triggers a second probe: if the backend still answers, the hang is the row's problem
  (burns an attempt, the batch carries on); after two hung sends in one batch it ends. A backend that
  answers the probe but hangs every send is therefore bounded to two timeouts per tick.
- **Batch hold time**: the batch locks are held while sending (default 20 rows, 10 s per send
  timeout, a streak of 3 failures with nothing sent ends the batch).

## Phase 0.5, slice 8a: ship and cancel (2026-11-23)

- **`shipOrder` skips `confirmed` and `processing`**: it moves `pending`/`confirmed`/`processing` straight
  to `shipped` and records the jump in the history. The one-step admin transitions of
  `05-payment-flow.md` section 7 arrive with phase 5; this is a deviation to list in the phase report.
- **Only settled card payments ship** (paid and captured >= total). COD and bank transfer are Q16.
- **Cancelling does not touch the provider**: open invoices are closed locally and a card hold is
  announced through `alert.refund-due` (`heldAuthorization`); releasing the hold or the invoice at the
  provider is a follow-up. A late payment on a closed invoice is credited and raises `alert.late-payment`.
- **`alert.refund-due` has no consumer yet** (the refund flow is the next slice; a manager screen is phase 5).
- **The explicit `product_variants` lock in `shipOrder` and `cancelOrder`** (ADR-22) is defence in depth
  in the same way: the order lock serialises the two operations, and a checkout queued behind either one
  is already blocked by the row lock of their own UPDATE, so no test can tell the explicit lock from its
  absence. The locks stay (they carry the protocol and the lock-order tracker); a ship-vs-checkout test
  and a cancel-vs-checkout test prove the observable behaviour.
- **`shipOrder` writes no outbox event** (no `order.shipped` mail): none is planned for this slice; the
  customer notification arrives with the email package.
- **Conditional reservation close** (`released_at IS NULL`) is defence in depth: under the order lock a
  repeat call returns before reaching it, so no test can tell it from an unconditional update.
- **Cancel or ship vs the payment webhook** is not exercised in one test: all three take `orders` first
  (reviewed), and `payment_attempts` second via `acquireLocks`.

## Phase 0.5, slice 8b: refunds (2026-11-23)

- **An in-flight refund whose provider call never happened cannot be told from one that was sent.** The
  claim commits before the call, so a crash in between leaves `in_flight` with the budget held. Nothing is
  retried blindly. Whether Mono treats `/invoice/cancel` with the same `extRef` as idempotent (which
  would make a retry safe) is one more fact for the sandbox run (Q13). Until then a person or the future
  `payments:reconcile-open` job closes it through `settleRefund` with a confirmation.
- **No refund reconciliation job yet**: the adapter has no refund status lookup. `unknown` and
  `in_flight` operations hold budget until someone settles them with a confirmation (audit row with the
  person), and `pending` ones can be withdrawn with `cancelPendingRefund`.
- **Webhook `reversed` never settles a refund** (ALLOWED has no refund target): refund state comes from
  `refund_operations` only. A late capture on an order already `refunded` raises `alert.double-payment`
  but leaves the status `refunded`; re-deriving it is a phase 5 admin concern.
- **`requestFullRefund` is all-or-nothing**: one attempt without a route (COD, gift card, an unregistered
  provider) refuses the whole request; refund such attempts separately with `requestRefund`.
- **Refund state changes are provenance-checked**: the result of our own provider call (`processRefund`) is the
  only way to settle an `in_flight` operation without a confirmation; `settleRefund` always takes a
  `confirmation` (audited), `pending` operations cannot be settled at all, and `unknown` never reopens.
- **A refund reservation is serialised by both locks and by Postgres foreign-key locks**: removing the
  explicit order lock from `requestRefund` is caught only by the full-vs-partial race test, because the
  insert's FK lock on `orders` already blocks a concurrent ship. The explicit lock stays (it carries the
  ADR-22 protocol).
- **Refund reconciliation has no owner yet**: queued as Q17.
- **Refund reason is limited to 200 characters**; use codes, not customer text.
- **Returns**: stock goes back only through the physical receipt of a return (a later phase); a refund
  does not touch `stock_quantity`.

## Phase 1: SEO skeleton follow-ups (2026-11-23)

- **Thin metadata:** no `openGraph` / `twitter` fields and no `Organization` / `WebSite` JSON-LD yet. OG and Twitter come with the PLP/PDP slice (product image, title, description); Organization and WebSite markup is phase 6.
- **404 pages:** two cases, both checked on built servers and in `next dev`. (1) Unmatched paths (`/en/a/b`): `experimental.globalNotFound` + `app/global-not-found.tsx` give a server-rendered 404 with `<html lang="uk">`, both languages, `noindex`. (2) `notFound()` thrown from a matched page (unknown category, page past the end, later an unknown product): status 404 and `noindex` are right, but Next answers with its own `<html id="__next_error__">` shell, with no `lang` and an empty body; the translated UI from `[locale]/not-found.tsx` is rendered by the client after hydration. This is framework-wide: the independent SEO review reproduced it on a vanilla app (static root layout, plain page) on Next 15.5.29, 16.2.12 and 16.4.6, and here it is the same with `globalNotFound` on and off, a segment or root `not-found.tsx`, and static or dynamic routes (`next/dist/server/app-render` takes its error-recovery path for any `notFound()` that reaches the top of a render). A visitor without JavaScript sees a blank 404 page; crawlers see the status and `noindex`. The only pattern found that renders it server-side is a `proxy.ts` rewrite to an unmatched two-segment path; it needs a database lookup per category request and cannot cover a page past the end, so it is not implemented (owner item Q22).
- **Redirect loop report on `/` (independent review of PR 34):** not reproduced on this branch with `node .next/standalone/apps/web/server.js`, `next start` and `next dev` (APP_ENV local and staging, with basic auth, Googlebot UA, `Accept-Language` variants, a foreign `Host`). Real-server checks run in CI need Playwright (Q6); until then they are manual.
- **No `loading.tsx` at the locale level:** it starts the response stream before a page can call `notFound()`, so every 404 would be a streamed 200 (soft 404; checked on a real server). Skeletons go on slow regions with `<Suspense>` AFTER the page has resolved its slug and called `notFound()`; the product and category pages must do their existence check first.
- **Staging site URL:** staging requires the runtime `SITE_URL`; compose fills it from the project's `NEXT_PUBLIC_SITE_URL` at container start, so the value is per environment and not baked into the image.
- **Smoke test against the built app:** `pnpm smoke:web` (after `pnpm --filter web build`, with the seeded dev database) asserts locale routing, the `/uk` redirect, 404 statuses, canonical/hreflang/JSON-LD in the primary HTML, filters and the language switch, bounded hostile input, that no cost/stock/admin field reaches the HTML, and that `SITE_URL` is read at runtime. It is not in CI yet: a CI step edits a workflow, which is the owner's (Q20).

## Phase 1: storefront data layer and category page (2026-11-23)

- **ISR needs `generateStaticParams`:** on a dynamic route `export const revalidate` alone is not enough, Next renders per request (`Cache-Control: no-store`). Exporting `generateStaticParams` that returns `[]` prerenders nothing at build (the runtime `SITE_URL` is still read on the first request) and makes the route ISR-capable (`x-nextjs-cache: MISS` then `HIT`, `s-maxage=3600`). The product page is the ISR page. The home page is NOT ISR on purpose: it shows navigation and categories that may be missing when the database is down on a cold start, and an ISR page would keep that for an hour (see the next note).
- **ISR cache lives inside the container** (`.next/server/app`), so staging and production, which run separate containers from one image, never share rendered pages; a deploy starts empty. `smoke:web` therefore runs from a throwaway copy of the build. Recreate the container (not just restart it) when `SITE_URL` changes, because rendered pages survive a restart but not a recreate.
- **Category pages are not ISR:** the filters are `searchParams`, which make the page dynamic. Their data is cached with `unstable_cache` (tags `category:{id}` for every category in scope, TTL 5 minutes), as ADR-8 prescribes.
- **Category `seo_text` is not rendered yet:** it is rich text "sanitised on save", and there is no sanitiser or admin editor yet. Render it with the admin slice (phase 4).
- **No invalidation endpoint yet:** the tags and `revalidate` TTLs are in place; the internal `revalidateTag(tag, 'max')` endpoint reached from the outbox comes with the first admin mutation (phase 4/5). Until then caches refresh by TTL.
- **dependency-cruiser** does not resolve the `@/` alias of apps/web, so leaf modules under `apps/web/src/components` and `lib` are exempt from the orphan rule.
- **Navigation failure policy:** `loadCategoryTree` serves the last good tree when the database fails; with none yet it rethrows, so a cached (ISR) page is never regenerated without navigation (Next keeps the previous entry or answers 500). Only the home page, which is rendered per request and never cached, passes `degrade` and renders without navigation, because CI's `web-image` job starts the image with an unreachable database and expects `/` to be 200 with `lang="uk"`. The log line has the error name and code only. If CI ever runs that check with a database, `degrade` can go. Mitigations for the cold-start case are in owner item Q21 (alert on the `navigation` stderr line, a readiness probe, warm the pages after a deploy).

## Phase 1: product page (2026-11-23)

- **Descriptions are shown as text:** `description`, `composition` and `care` are rich text "sanitised on save", but there is no sanitiser or editor yet, so the page converts them to plain paragraphs (`lib/html-text.ts`) and never injects markup. Show the markup with the admin slice (phase 4).
- **No add-to-cart yet:** selection, availability and price follow the chosen colour and size; the cart and its button are phase 2.
- **The size guide is generated from `CUP_TABLE`** of `@store/core/bra-size`, the same table the calculator uses, so the page and the calculator cannot disagree (owner item Q19 covers the table itself).
- **Manual check of the interactive part** (built image, real browser): available size selectable, unavailable size ignored, colour change clears a size missing in the new colour, calculator results match the table, "select" button picks the variant. There is no browser test in CI (Playwright, Q6).
- **A local standalone run writes ISR pages into the build folder** (`.next/standalone/.../server/app`), with whatever `SITE_URL` that run had. Rebuild before `pnpm smoke:web` if you ran the server from there by hand.
- **Do not format money in a client component:** `Intl.NumberFormat` currency output differs between Node and browsers (spaces, symbol), and Lighthouse showed React error #418 (hydration mismatch) on the product page. Prices are formatted on the server and passed as text; the client only picks among the strings.
- **Lighthouse (mobile, built image as `APP_ENV=production`, seeded database, no photos):** category page and product page both Performance 100, SEO 100, CLS 0; LCP will move once real images exist.
- **Unknown product slugs must not reach the ISR route (corrected after review):** Next stores every distinct slug that reaches an ISR page, a 404 included, in `.next/server/route-cache` (about 7 files and 47 KB per slug; my first measurement only counted `server/app`, which does not change, and wrongly concluded there was no growth). Fix: `proxy.ts` answers `/product/{slug}` and `/en/product/{slug}` BEFORE the route: a slug that cannot exist (lowercase words joined by hyphens, at most 200 characters; `x%00abc` is a Postgres error) is a 404 without touching the database, a well-formed one is checked against an in-memory set of visible slugs (`lib/slug-set.ts`, refreshed every 60 s, stale-on-error, fails open when it cannot load at all). The 404 is a rewrite to an unmatched path, so it is the server-rendered global 404 page (`lang`, text, `noindex`, `Cache-Control: no-store`), shared by all misses. Measured on the build with 300 random, mixed-case, encoded, NUL-byte and 300-character slugs plus 1000 concurrent unique ones: page-cache files 179 to 185 and then flat, data cache 7 to 7. `pnpm smoke:web` asserts that unknown and malformed slugs add no files to `.next/server` or `.next/cache`. Count `route-cache`, `fetch-cache` AND `server/app` in every future cache measurement. A product published within a minute of its first request may answer 404 until the set refreshes (the 404 itself is not cached). Residual: the page cache can only grow by real products; quota or cleanup of the cache folder and an edge rate limit are in Q21.
- **Client messages are an allowlist:** the locale layout sends only `errors` and `product` to the browser; a new client component using `useTranslations` needs its namespace added there, or it renders keys.

## Phase 1: product page review round (2026-11-23)

- **A product without a photo has no `Product` markup** (a Product without `image` is not eligible for rich results and Search Console flags it); the page still renders, `BreadcrumbList` stays. The seed now gives every product a site-relative placeholder photo (`/placeholder.svg`, `apps/web/public`, also copied into the image), made absolute at render time, so the markup and the rich result check can be exercised. Real photos arrive with `packages/media`.
- **No `aggregateRating` markup:** ratings are not visible on the page yet, and markup must match what the visitor sees. The builder still supports it; add it together with the reviews UI.
- **Structured-data images** are absolute, the opening colour's photos first. Offers are deduplicated by (price, availability) instead of one per size and colour.
- **A product with no active variants is not indexed** (thin page). An all-sold-out product shows "out of stock" in the page and `OutOfStock` in the markup.
- **Media URLs are allowlisted** (`https://` or a site-relative path) in core before they reach pages, Open Graph or JSON-LD (`safeMediaUrl`); images are rendered unoptimised for now (no `remotePatterns` to enforce anything), so this allowlist is the control. Gallery images are the full-size originals without `srcset` until the media phase; missing dimensions fall back to 800x1000 to reserve space.
- **The browser gets no prices:** variant prices are formatted on the server; the client variants carry no `price` field.
- **A takedown or price change is not instant:** `is_active = false` keeps the cached page (up to an hour) and there is no purge path yet (`revalidateTag` is only defined, not called). The trusted invalidation endpoint must exist before any admin mutation ships (owner item Q23). Checkout re-reads price and stock from the database (phase 2), so a stale page can never charge a stale price.

## Phase 1: home showcases and favicon (2026-11-23)

- **Bestsellers are the products marked `bestseller` (badge) by the shop;** there is no sales ranking yet (orders exist only from phase 2). Both lists show the newest published first, eight items, and a section with no products is not rendered.
- **The home page tolerates a failing showcase** (it is rendered per request and never cached): the section is skipped and one JSON line with the error name and code goes to stderr (`scope: showcase`), next to the `navigation` line. Included in the alert recommendation of Q21.
- **Favicon** is a neutral placeholder monogram (`app/icon.svg`), a branding item for Q1.
