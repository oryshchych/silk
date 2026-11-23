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
  /** The pool behind `db`, for raw SQL in scripts (smoke checks) that cannot use the query builder. */
  pool: pg.Pool;
}

export interface CreateDbOptions {
  /** Максимум з'єднань у пулі. */
  max?: number;
  /** Per-statement timeout in milliseconds (default 30 s): a hung query must not hold a connection forever. */
  statementTimeoutMs?: number;
}

export function createDb(connectionString: string, options: CreateDbOptions = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    // Without these a dead database hangs every request instead of failing fast.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
  });
  // The server can terminate an idle connection (restart, failover, admin
  // action: 57P01). The pool emits `error` for it, and without a listener Node
  // treats that as an uncaught exception and the whole process dies. One log
  // line, no query text; the pool drops the client and opens a new one.
  pool.on('error', (error: Error & { code?: string }) => {
    const reason = `${error.name}${error.code === undefined ? '' : ` ${error.code}`}`;
    process.stderr.write(`${JSON.stringify({ level: 'error', scope: 'db-pool', reason })}\n`);
  });
  const db = drizzle({ client: pool, schema });
  return { db, close: () => pool.end(), pool };
}
