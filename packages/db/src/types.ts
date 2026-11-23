/**
 * Лише типи — без рантайм-залежності від пулу. Звідси `packages/core` бере
 * `Tx`, не маючи доступу до `createDb` (AGENTS.md §4b.1).
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type * as schema from './schema.ts';

type Db = NodePgDatabase<typeof schema>;

/**
 * Read-only handle: a pool-backed `Db` or a `Tx`. Public catalog queries take
 * this, so the storefront reads without opening a transaction. Mutations never
 * use it (they take `Tx`).
 */
export type Reader = Pick<Db, 'select' | 'execute'>;

/** Транзакція. Обов'язковий перший параметр кожної доменної мутації. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
