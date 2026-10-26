/**
 * Клієнт БД. Фабрика, а не глобальний синглтон: застосунок, воркер і тести
 * створюють свій пул явно й самі його закривають.
 *
 * Доменні мутації приймають `Tx` ОБОВ'ЯЗКОВИМ першим параметром
 * (AGENTS.md §4b.1). Тип `Db` туди не передається: інакше всередині
 * зовнішньої транзакції частина змін закомітилась би окремо від відкату.
 * `packages/core` цей модуль не імпортує взагалі (лінт-правило) — лише тип
 * `Tx` через `@store/db/types`.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema>;
export type { Tx } from './types.ts';

export interface DbHandle {
  db: Db;
  /** Закриває пул. Без цього процес CLI не завершиться. */
  close: () => Promise<void>;
}

export interface CreateDbOptions {
  /** Максимум з'єднань у пулі. */
  max?: number;
}

export function createDb(connectionString: string, options: CreateDbOptions = {}): DbHandle {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  const db = drizzle({ client: pool, schema });
  return { db, close: () => pool.end() };
}
