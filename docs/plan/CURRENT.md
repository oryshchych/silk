# CURRENT.md — стан роботи

> Пам'ять між сесіями. Стан живе тут і в git, а не в контексті.
> **Агент оновлює цей файл останньою дією кожної сесії.**

## Поточна фаза

`phase-00-foundation.md`, крок 2 з 7 зроблено (клієнт БД + seed), PR
`feat/db-client-seed`. Далі: 3 Money/DTO, 4 apps/web, 5 AI-сетап, 6 деплой
(сервер Hetzner CX — немає в наявності), 7 бекапи.

## Зроблено

- `6728094`…`3d48a11` монорепо, тулінг, env, lefthook, compose, образ PG 18, CI
- `5340064`…`e2e49df` drizzle-kit, міграції 0000–0005, `src/migrate.ts`
  (store_migrate), Testcontainers + `migrate:fresh` (PR #1, `fcb0655`)
- `3d40dc6`, `8d2b189` audit high: brace-expansion, fast-uri, source-map-js, vite, zod ^4.6.7, undici
- `0598006` відповіді бухгалтера: ПРРО (Checkbox), сертифікати — лише шви
- `260ca10` порожні значення `.env` = не задано (`cp .env.example .env` працює)
- `baae4fe` `createDb()` + тип `Tx`; `80e6681` seed; `f66d6e1` БД з шаблону

## Наступний крок

Крок 3: тип `Money` (branded, копійки) і DTO-шар у `packages/shared`.
Потім `migrate:upgrade` / `migrate:safety`. Дотичне — `NOTES.md`.

## Критерії, перевірені виконанням

- `pnpm migrate:fresh`: порожня БД нашого образу + 6 міграцій роллю
  store_migrate, 17/17 тестів (тригер search_vector, backfill, STORED,
  нумерація на межах, складені FK, права store_app, сортування `г ґ е є и і ї`)
- негативні контролі: без 0000 → `operator class "gin_trgm_ops" does not
  exist`; без `STORED` → `indexes on virtual generated columns are not supported`;
  без `GRANT CREATE` → `permission denied to create extension`
- `0001_schema.sql` побайтово = `docs/reference-migration-dryrun.sql`
- `pnpm db:check` чистий; CI PR #1 — усі 10 джобів зелені, `migrate-fresh` теж
- `pnpm db:seed` на локальній БД: 40 товарів, 15 замовлень; звірки резервів
  і сум — 0 розбіжностей; повтор і production відмовляють. `test:int` 30/30
- раніше: verify на чистому клоні, lint-заборони, env, образ БД, gitleaks

## Відкриті рішення, що чекають людину

- API НП 2.0; назва магазину (`LACE & SILK`); акаунт Checkbox
- COD: друк паперового чека в коробку при комплектації (NOTES.md)
- Чек повернення → лише на чек `sale`: FK цього не виражає (NOTES.md)

## Відхилення від плану

- TS 6.0.3; Postgres на Debian; том на `/var/lib/postgresql`; init-скрипти
  в образі; `typescript-eslint` 8.69.0 (див. git log сесії 1)
- 0000 через `generate --custom` до схеми; міграції — `drizzle-orm` migrator
- store_migrate отримав `CREATE ON DATABASE` (раніше лише CONNECT)
- touch_updated_at і FK `orders.current_payment_attempt_id` теж із блоку SQL
  schema.ts — не названі в задачі явно, але це той самий блок
- `allowBuilds`: esbuild, ssh2, cpu-features, protobufjs явно `false`;
  moderate у audit — esbuild 0.18 усередині drizzle-kit (dev-only), лишено
