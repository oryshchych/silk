# CURRENT.md — стан роботи

> Пам'ять між сесіями. Стан живе тут і в git, а не в контексті.
> **Агент оновлює цей файл останньою дією кожної сесії.**

## Поточна фаза

`phase-00-foundation.md` — інфраструктура й міграції зроблені; клієнт БД,
seed, застосунки, AI-сетап і деплой не розпочаті. PR #1
`feat/db-migrations` → `main`, CI зелений, чекає мерджу.

## Зроблено

- `6728094`…`3d48a11` монорепо, тулінг, env, lefthook, compose, образ PG 18, CI
- `5340064` drizzle-kit 0.31.11, `src/migrate.ts` (роль store_migrate,
  `DATABASE_MIGRATE_URL`), lint/format/knip охоплюють `packages/db`
- `37c32e9` міграції 0000–0005: extensions (вручну), schema (згенерована),
  numbering, search, integrity (складені FK), touch_updated_at;
  `GRANT CREATE ON DATABASE` для store_migrate в init-скрипті
- `e2e49df` Testcontainers globalSetup + `migrate:fresh` (17 тестів), CI-джоб
- `3d40dc6` lockfile: brace-expansion 5.0.12 (2 high), fast-uri 3.1.8

## Наступний крок

Клієнт БД (`@store/db/client`, tx першим параметром), seed-генератор,
`pnpm db:seed`; далі `migrate:upgrade` / `migrate:safety`, ізоляція тестів
через `TEMPLATE`. Дотичне — `NOTES.md`.

## Критерії, перевірені виконанням

- `pnpm migrate:fresh`: порожня БД нашого образу + 6 міграцій роллю
  store_migrate, 17/17 тестів (тригер search_vector, backfill, STORED,
  нумерація на межах, складені FK, права store_app, сортування `г ґ е є и і ї`)
- негативні контролі: без 0000 → `operator class "gin_trgm_ops" does not
  exist`; без `STORED` → `indexes on virtual generated columns are not supported`;
  без `GRANT CREATE` → `permission denied to create extension`
- `0001_schema.sql` побайтово = `docs/reference-migration-dryrun.sql`
- `pnpm db:check` чистий; CI PR #1 — усі 10 джобів зелені, `migrate-fresh` теж
- раніше: verify на чистому клоні, lint-заборони, env, образ БД, gitleaks

## Відкриті рішення, що чекають людину

- Бухгалтер (сертифікати, ПРРО); API НП 2.0; назва магазину (`LACE & SILK`)
- Наявний локальний volume `pgdata_local` створений без `GRANT CREATE` —
  `db:migrate` на ньому впаде. Перестворити volume або видати право вручну
- Чек повернення → лише на чек `sale`: FK цього не виражає (NOTES.md)

## Відхилення від плану

- TS 6.0.3; Postgres на Debian; том на `/var/lib/postgresql`; init-скрипти
  в образі; `typescript-eslint` 8.69.0 (див. git log сесії 1)
- 0000 створено `drizzle-kit generate --custom` ДО генерації схеми, а не
  перейменуванням: журнал і снапшоти узгоджені без ручних правок
- міграції застосовує `drizzle-orm` migrator (`src/migrate.ts`), не
  `drizzle-kit migrate`: той самий код у CLI і Testcontainers
- store_migrate отримав `CREATE ON DATABASE` (раніше лише CONNECT)
- touch_updated_at і FK `orders.current_payment_attempt_id` теж із блоку SQL
  schema.ts — не названі в задачі явно, але це той самий блок
- `allowBuilds`: esbuild, ssh2, cpu-features, protobufjs явно `false`;
  moderate у audit — esbuild 0.18 усередині drizzle-kit (dev-only), лишено
