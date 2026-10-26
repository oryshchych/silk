/**
 * Лише типи — без рантайм-залежності від пулу. Звідси `packages/core` бере
 * `Tx`, не маючи доступу до `createDb` (AGENTS.md §4b.1).
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type * as schema from './schema.ts';

type Db = NodePgDatabase<typeof schema>;

/** Транзакція. Обов'язковий перший параметр кожної доменної мутації. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
