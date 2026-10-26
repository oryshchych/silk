# CURRENT.md — стан роботи

> Пам'ять між сесіями. Стан живе тут і в git, а не в контексті.
> **Агент оновлює цей файл останньою дією кожної сесії.**

## Поточна фаза

`phase-00-foundation.md`, кроки 2–5 з 7 у `main` (`5bb9d28`, PR #3 і #6;
#4 і #5 потрапили через #6). Далі: 6 деплой — сервер Hetzner CAX11
(ARM, 4 ГБ, Ubuntu 24.04) створено, чекаємо IP, домен, SSH; 7 бекапи.

## Зроблено

- `6728094`…`3d48a11` монорепо, тулінг, env, compose, образ PG 18, CI
- PR #1 міграції + Testcontainers; PR #2 відповіді бухгалтера (ПРРО, шви)
- `260ca10` порожні значення `.env` = не задано (`cp .env.example .env` працює)
- `baae4fe` `createDb()` + тип `Tx`; `80e6681` seed; `f66d6e1` БД з шаблону
- `e27e7d6` `Money`; `dde151f` лінт `money/no-arithmetic`; `2c65559` DTO
- `ac09b60` apps/web: next-intl, Tailwind v4; `52a5e0b` Next **16.4.3** (critical CVE)
- `7f3b456` ai/ → AGENTS/CLAUDE/Copilot/Cursor + `ai:check`; `2c13e65` скіли, агенти

## Наступний крок

Хуки + `.claude/settings.json` вмикає власник (агенту заборонено).
Далі `migrate:upgrade` / `migrate:safety`, крок 6. Див. `NOTES.md`.

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
  EMAIL_TO_OVERRIDE — exit 1; grep blush|cream|pink — 0; `ai:check` зелений
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
- touch_updated_at і FK `orders.current_payment_attempt_id` — з блоку SQL schema.ts
- Next 16.4.3, не 16.3: у ≤ 16.4.0 критичні RCE, патча для 16.3 немає
- Tailwind v4: токени в CSS `@theme`, не в `tailwind.config.ts`
- `allocate` (largest remainder) у `shared/money`, не в `core/pricing`: це
  загальна функція; `core` додасть eligibility поверх неї (ADR-15)
- `allowBuilds`: заборонені postinstall перелічені явно; audit high — 0
