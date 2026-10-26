---
name: new-migration
description: Будь-яка зміна схеми БД (packages/db). Генерує міграцію drizzle-kit або ручну, проганяє на порожній БД у Testcontainers, перевіряє порядок extensions і небезпечний DDL, показує diff і чекає підтвердження. Використовувати замість ручного редагування міграцій.
---

# new-migration

Міграція — найнебезпечніша операція в проєкті. Закомічена міграція **не
змінюється ніколи** — лише нова (CLAUDE.md, хук `block-applied-migration`).

## Кроки

1. **Прочитай** `packages/db/src/schema.ts` і `docs/architecture/04-data-model.md`
   у частині, яку змінюєш. Якщо зміна видаляє/змінює наявну колонку чи
   обмеження або не описана в `ARCHITECTURE.md` — **зупинись і спитай**
   (AGENTS.md §5).

2. **Згенеруй**:
   - зміна в `schema.ts` → `pnpm db:generate` (у `packages/db`: `drizzle-kit generate --name=<що>`);
   - те, чого Drizzle не виражає (тригер, складений FK, sequence, `GENERATED ... STORED`,
     розширення) → `pnpm --filter @store/db exec drizzle-kit generate --custom --name=<що>`
     і напиши SQL у створений файл.
     `drizzle-kit push` — заборонено.

3. **Перевір SQL очима** на відомі пастки:
   - `gin_trgm_ops`, `unaccent`, `gen_random_uuid` → розширення вже є в `0000_extensions`? Нове
     розширення — окремою ранньою міграцією, до залежних об'єктів;
   - generated column — лише IMMUTABLE-вирази й **явний `STORED`** (у PG 18 дефолт VIRTUAL,
     не індексується);
   - column-specific тригер + backfill — `SET <колонка тригера> = <колонка>`, не `updated_at`;
   - `ON DELETE` для фінансово значущих таблиць — `RESTRICT`;
   - блокуючий DDL на великій таблиці (`ALTER TABLE ... ADD COLUMN ... DEFAULT` з volatile,
     `CREATE INDEX` без `CONCURRENTLY`, зміна типу) — розбити на кроки.
     Коли з'явиться `migrate:safety` — прожени squawk.

4. **Прожени на порожній БД**: `pnpm migrate:fresh` (Testcontainers, наш образ, роль
   `store_migrate`). Нова поведінка (тригер, FK, sequence) — **тест у
   `packages/db/test/migrate-fresh.int.test.ts`**, що перевіряє, що вона ПРАЦЮЄ, а не
   лише виконалась. Негативний контроль: тимчасово зламай міграцію — тест мусить впасти.

5. `pnpm db:check` — чистий.

6. **Субагент `migration-reviewer`** на нову міграцію.

7. **Покажи людині** diff міграції й результат прогонів. Не комітити без підтвердження.
