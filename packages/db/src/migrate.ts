import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Каталог із SQL-міграціями та журналом drizzle-kit. */
export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Застосовує всі незастосовані міграції, включно з ручними (0000, 0002+).
 *
 * Підключення — роллю store_migrate: default privileges для store_app
 * видані саме їй. Таблиця, створена іншою роллю, буде застосунку недоступна.
 *
 * drizzle-orm проганяє всі незастосовані міграції в ОДНІЙ транзакції:
 * падіння будь-якої відкочує весь прогін, а не лишає схему наполовину.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
  } finally {
    await client.end();
  }
}

/**
 * CLI: `pnpm db:migrate`. Запускається Node напряму (type stripping),
 * тому файл без відносних імпортів.
 */
if (import.meta.main) {
  // eslint-disable-next-line no-restricted-properties -- креденшели store_migrate НЕ входять у env застосунку: web і worker їх не отримують
  const url = process.env['DATABASE_MIGRATE_URL'];
  if (url === undefined || url === '') {
    throw new Error('DATABASE_MIGRATE_URL не задано (роль store_migrate, не store_app)');
  }
  await runMigrations(url);
}
