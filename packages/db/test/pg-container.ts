/**
 * globalSetup інтеграційного проєкту Vitest.
 *
 * Піднімає НАШ образ Postgres (infra/postgres: hunspell + ICU uk-UA +
 * розділені ролі), а не офіційний: на офіційному не проходить 0003_search,
 * і тести не перевіряли б ні тригер search_vector, ні українське сортування.
 *
 * Міграції застосовуються тут, роллю store_migrate, на ПОРОЖНЮ БД. Якщо
 * будь-яка з них падає — падає весь прогін. Це і є перевірка migrate:fresh.
 *
 * Далі змігрована БД копіюється в `store_template`; тести, яким потрібна
 * власна БД, створюють її з шаблону (`test/db.ts`) — на порядок швидше за
 * прогін міграцій і без транзакційних трюків (DEVELOPMENT.md §5).
 */
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { GenericContainer } from 'testcontainers';
import type { TestProject } from 'vitest/node';

import { runMigrations } from '../src/migrate.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Суперкористувач: лише для службових перевірок у тестах. */
    pgRootUrl: string;
    /** store_migrate — DDL. */
    pgMigrateUrl: string;
    /** store_app — DML, як web і worker. */
    pgAppUrl: string;
    /** Шаблон для `CREATE DATABASE ... TEMPLATE`. */
    pgTemplateDb: string;
  }
}

const IMAGE = 'store-postgres:test';
const DB = 'store';
const TEMPLATE_DB = 'store_template';
const PASSWORD = 'test';
const context = fileURLToPath(new URL('../../../infra/postgres', import.meta.url));

function urlFor(c: StartedPostgreSqlContainer, user: string): string {
  return `postgres://${user}:${PASSWORD}@${c.getHost()}:${String(c.getPort())}/${DB}`;
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // Шари кешуються Docker'ом: повторна збірка — секунди.
  await GenericContainer.fromDockerfile(context).build(IMAGE, { deleteOnExit: false });

  const container = await new PostgreSqlContainer(IMAGE)
    .withDatabase(DB)
    .withUsername('store_root')
    .withPassword(PASSWORD)
    .withEnvironment({
      POSTGRES_MIGRATE_USER: 'store_migrate',
      POSTGRES_MIGRATE_PASSWORD: PASSWORD,
      POSTGRES_APP_USER: 'store_app',
      POSTGRES_APP_PASSWORD: PASSWORD,
      POSTGRES_BOSS_USER: 'store_boss',
      POSTGRES_BOSS_PASSWORD: PASSWORD,
      // Як у docker-compose: ICU, інакше українського сортування немає.
      POSTGRES_INITDB_ARGS: '--locale-provider=icu --icu-locale=uk-UA --encoding=UTF8',
    })
    .start();

  const migrateUrl = urlFor(container, 'store_migrate');
  await runMigrations(migrateUrl);

  // Шаблон знімається, поки до `store` ніхто не підключений.
  const root = new pg.Client({ connectionString: urlFor(container, 'store_root') });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE ${TEMPLATE_DB} TEMPLATE ${DB}`);
  } finally {
    await root.end();
  }

  project.provide('pgRootUrl', urlFor(container, 'store_root'));
  project.provide('pgMigrateUrl', migrateUrl);
  project.provide('pgAppUrl', urlFor(container, 'store_app'));
  project.provide('pgTemplateDb', TEMPLATE_DB);

  return async () => {
    await container.stop();
  };
}
