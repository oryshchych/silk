/**
 * Окрема БД на тестовий файл: `CREATE DATABASE ... TEMPLATE store_template`.
 * Повна ізоляція без транзакційних трюків, які ламають тестування самих
 * транзакцій (DEVELOPMENT.md §5).
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { inject } from 'vitest';

export interface TestDatabase {
  /** store_app — як web і worker. */
  appUrl: string;
  /** store_migrate — для службових дій (setval, DDL). */
  migrateUrl: string;
  drop: () => Promise<void>;
}

const withDatabase = (url: string, name: string): string => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  const rootUrl = inject('pgRootUrl');
  const root = new pg.Client({ connectionString: rootUrl });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE ${name} TEMPLATE ${inject('pgTemplateDb')}`);
  } finally {
    await root.end();
  }

  return {
    appUrl: withDatabase(inject('pgAppUrl'), name),
    migrateUrl: withDatabase(inject('pgMigrateUrl'), name),
    drop: async () => {
      const admin = new pg.Client({ connectionString: rootUrl });
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    },
  };
}
