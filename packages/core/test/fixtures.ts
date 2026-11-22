import { seedMoneySkeleton, type MoneySkeletonFixture } from '@store/db/seed/money-skeleton';
import { createDb, type DbHandle } from '@store/db/client';
import { createTestDatabase, type TestDatabase } from '@store/db/test/db';

export interface TestWorld {
  testDb: TestDatabase;
  /** Independent pools: each one is a separate set of connections. */
  connect: (max?: number) => DbHandle;
  fixture: MoneySkeletonFixture;
  close: () => Promise<void>;
}

/**
 * Fresh database from the migrated template + the money skeleton catalog.
 * `connect()` hands out separate pools: a concurrency test must NOT share one
 * pool between its "parallel" parties, or the queries run one after another.
 */
export async function createWorld(): Promise<TestWorld> {
  const testDb = await createTestDatabase();
  const handles: DbHandle[] = [];
  const connect = (max = 1): DbHandle => {
    const handle = createDb(testDb.appUrl, { max });
    handles.push(handle);
    return handle;
  };
  const setup = connect(2);
  const fixture = await setup.db.transaction(async (tx) => await seedMoneySkeleton(tx));
  return {
    testDb,
    connect,
    fixture,
    close: async () => {
      await Promise.all(
        handles.map(async (handle) => {
          await handle.close();
        }),
      );
      await testDb.drop();
    },
  };
}
