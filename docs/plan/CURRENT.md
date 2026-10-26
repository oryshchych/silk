# CURRENT.md — стан роботи

> Пам'ять між сесіями. Стан живе тут і в git, а не в контексті.
> **Агент оновлює цей файл останньою дією кожної сесії.**

## Поточна фаза

`phase-00-foundation.md`, кроки 2–4 з 7: PR #3 (БД-клієнт + seed) → #4
(Money + DTO) → #5 (apps/web), кожен поверх попереднього. Далі: 5 AI-сетап,
6 деплой (Hetzner CX немає в наявності), 7 бекапи.

## Зроблено

- `6728094`…`3d48a11` монорепо, тулінг, env, compose, образ PG 18, CI
- PR #1 `fcb0655` міграції 0000–0005, Testcontainers + `migrate:fresh`
- PR #2 відповіді бухгалтера: ПРРО (Checkbox), сертифікати — лише шви
- `260ca10` порожні значення `.env` = не задано (`cp .env.example .env` працює)
- `baae4fe` `createDb()` + тип `Tx`; `80e6681` seed; `f66d6e1` БД з шаблону
- `e27e7d6` `Money`; `dde151f` лінт `money/no-arithmetic`; `2c65559` DTO
- `ac09b60` apps/web: Next 16.3.8, next-intl, Tailwind v4; `b18c417` CI build

## Наступний крок

Крок 5: AI-сетап (`.claude/` скіли, агенти, хуки; `ai:check`). Потім
`migrate:upgrade` / `migrate:safety`. Дотичне — `NOTES.md`.

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
- `next start`: `/` uk, `/en` en, `/uk`→307 `/`, без cookie; без
  EMAIL_TO_OVERRIDE процес завершується з кодом 1; grep blush|cream|pink — 0
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
- Tailwind v4: токени в CSS `@theme`, не в `tailwind.config.ts`
- `allocate` (largest remainder) у `shared/money`, не в `core/pricing`: це
  загальна функція; `core` додасть eligibility поверх неї (ADR-15)
- `allowBuilds`: esbuild, ssh2, cpu-features, protobufjs явно `false`;
  moderate у audit — esbuild 0.18 усередині drizzle-kit (dev-only), лишено
