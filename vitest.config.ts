import { configDefaults, defineConfig } from 'vitest/config';

// Agent sessions work in git worktrees under `.claude/worktrees/`, inside this
// repository. Without this exclude the main checkout would also run the
// worktrees' tests (a doubled run, plus half-finished tests of another session).
const exclude = [...configDefaults.exclude, '**/.claude/worktrees/**'];

export default defineConfig({
  test: {
    // Projects, not one config: the test levels have different runners.
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['**/*.unit.test.ts'],
          exclude,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['**/*.int.test.ts'],
          exclude,
          // Transactions and locks do not run in parallel through one pool.
          testTimeout: 30_000,
          // Testcontainers with OUR Postgres image (hunspell + ICU) that runs
          // every migration on an empty database, i.e. migrate:fresh.
          globalSetup: './packages/db/test/pg-container.ts',
          // Image build on the first run plus container start.
          hookTimeout: 600_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      // Per-package thresholds, not one global number: a total across the
      // monorepo means nothing.
      thresholds: {
        'packages/core/src/pricing/**': { lines: 95, branches: 90 },
        'packages/core/src/inventory/**': { lines: 95, branches: 90 },
        'packages/payments/**': { lines: 90, branches: 85 },
        global: { lines: 60 },
      },
    },
  },
});
