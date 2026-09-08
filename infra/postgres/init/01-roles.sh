#!/bin/bash
# Створює РОЗДІЛЕНІ ролі. web і worker не ходять суперкористувачем:
# інакше компрометація web дає можливість знищити схему.
#
#   store_migrate — DDL. Використовується тільки CI/деплоєм і drizzle-kit.
#   store_app     — DML на таблицях, БЕЗ DDL і без DROP. Це web і worker.
#   store_boss    — обмежений схемою pgboss.
#
# Виконується офіційним entrypoint лише при ІНІЦІАЛІЗАЦІЇ порожнього volume.
# На наявній БД зміни ролей робляться міграцією, не цим файлом.
#
# ВАЖЛИВО: default privileges видані ДЛЯ РОЛІ store_migrate, тому міграції
# мусять іти саме нею. Таблиця, створена суперкористувачем, для store_app
# буде недоступна — перевірено: 'permission denied for table'.
set -euo pipefail

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_MIGRATE_USER:?POSTGRES_MIGRATE_USER is required}"
: "${POSTGRES_MIGRATE_PASSWORD:?POSTGRES_MIGRATE_PASSWORD is required}"
: "${POSTGRES_APP_USER:?POSTGRES_APP_USER is required}"
: "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD is required}"
: "${POSTGRES_BOSS_USER:?POSTGRES_BOSS_USER is required}"
: "${POSTGRES_BOSS_PASSWORD:?POSTGRES_BOSS_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
-- Роль-власник схеми: єдина, якій дозволений DDL.
CREATE ROLE ${POSTGRES_MIGRATE_USER} LOGIN PASSWORD '${POSTGRES_MIGRATE_PASSWORD}';
CREATE ROLE ${POSTGRES_APP_USER}     LOGIN PASSWORD '${POSTGRES_APP_PASSWORD}';
CREATE ROLE ${POSTGRES_BOSS_USER}    LOGIN PASSWORD '${POSTGRES_BOSS_PASSWORD}';

GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${POSTGRES_MIGRATE_USER};
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${POSTGRES_APP_USER};
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${POSTGRES_BOSS_USER};

-- Схему public віддаємо міграційній ролі; застосунок у ній нічого не створює.
ALTER SCHEMA public OWNER TO ${POSTGRES_MIGRATE_USER};
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ${POSTGRES_APP_USER};

-- Черги живуть в окремій схемі, власник — роль воркера.
CREATE SCHEMA pgboss AUTHORIZATION ${POSTGRES_BOSS_USER};

-- Права на МАЙБУТНІ таблиці: інакше після кожної міграції треба було б
-- згадати про GRANT, і одного разу про нього не згадають.
ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_MIGRATE_USER} IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_APP_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_MIGRATE_USER} IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ${POSTGRES_APP_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_MIGRATE_USER} IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO ${POSTGRES_APP_USER};
SQL

echo "roles: ${POSTGRES_MIGRATE_USER} (DDL), ${POSTGRES_APP_USER} (DML), ${POSTGRES_BOSS_USER} (pgboss)"
