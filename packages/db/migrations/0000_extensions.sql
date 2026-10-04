-- Розширення — ОКРЕМОЮ РАННЬОЮ МІГРАЦІЄЮ, до будь-яких залежних об'єктів.
--
-- Написано вручну. drizzle-kit `CREATE EXTENSION` не генерує й порядку не
-- знає, а 0001_schema містить три індекси з gin_trgm_ops (np_settlements,
-- np_warehouses, products) — без pg_trgm вона падає на порожній БД.
-- Перевірено: `grep -ci 'create extension' 0001_schema.sql` → 0.
--
-- Усі чотири розширення — trusted (PG 13+): їх ставить роль із CREATE на
-- базі, суперкористувач не потрібен. store_migrate отримує це право в
-- infra/postgres/init/01-roles.sh.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gin;--> statement-breakpoint
-- Access-токени замовлень.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
